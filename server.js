// fokus HQ — internal dashboard API + static UI
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const { DatabaseSync } = require('node:sqlite'), crypto = require('crypto'), path = require('path');

const PORT = process.env.PORT || 3000, PROD = process.env.NODE_ENV === 'production';
const VAULT_KEY = Buffer.from(process.env.VAULT_KEY || '', 'hex');
if (VAULT_KEY.length !== 32) { console.error('VAULT_KEY missing: run  openssl rand -hex 32  and put it in .env'); process.exit(1); }

// ---------- database ----------
const db = new DatabaseSync(process.env.DB_PATH || 'fokus.db');
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
create table if not exists users(id integer primary key, name text not null, email text unique not null, role text not null check(role in('owner','admin','member')),
  pw_hash text not null, must_change integer default 1, failed integer default 0, locked_until integer default 0, created_at integer);
create table if not exists companies(id integer primary key, slug text unique, name text, color text);
create table if not exists projects(id integer primary key, company_id integer not null references companies(id), name text not null, description text default '',
  status text default 'active' check(status in('planned','active','paused','done')), owner_id integer references users(id), due text default '', created_at integer);
create table if not exists tasks(id integer primary key, project_id integer not null references projects(id) on delete cascade, title text not null, description text default '',
  status text default 'todo' check(status in('todo','doing','review','done')), priority text default 'medium' check(priority in('low','medium','high')),
  assignee_id integer references users(id), due text default '', created_at integer, updated_at integer);
create table if not exists sessions(id integer primary key, token_hash text unique, user_id integer not null references users(id) on delete cascade, csrf text, ip text, ua text,
  remember integer, created_at integer, last_seen integer, expires integer, idle_ms integer, revoked integer default 0);
create table if not exists vault(id integer primary key, label text not null, company_id integer references companies(id), url text default '', username text default '',
  secret_enc text not null, created_by integer references users(id), created_at integer);
create table if not exists notifications(id integer primary key, user_id integer not null references users(id) on delete cascade, text text, link text, read integer default 0, created_at integer);
create table if not exists audit(id integer primary key, user_id integer, action text, detail text, ip text, created_at integer);
create index if not exists idx_tasks_project on tasks(project_id); create index if not exists idx_notif_user on notifications(user_id, read);
`);

// ---------- crypto helpers ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = p => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(p, s, 64).toString('hex'); };
const checkPw = (p, st) => { const [s, h] = st.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(p, Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex')); };
const DUMMY = hashPw('dummy-password');
const enc = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv); const ct = Buffer.concat([c.update(t, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'); };
const dec = b => { const x = Buffer.from(b, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, x.subarray(0, 12)); d.setAuthTag(x.subarray(12, 28)); return Buffer.concat([d.update(x.subarray(28)), d.final()]).toString('utf8'); };

// ---------- first-run seed ----------
if (!db.prepare('select 1 from companies').get()) {
  const ins = db.prepare('insert into companies(slug,name,color) values(?,?,?)');
  [['agency', 'Agency', '#E4572E'], ['automation', 'Automation', '#12A594'], ['campus', 'Campus Marketplace', '#E8A200']].forEach(c => ins.run(...c));
}
if (!db.prepare('select 1 from users').get()) {
  const mk = db.prepare('insert into users(name,email,role,pw_hash,must_change,created_at) values(?,?,?,?,1,?)');
  console.log('\n=== First run: temporary passwords (shown once, must be changed at first login) ===');
  [['OWNER', 'owner'], ['CTO', 'admin'], ['COO', 'admin']].forEach(([k, role]) => {
    const email = (process.env[k + '_EMAIL'] || `${k.toLowerCase()}@fokus.local`).toLowerCase(), pw = crypto.randomBytes(9).toString('base64url');
    mk.run(process.env[k + '_NAME'] || k, email, role, hashPw(pw), Date.now()); console.log(`${k.padEnd(6)} ${email}  ${pw}`);
  });
  console.log('====================================================================================\n');
}

// ---------- app ----------
const app = express();
app.set('trust proxy', PROD ? 1 : false);
app.disable('x-powered-by');
app.use(helmet({ hsts: PROD, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: PROD ? [] : null } } }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

const ip = req => req.ip || '';
const audit = (req, action, detail = '') => db.prepare('insert into audit(user_id,action,detail,ip,created_at) values(?,?,?,?,?)').run(req.user?.id ?? null, action, detail, ip(req), Date.now());
const notify = (userIds, text, link = '', except) => { const s = db.prepare('insert into notifications(user_id,text,link,created_at) values(?,?,?,?)'); [...new Set(userIds)].filter(i => i && i !== except).forEach(i => s.run(i, text, link, Date.now())); };
const allUsers = () => db.prepare('select id from users').all().map(u => u.id);
const str = (v, max = 300) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const oneOf = (v, list, d) => list.includes(v) ? v : d;
const date = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '';
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------- auth ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again in a few minutes.' } });
const cookie = (tok, maxAge) => `fk_sid=${tok}; HttpOnly; SameSite=Strict; Path=/${PROD ? '; Secure' : ''}${maxAge != null ? `; Max-Age=${maxAge}` : ''}`;

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const email = str(req.body?.email, 200).toLowerCase(), password = str(req.body?.password, 200), remember = !!req.body?.remember;
  const u = db.prepare('select * from users where email=?').get(email), now = Date.now();
  if (u && u.locked_until > now) return bad(res, 'Account locked for a few minutes after too many failed attempts.', 423);
  let ok = false; try { ok = checkPw(password, u ? u.pw_hash : DUMMY) && !!u; } catch { ok = false; }
  if (!ok) {
    if (u) { const f = u.failed + 1; db.prepare('update users set failed=?, locked_until=? where id=?').run(f >= 5 ? 0 : f, f >= 5 ? now + 15 * 60_000 : 0, u.id); db.prepare('insert into audit(user_id,action,detail,ip,created_at) values(?,?,?,?,?)').run(u.id, 'login.failed', '', ip(req), now); }
    return bad(res, 'Wrong email or password.', 401);
  }
  db.prepare('update users set failed=0, locked_until=0 where id=?').run(u.id);
  const tok = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  const life = remember ? 30 * 86400_000 : 12 * 3600_000, idle = remember ? 30 * 86400_000 : 2 * 3600_000;
  db.prepare('insert into sessions(token_hash,user_id,csrf,ip,ua,remember,created_at,last_seen,expires,idle_ms) values(?,?,?,?,?,?,?,?,?,?)')
    .run(sha(tok), u.id, csrf, ip(req), str(req.get('user-agent'), 250), remember ? 1 : 0, now, now, now + life, idle);
  res.setHeader('Set-Cookie', cookie(tok, remember ? 30 * 86400 : null));
  req.user = u; audit(req, 'login');
  res.json({ csrf, user: { id: u.id, name: u.name, email: u.email, role: u.role, must_change: u.must_change } });
});

function auth(req, res, next) {
  const m = /(?:^|;\s*)fk_sid=([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (!m) return bad(res, 'Not signed in.', 401);
  const s = db.prepare('select * from sessions where token_hash=? and revoked=0').get(sha(m[1])), now = Date.now();
  if (!s || s.expires < now || now - s.last_seen > s.idle_ms) return bad(res, 'Session expired.', 401);
  const u = db.prepare('select id,name,email,role,must_change from users where id=?').get(s.user_id); if (!u) return bad(res, 'Not signed in.', 401);
  if (!['GET', 'HEAD'].includes(req.method) && req.get('x-csrf-token') !== s.csrf) return bad(res, 'Invalid CSRF token.', 403);
  if (u.must_change && !req.path.startsWith('/auth')) return res.status(403).json({ error: 'Change your temporary password first.', code: 'MUST_CHANGE' });
  db.prepare('update sessions set last_seen=? where id=?').run(now, s.id);
  req.user = u; req.sess = s; next();
}
const admin = (req, res, next) => ['owner', 'admin'].includes(req.user.role) ? next() : bad(res, 'Admins only.', 403);
const owner = (req, res, next) => req.user.role === 'owner' ? next() : bad(res, 'Owner only.', 403);
app.use('/api', auth);

app.get('/api/auth/me', (req, res) => res.json({ user: req.user, csrf: req.sess.csrf }));
app.post('/api/auth/logout', (req, res) => { db.prepare('update sessions set revoked=1 where id=?').run(req.sess.id); audit(req, 'logout'); res.setHeader('Set-Cookie', cookie('', 0)); res.json({ ok: true }); });
app.post('/api/auth/password', (req, res) => {
  const cur = str(req.body?.current, 200), next = str(req.body?.next, 200);
  if (next.length < 12) return bad(res, 'Use at least 12 characters.');
  const row = db.prepare('select pw_hash from users where id=?').get(req.user.id);
  if (!checkPw(cur, row.pw_hash)) return bad(res, 'Current password is wrong.', 401);
  if (cur === next) return bad(res, 'Choose a different password.');
  db.prepare('update users set pw_hash=?, must_change=0 where id=?').run(hashPw(next), req.user.id);
  db.prepare('update sessions set revoked=1 where user_id=? and id!=?').run(req.user.id, req.sess.id); // sign out every other device
  audit(req, 'password.changed'); res.json({ ok: true });
});

// ---------- sessions (active + saved devices) ----------
app.get('/api/sessions', (req, res) => {
  const now = Date.now();
  res.json(db.prepare('select id,ip,ua,remember,created_at,last_seen,expires,idle_ms from sessions where user_id=? and revoked=0 and expires>?').all(req.user.id, now)
    .filter(s => now - s.last_seen <= s.idle_ms).map(s => ({ ...s, current: s.id === req.sess.id })));
});
app.delete('/api/sessions/:id', (req, res) => {
  const r = db.prepare('update sessions set revoked=1 where id=? and user_id=?').run(+req.params.id, req.user.id);
  if (!r.changes) return bad(res, 'Session not found.', 404); audit(req, 'session.revoked', req.params.id); res.json({ ok: true });
});

// ---------- team & company metadata ----------
app.get('/api/meta', (req, res) => res.json({ companies: db.prepare('select * from companies').all(), users: db.prepare('select id,name,email,role from users').all() }));
app.post('/api/users', owner, (req, res) => {
  const name = str(req.body?.name, 100), email = str(req.body?.email, 200).toLowerCase(), role = oneOf(req.body?.role, ['admin', 'member'], 'member');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Name and a valid email are required.');
  if (db.prepare('select 1 from users where email=?').get(email)) return bad(res, 'That email already exists.', 409);
  const pw = crypto.randomBytes(9).toString('base64url');
  const r = db.prepare('insert into users(name,email,role,pw_hash,must_change,created_at) values(?,?,?,?,1,?)').run(name, email, role, hashPw(pw), Date.now());
  audit(req, 'user.created', email); res.status(201).json({ id: Number(r.lastInsertRowid), temp_password: pw });
});

// ---------- overview ----------
app.get('/api/overview', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const companies = db.prepare('select * from companies').all().map(c => {
    const t = db.prepare(`select t.status, count(*) n, sum(t.status!='done' and t.due!='' and t.due<?) late from tasks t join projects p on p.id=t.project_id where p.company_id=? group by t.status`).all(today, c.id);
    const by = Object.fromEntries(t.map(x => [x.status, x.n]));
    return { ...c, projects: db.prepare(`select count(*) n from projects where company_id=? and status in('planned','active')`).get(c.id).n,
      todo: by.todo || 0, doing: by.doing || 0, review: by.review || 0, done: by.done || 0, overdue: t.reduce((a, x) => a + (x.late || 0), 0) };
  });
  const mine = db.prepare(`select t.id,t.title,t.status,t.priority,t.due,p.name project,p.company_id from tasks t join projects p on p.id=t.project_id where t.assignee_id=? and t.status!='done' order by (t.due='') , t.due limit 8`).all(req.user.id);
  const recent = db.prepare(`select a.action,a.detail,a.created_at,u.name from audit a left join users u on u.id=a.user_id where a.action not like 'login%' and a.action not like 'logout' order by a.id desc limit 8`).all();
  res.json({ companies, mine, recent });
});

// ---------- projects ----------
const projectSql = `select p.*, c.name company, u.name owner, (select count(*) from tasks t where t.project_id=p.id) tasks, (select count(*) from tasks t where t.project_id=p.id and t.status='done') done
  from projects p join companies c on c.id=p.company_id left join users u on u.id=p.owner_id`;
app.get('/api/projects', (req, res) => res.json(db.prepare(projectSql + " order by p.status='done', p.created_at desc").all()));
function projectFields(b, cur = {}) {
  return { company_id: +b.company_id || cur.company_id, name: str(b.name, 120) || cur.name, description: b.description !== undefined ? str(b.description, 1000) : cur.description ?? '',
    status: oneOf(b.status, ['planned', 'active', 'paused', 'done'], cur.status || 'active'), owner_id: b.owner_id !== undefined ? (+b.owner_id || null) : cur.owner_id ?? null, due: b.due !== undefined ? date(b.due) : cur.due || '' };
}
app.post('/api/projects', (req, res) => {
  const f = projectFields(req.body || {}); if (!f.name || !db.prepare('select 1 from companies where id=?').get(f.company_id)) return bad(res, 'Name and company are required.');
  const r = db.prepare('insert into projects(company_id,name,description,status,owner_id,due,created_at) values(@company_id,@name,@description,@status,@owner_id,@due,@t)').run({ ...f, owner_id: f.owner_id || req.user.id, t: Date.now() });
  audit(req, 'project.created', f.name); notify(allUsers(), `${req.user.name} created project "${f.name}"`, '#projects', req.user.id); res.status(201).json({ id: Number(r.lastInsertRowid) });
});
app.patch('/api/projects/:id', (req, res) => {
  const cur = db.prepare('select * from projects where id=?').get(+req.params.id); if (!cur) return bad(res, 'Project not found.', 404);
  const f = projectFields(req.body || {}, cur);
  db.prepare('update projects set company_id=@company_id,name=@name,description=@description,status=@status,owner_id=@owner_id,due=@due where id=@id').run({ ...f, id: cur.id });
  audit(req, 'project.updated', f.name); res.json({ ok: true });
});
app.delete('/api/projects/:id', owner, (req, res) => { const p = db.prepare('select name from projects where id=?').get(+req.params.id); if (!p) return bad(res, 'Project not found.', 404); db.prepare('delete from projects where id=?').run(+req.params.id); audit(req, 'project.deleted', p.name); res.json({ ok: true }); });

// ---------- tasks ----------
const taskSql = `select t.*, p.name project, p.company_id, u.name assignee from tasks t join projects p on p.id=t.project_id left join users u on u.id=t.assignee_id`;
app.get('/api/tasks', (req, res) => res.json(req.query.project ? db.prepare(taskSql + ' where t.project_id=? order by t.created_at desc').all(+req.query.project) : db.prepare(taskSql + ' order by t.created_at desc').all()));
function taskFields(b, cur = {}) {
  return { project_id: +b.project_id || cur.project_id, title: str(b.title, 160) || cur.title, description: b.description !== undefined ? str(b.description, 2000) : cur.description || '',
    status: oneOf(b.status, ['todo', 'doing', 'review', 'done'], cur.status || 'todo'), priority: oneOf(b.priority, ['low', 'medium', 'high'], cur.priority || 'medium'),
    assignee_id: b.assignee_id !== undefined ? (+b.assignee_id || null) : cur.assignee_id ?? null, due: b.due !== undefined ? date(b.due) : cur.due || '' };
}
app.post('/api/tasks', (req, res) => {
  const f = taskFields(req.body || {}); if (!f.title || !db.prepare('select 1 from projects where id=?').get(f.project_id)) return bad(res, 'Title and project are required.');
  const t = Date.now(), r = db.prepare('insert into tasks(project_id,title,description,status,priority,assignee_id,due,created_at,updated_at) values(@project_id,@title,@description,@status,@priority,@assignee_id,@due,@t,@t)').run({ ...f, t });
  audit(req, 'task.created', f.title); notify([f.assignee_id], `${req.user.name} assigned you "${f.title}"`, '#tasks', req.user.id); res.status(201).json({ id: Number(r.lastInsertRowid) });
});
app.patch('/api/tasks/:id', (req, res) => {
  const cur = db.prepare('select * from tasks where id=?').get(+req.params.id); if (!cur) return bad(res, 'Task not found.', 404);
  const f = taskFields(req.body || {}, cur);
  db.prepare('update tasks set project_id=@project_id,title=@title,description=@description,status=@status,priority=@priority,assignee_id=@assignee_id,due=@due,updated_at=@t where id=@id').run({ ...f, id: cur.id, t: Date.now() });
  if (f.assignee_id !== cur.assignee_id) notify([f.assignee_id], `${req.user.name} assigned you "${f.title}"`, '#tasks', req.user.id);
  if (f.status !== cur.status) { audit(req, 'task.' + f.status, f.title); if (f.status === 'done') notify(allUsers(), `${req.user.name} completed "${f.title}"`, '#tasks', req.user.id); }
  res.json({ ok: true });
});
app.delete('/api/tasks/:id', (req, res) => { const t = db.prepare('select title from tasks where id=?').get(+req.params.id); if (!t) return bad(res, 'Task not found.', 404); db.prepare('delete from tasks where id=?').run(+req.params.id); audit(req, 'task.deleted', t.title); res.json({ ok: true }); });

// ---------- credentials vault (AES-256-GCM at rest, every reveal is logged and notified) ----------
app.get('/api/vault', admin, (req, res) => res.json(db.prepare('select v.id,v.label,v.url,v.username,v.created_at,c.name company from vault v left join companies c on c.id=v.company_id order by v.label').all()));
app.post('/api/vault', admin, (req, res) => {
  const label = str(req.body?.label, 120), secret = str(req.body?.secret, 1000); if (!label || !secret) return bad(res, 'Label and secret are required.');
  db.prepare('insert into vault(label,company_id,url,username,secret_enc,created_by,created_at) values(?,?,?,?,?,?,?)')
    .run(label, +req.body.company_id || null, str(req.body.url, 300), str(req.body.username, 200), enc(secret), req.user.id, Date.now());
  audit(req, 'vault.created', label); res.status(201).json({ ok: true });
});
const revealLimiter = rateLimit({ windowMs: 60_000, limit: 20, keyGenerator: req => String(req.user.id), validate: false });
app.post('/api/vault/:id/reveal', admin, revealLimiter, (req, res) => {
  const v = db.prepare('select * from vault where id=?').get(+req.params.id); if (!v) return bad(res, 'Entry not found.', 404);
  audit(req, 'vault.revealed', v.label); notify(allUsers(), `${req.user.name} viewed the credential "${v.label}"`, '#activity', req.user.id);
  res.set('Cache-Control', 'no-store').json({ secret: dec(v.secret_enc) });
});
app.delete('/api/vault/:id', admin, (req, res) => { const v = db.prepare('select label from vault where id=?').get(+req.params.id); if (!v) return bad(res, 'Entry not found.', 404); db.prepare('delete from vault where id=?').run(+req.params.id); audit(req, 'vault.deleted', v.label); res.json({ ok: true }); });

// ---------- notifications & audit ----------
app.get('/api/notifications', (req, res) => res.json(db.prepare('select * from notifications where user_id=? order by id desc limit 50').all(req.user.id)));
app.post('/api/notifications/read', (req, res) => { db.prepare('update notifications set read=1 where user_id=?').run(req.user.id); res.json({ ok: true }); });
app.get('/api/audit', admin, (req, res) => res.json(db.prepare('select a.id,a.action,a.detail,a.ip,a.created_at,u.name from audit a left join users u on u.id=a.user_id order by a.id desc limit 200').all()));

app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong on our side.' }); });
setInterval(() => db.prepare('delete from sessions where expires<? or revoked=1 and last_seen<?').run(Date.now(), Date.now() - 7 * 86400_000), 3600_000).unref();
app.listen(PORT, () => console.log(`fokus HQ running on http://localhost:${PORT}`));
