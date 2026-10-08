# fokus HQ

Internal dashboard for **fokus** and its three companies (Agency, Automation, Campus Marketplace):
projects, tasks, shared credentials vault, device sessions, notifications and an audit log.

## Run it
Requires Node 22.13 or newer (uses the built-in SQLite, no native compilation).
```bash
npm install
# Windows: copy .env.example .env   |  Mac/Linux: cp .env.example .env
# Generate VAULT_KEY with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# then set VAULT_KEY and the three team emails in .env
npm start                     # http://localhost:3000
```
On first run the console prints a temporary password for each of the three accounts (owner, CTO, COO).
Each person must set a new password (12+ characters) at first login.

## Security built in
- Passwords hashed with scrypt; login lockout (5 fails = 15 min) and rate limits
- Server-side sessions: random token stored only as a SHA-256 hash, HttpOnly + SameSite=Strict cookie (+ Secure in production)
- Idle timeout 2 h / max 12 h, or "keep me signed in" for 30 days; revoke any device from **Sessions**
- CSRF token required on every write; strict CSP, helmet headers; parameterized SQL everywhere
- Vault secrets encrypted with AES-256-GCM; every reveal is audited and notifies the team
- Changing a password signs out all other devices

## Roles
`owner` (everything, adds users, deletes projects) · `admin` (vault + audit log) · `member` (projects and tasks)

## API (all under /api, JSON, cookie session + X-CSRF-Token on writes)
auth: `POST /auth/login|logout|password`, `GET /auth/me` · `GET /sessions`, `DELETE /sessions/:id`
`GET /overview` · `GET|POST /projects`, `PATCH|DELETE /projects/:id` · `GET|POST /tasks`, `PATCH|DELETE /tasks/:id`
`GET|POST /vault`, `POST /vault/:id/reveal`, `DELETE /vault/:id` · `GET /notifications`, `POST /notifications/read`
`GET /audit` · `GET /meta` · `POST /users` (owner)

## Going to production
Serve behind HTTPS (Caddy/Nginx), set `NODE_ENV=production`, back up `fokus.db` and keep `VAULT_KEY` somewhere safe:
without it the vault cannot be decrypted. Deploy to a small VPS, Railway or Fly.io with a persistent volume.
