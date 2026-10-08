const $ = s => document.querySelector(s);
const S = { me: null, csrf: '', view: 'overview', co: 'all', companies: [], users: [], unread: 0 };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = t => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const TS = { todo: 'To do', doing: 'In progress', review: 'In review', done: 'Done' };
const color = id => (S.companies.find(c => c.id === id) || {}).color || '#999';
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); };

async function api(p, o = {}) {
  const r = await fetch('/api' + p, { method: o.method || 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': S.csrf }, body: o.body ? JSON.stringify(o.body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && p !== '/auth/login') { S.me = null; render(); throw new Error(d.error); }
  if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.code = d.code; throw e; } return d;
}
const opts = (list, sel, blank) => (blank ? `<option value="">${blank}</option>` : '') + list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(l)}</option>`).join('');
const coOpts = sel => opts(S.companies.map(c => [c.id, c.name]), sel);
const userOpts = (sel, blank = 'Unassigned') => opts(S.users.map(u => [u.id, u.name]), sel, blank);

function form(title, html, onSubmit, cta = 'Save') {
  const d = $('#dlg'); d.innerHTML = `<form method="dialog" id="f"><h2>${esc(title)}</h2>${html}<p class="err" id="ferr"></p><div class="row sp"><button class="btn" type="button" data-a="close">Cancel</button><button class="btn pri">${cta}</button></div></form>`;
  d.showModal();
  $('#f').onsubmit = async e => { e.preventDefault(); try { await onSubmit(Object.fromEntries(new FormData(e.target))); d.close(); } catch (x) { $('#ferr').textContent = x.message; } };
}
const f = (n, l, t = 'text', v = '', req = false) => `<label for="${n}">${l}</label><input id="${n}" name="${n}" type="${t}" value="${esc(v)}" ${req ? 'required' : ''}>`;
const sel = (n, l, o) => `<label for="${n}">${l}</label><select id="${n}" name="${n}">${o}</select>`;

// ---------- screens ----------
function loginView() {
  $('#app').innerHTML = `<div class="login"><form class="card" id="lf"><div class="logo row"><span class="tri"><i style="background:#E4572E"></i><i style="background:#12A594"></i><i style="background:#E8A200"></i></span><b style="font-size:1.4rem">fokus HQ</b></div>
  <p class="sub">Sign in to your team dashboard.</p>${f('email', 'Email', 'email', '', true)}${f('password', 'Password', 'password', '', true)}
  <label class="chk"><input type="checkbox" name="remember"> Keep me signed in on this device (30 days)</label><p class="err" id="err"></p><button class="btn pri" style="width:100%">Sign in</button></form></div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); d.remember = !!d.remember;
    try { const r = await api('/auth/login', { method: 'POST', body: d }); S.me = r.user; S.csrf = r.csrf; boot(); } catch (x) { $('#err').textContent = x.message; }
  };
}
function mustChange() {
  $('#app').innerHTML = `<div class="login"><form class="card" id="pf"><h1>Set your password</h1><p class="sub">Your temporary password has to be replaced before you continue. Use 12+ characters.</p>
  ${f('current', 'Temporary password', 'password', '', true)}${f('next', 'New password', 'password', '', true)}<p class="err" id="err"></p><button class="btn pri" style="width:100%">Save password</button></form></div>`;
  $('#pf').onsubmit = async e => { e.preventDefault(); try { await api('/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); S.me.must_change = 0; boot(); } catch (x) { $('#err').textContent = x.message; } };
}
const NAV = [['overview', 'Overview'], ['projects', 'Projects'], ['tasks', 'Tasks'], ['vault', 'Vault'], ['sessions', 'Sessions'], ['activity', 'Activity'], ['notifications', 'Notifications']];
function shell() {
  $('#app').innerHTML = `<div class="top"><b>fokus HQ</b><button data-a="menu" aria-label="Open menu">Menu</button></div><div class="shell"><nav id="nav"><div class="logo"><span class="tri">${S.companies.map(c => `<i style="background:${c.color}"></i>`).join('')}</span>fokus HQ</div>
  ${NAV.map(([k, l]) => `<a href="#${k}" class="${S.view === k ? 'on' : ''}">${l}${k === 'notifications' && S.unread ? `<span class="badge">${S.unread}</span>` : ''}</a>`).join('')}
  <div class="me">${esc(S.me.name)}<br>${esc(S.me.role)}<button class="btn" data-a="logout">Sign out</button></div></nav><main id="main"></main></div>`;
}
const chips = () => `<div class="chips" role="group" aria-label="Filter by company"><button class="chip ${S.co === 'all' ? 'on' : ''}" data-a="co" data-id="all">All</button>${S.companies.map(c => `<button class="chip ${S.co == c.id ? 'on' : ''}" data-a="co" data-id="${c.id}"><span class="dot" style="--c:${c.color}"></span>${esc(c.name)}</button>`).join('')}</div>`;
const inCo = x => S.co === 'all' || x.company_id == S.co;

const views = {
  async overview() {
    const d = await api('/overview'), tot = d.companies.reduce((a, c) => a + c.todo + c.doing + c.review + c.done, 0), done = d.companies.reduce((a, c) => a + c.done, 0);
    return `<h1>Overview</h1><p class="sub">${done} of ${tot} tasks completed across fokus.</p>
    <div class="bar" role="img" aria-label="Completed tasks by company">${d.companies.map(c => `<i style="background:${c.color};width:${tot ? c.done / tot * 100 : 0}%" title="${esc(c.name)}: ${c.done} done"></i>`).join('')}</div>
    <div class="grid">${d.companies.map(c => `<div class="card co" style="--c:${c.color}"><h2>${esc(c.name)}<span class="muted">${c.projects} active projects</span></h2>
      <div class="stats"><div><b>${c.todo}</b><span>To do</span></div><div><b>${c.doing}</b><span>In progress</span></div><div><b>${c.review}</b><span>In review</span></div><div><b>${c.done}</b><span>Done</span></div></div>
      ${c.overdue ? `<p style="margin:.7rem 0 0"><span class="tag late">${c.overdue} overdue</span></p>` : ''}</div>`).join('')}</div>
    <div class="grid" style="margin-top:1rem"><div class="card"><h2>Assigned to you</h2><div class="list">${d.mine.map(t => `<div><span class="dot" style="--c:${color(t.company_id)}"></span><b>${esc(t.title)}</b> <span class="tag">${TS[t.status]}</span><div class="muted">${esc(t.project)}${t.due ? ' · due ' + esc(t.due) : ''}</div></div>`).join('') || '<p class="muted">Nothing assigned to you. Create a task from the Tasks page.</p>'}</div></div>
    <div class="card"><h2>Recent activity</h2><div class="list">${d.recent.map(a => `<div>${esc(a.name || 'System')} · ${esc(a.action)} <b>${esc(a.detail)}</b><div class="muted">${when(a.created_at)}</div></div>`).join('') || '<p class="muted">No activity yet.</p>'}</div></div></div>`;
  },
  async projects() {
    S.projects = await api('/projects'); const ps = S.projects.filter(inCo);
    return `<div class="row sp"><div><h1>Projects</h1><p class="sub">Everything in flight, by company.</p></div><button class="btn pri" data-a="newproj">New project</button></div>${chips()}
    <div class="grid">${ps.map(p => `<div class="card co" style="--c:${color(p.company_id)}"><h2>${esc(p.name)}<span class="tag">${esc(p.status)}</span></h2><div class="muted">${esc(p.company)} · ${esc(p.owner || 'No owner')}${p.due ? ' · due ' + esc(p.due) : ''}</div>
      <p>${esc(p.description)}</p><div class="prog" style="--c:${color(p.company_id)}"><i style="width:${p.tasks ? p.done / p.tasks * 100 : 0}%"></i></div><div class="row sp"><span class="muted">${p.done}/${p.tasks} tasks done</span>
      <span class="row"><button class="btn sm" data-a="editproj" data-id="${p.id}">Edit</button>${S.me.role === 'owner' ? `<button class="btn sm bad" data-a="delproj" data-id="${p.id}">Delete</button>` : ''}</span></div></div>`).join('') || '<p class="muted">No projects here yet. Create your first one.</p>'}</div>`;
  },
  async tasks() {
    S.projects = await api('/projects'); const ts = (await api('/tasks')).filter(inCo), today = new Date().toISOString().slice(0, 10);
    return `<div class="row sp"><div><h1>Tasks</h1><p class="sub">Move work forward with the status menu on each card.</p></div><button class="btn pri" data-a="newtask">New task</button></div>${chips()}
    <div class="board">${Object.entries(TS).map(([k, l]) => `<div class="col"><h2>${l} <span class="muted">${ts.filter(t => t.status === k).length}</span></h2>${ts.filter(t => t.status === k).map(t => `<div class="task" style="--c:${color(t.company_id)}"><b>${esc(t.title)}</b><p>${esc(t.project)}${t.assignee ? ' · ' + esc(t.assignee) : ''}</p>
      <div class="row">${t.priority === 'high' ? '<span class="tag high">High</span>' : ''}${t.due ? `<span class="tag ${t.due < today && k !== 'done' ? 'late' : ''}">${esc(t.due)}</span>` : ''}</div>
      <div class="row" style="margin-top:.5rem"><select data-a="move" data-id="${t.id}" aria-label="Status of ${esc(t.title)}">${opts(Object.entries(TS), k)}</select><button class="btn sm" data-a="edittask" data-id="${t.id}">Edit</button></div></div>`).join('')}</div>`).join('')}</div>`;
  },
  async vault() {
    const v = await api('/vault').catch(() => null); if (!v) return '<h1>Vault</h1><p class="sub">Only owners and admins can open the vault.</p>';
    return `<div class="row sp"><div><h1>Vault</h1><p class="sub">Shared credentials, encrypted at rest. Every view is logged and the team is notified.</p></div><button class="btn pri" data-a="newsecret">Add credential</button></div>
    <div class="card list">${v.map(x => `<div class="row sp"><div><b>${esc(x.label)}</b> <span class="tag">${esc(x.company || 'Shared')}</span><div class="muted">${esc(x.username)} ${esc(x.url)}</div><div id="s${x.id}"></div></div>
      <span class="row"><button class="btn sm" data-a="reveal" data-id="${x.id}">Reveal</button><button class="btn sm bad" data-a="delsecret" data-id="${x.id}">Delete</button></span></div>`).join('') || '<p class="muted">The vault is empty.</p>'}</div>`;
  },
  async sessions() {
    const s = await api('/sessions');
    return `<h1>Sessions</h1><p class="sub">Devices signed in to your account. Revoke any you don't recognise.</p><div class="card list">${s.map(x => `<div class="row sp"><div><b>${x.current ? 'This device' : esc(x.ua.slice(0, 70) || 'Unknown device')}</b> <span class="tag">${x.remember ? 'Saved 30 days' : 'Active'}</span>
      <div class="muted">${esc(x.ip)} · signed in ${when(x.created_at)} · last seen ${when(x.last_seen)}</div></div>${x.current ? '' : `<button class="btn sm bad" data-a="revoke" data-id="${x.id}">Sign out</button>`}</div>`).join('')}</div>
      <div class="row" style="margin-top:1rem"><button class="btn" data-a="chpw">Change password</button>${S.me.role === 'owner' ? '<button class="btn" data-a="newuser">Add team member</button>' : ''}</div>`;
  },
  async activity() {
    const a = await api('/audit').catch(() => null); if (!a) return '<h1>Activity</h1><p class="sub">Only owners and admins can see the audit log.</p>';
    return `<h1>Activity</h1><p class="sub">Security and work history (last 200 events).</p><div class="card list">${a.map(x => `<div><b>${esc(x.name || 'Unknown')}</b> · ${esc(x.action)} ${esc(x.detail)}<div class="muted">${when(x.created_at)} · ${esc(x.ip)}</div></div>`).join('')}</div>`;
  },
  async notifications() {
    const n = await api('/notifications'); setTimeout(async () => { if (S.unread) { await api('/notifications/read', { method: 'POST' }); S.unread = 0; shell(); } }, 1500);
    return `<h1>Notifications</h1><p class="sub">Assignments, completed work and credential access.</p><div class="card list">${n.map(x => `<div class="${x.read ? '' : 'unread'}">${esc(x.text)}<div class="muted">${when(x.created_at)}</div></div>`).join('') || '<p class="muted">You are all caught up.</p>'}</div>`;
  },
};

async function render() {
  if (!S.me) return loginView(); if (S.me.must_change) return mustChange();
  const v = location.hash.slice(1); S.view = views[v] ? v : 'overview'; shell();
  try { $('#main').innerHTML = await views[S.view](); } catch (e) { if (S.me) $('#main').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function boot() {
  if (!S.me) return render();
  if (S.me.must_change) return render();
  const [m, n] = await Promise.all([api('/meta'), api('/notifications')]); S.companies = m.companies; S.users = m.users; S.unread = n.filter(x => !x.read).length; render();
}

// ---------- actions ----------
const projForm = (p = {}) => f('name', 'Name', 'text', p.name, true) + sel('company_id', 'Company', coOpts(p.company_id)) + `<label for="description">Description</label><textarea id="description" name="description" rows="3">${esc(p.description)}</textarea>`
  + sel('status', 'Status', opts([['planned', 'Planned'], ['active', 'Active'], ['paused', 'Paused'], ['done', 'Done']], p.status || 'active')) + sel('owner_id', 'Owner', userOpts(p.owner_id || S.me.id)) + f('due', 'Due date', 'date', p.due);
const taskForm = (t = {}) => f('title', 'Title', 'text', t.title, true) + sel('project_id', 'Project', opts(S.projects.map(p => [p.id, `${p.name} (${p.company})`]), t.project_id)) + sel('assignee_id', 'Assignee', userOpts(t.assignee_id))
  + sel('priority', 'Priority', opts([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], t.priority || 'medium')) + f('due', 'Due date', 'date', t.due) + `<label for="description">Notes</label><textarea id="description" name="description" rows="3">${esc(t.description)}</textarea>`;
const done = msg => async () => { toast(msg); await render(); };

const actions = {
  close: () => $('#dlg').close(),
  menu: () => $('#nav').classList.toggle('open'),
  logout: async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); S.me = null; S.csrf = ''; render(); },
  co: el => { S.co = el.dataset.id; render(); },
  newproj: () => form('New project', projForm(), async d => { await api('/projects', { method: 'POST', body: d }); await done('Project created')(); }, 'Create project'),
  editproj: el => { const p = S.projects.find(x => x.id == el.dataset.id); form('Edit project', projForm(p), async d => { await api('/projects/' + p.id, { method: 'PATCH', body: d }); await done('Project saved')(); }); },
  delproj: async el => { if (confirm('Delete this project and all its tasks?')) { await api('/projects/' + el.dataset.id, { method: 'DELETE' }); done('Project deleted')(); } },
  newtask: () => S.projects.length ? form('New task', taskForm(), async d => { await api('/tasks', { method: 'POST', body: d }); await done('Task created')(); }, 'Create task') : toast('Create a project first'),
  edittask: async el => { const t = (await api('/tasks')).find(x => x.id == el.dataset.id); form('Edit task', taskForm(t) + `<p><button class="btn sm bad" type="button" data-a="deltask" data-id="${t.id}">Delete task</button></p>`, async d => { await api('/tasks/' + t.id, { method: 'PATCH', body: d }); await done('Task saved')(); }); },
  deltask: async el => { if (confirm('Delete this task?')) { await api('/tasks/' + el.dataset.id, { method: 'DELETE' }); $('#dlg').close(); done('Task deleted')(); } },
  newsecret: () => form('Add credential', f('label', 'Label', 'text', '', true) + sel('company_id', 'Company', coOpts() + '<option value="">Shared</option>') + f('url', 'Link') + f('username', 'Username') + f('secret', 'Password or key', 'password', '', true), async d => { await api('/vault', { method: 'POST', body: d }); await done('Credential stored')(); }, 'Store securely'),
  reveal: async el => { const r = await api(`/vault/${el.dataset.id}/reveal`, { method: 'POST' }); const box = $('#s' + el.dataset.id); box.innerHTML = `<div class="secret">${esc(r.secret)}</div>`; setTimeout(() => box.innerHTML = '', 15000); },
  delsecret: async el => { if (confirm('Delete this credential?')) { await api('/vault/' + el.dataset.id, { method: 'DELETE' }); done('Credential deleted')(); } },
  revoke: async el => { await api('/sessions/' + el.dataset.id, { method: 'DELETE' }); done('Session signed out')(); },
  chpw: () => form('Change password', f('current', 'Current password', 'password', '', true) + f('next', 'New password (12+ characters)', 'password', '', true), async d => { await api('/auth/password', { method: 'POST', body: d }); toast('Password changed. Other devices were signed out.'); render(); }),
  newuser: () => form('Add team member', f('name', 'Name', 'text', '', true) + f('email', 'Email', 'email', '', true) + sel('role', 'Role', opts([['member', 'Member'], ['admin', 'Admin']])), async d => { const r = await api('/users', { method: 'POST', body: d }); alert(`Temporary password (shown once): ${r.temp_password}`); S.users = (await api('/meta')).users; }, 'Create account'),
};
document.addEventListener('click', e => { const el = e.target.closest('[data-a]'); if (el && actions[el.dataset.a] && el.tagName !== 'SELECT') { e.preventDefault(); Promise.resolve(actions[el.dataset.a](el)).catch(x => toast(x.message)); } });
document.addEventListener('change', async e => { if (e.target.dataset.a === 'move') { try { await api('/tasks/' + e.target.dataset.id, { method: 'PATCH', body: { status: e.target.value } }); toast('Task moved'); render(); } catch (x) { toast(x.message); } } });
window.addEventListener('hashchange', () => { $('#nav')?.classList.remove('open'); render(); });
api('/auth/me').then(r => { S.me = r.user; S.csrf = r.csrf; boot(); }).catch(() => render());
