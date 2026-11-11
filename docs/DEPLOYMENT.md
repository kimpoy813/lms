# Deployment

EduSphere has been run in development and as a single production-mode process on Linux. It has
**not** been operated for a real institution. Treat this as a starting point and test it in your
own environment first.

## What you need

| | |
|---|---|
| Node.js | 22.12 or newer |
| PostgreSQL | 14 or newer (developed against 18). The embedded server used by `npm run dev` is for development only |
| Disk | A persistent directory for uploaded files (`STORAGE_DIR`) |
| HTTPS | Required. Browsers only provide location and camera access on secure pages, and session cookies are marked `Secure` |
| Memory | Password hashing uses about 32 MB per sign-in at the default work factor |

## One process, one port

The simplest setup: the API serves the built web app.

```bash
git clone <repository> edusphere && cd edusphere
npm ci
cp backend/.env.example backend/.env   # then edit it — see below

npm run db:generate          # builds the database client
npm run build                # builds the web app into frontend/dist
npm run db:deploy            # creates or updates the tables
npm run db:seed              # permissions, default grading scale, first administrator
npm start
```

Minimum settings in `backend/.env` (or as real environment variables, which take precedence):

```ini
NODE_ENV=production
HOST=127.0.0.1                 # 0.0.0.0 in a container
PORT=4000
DATABASE_URL=postgresql://edusphere:<password>@127.0.0.1:5432/edusphere
APP_URL=https://lms.example.edu
TRUST_PROXY=1                  # number of reverse proxies in front of the API
SERVE_FRONTEND=true
STORAGE_DIR=/var/lib/edusphere/storage
PASSWORD_HASH_COST=15

# Used once by "npm run db:seed", only while no administrator exists.
SEED_ADMIN_EMAIL=registrar@example.edu
SEED_ADMIN_PASSWORD=<a long temporary password>
```

In production `npm run db:seed` creates no demo data. The first administrator must choose a new
password at first sign-in; remove the two `SEED_ADMIN_*` values afterwards.

Keep the process running with your usual tool (systemd, a container, a process manager). It
handles `SIGTERM` by finishing open requests and closing its connections.

### Reverse proxy

Terminate HTTPS in a reverse proxy and forward everything to the API. WebSocket upgrades must be
passed on for `/socket.io`. An nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name lms.example.edu;
  # ssl_certificate / ssl_certificate_key …

  client_max_body_size 30m;            # a little above MAX_UPLOAD_MB

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
  }
}
```

With `TRUST_PROXY` set, the API reads the visitor's address and the protocol from these headers.
Without it, every visitor appears to come from the proxy, which breaks rate limits and the
audit log.

### Health checks

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | The process is up |
| `GET /readyz` | The database answers (503 otherwise) |

## Web app on a separate host

`frontend/dist` is a static single-page app and can be served by any static host or CDN,
provided that the same origin forwards `/api` and `/socket.io` to the API and answers unknown
paths with `index.html`. This split was not tested. Two things to carry over yourself:

- The security headers (Content-Security-Policy and the others in `backend/src/app.js`) are sent
  by the API. A separate host must send them for the HTML it serves.
- If the web app and the API end up on different origins, set `CORS_ORIGINS`,
  `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true`. Same origin is simpler and safer.

The API itself needs a long-running Node.js process with a disk: it holds WebSocket connections,
runs background jobs and stores uploads. It does not fit serverless function platforms such as
Vercel as it is. Running it there would need a function entry point, object storage for uploads,
a scheduled trigger for the background jobs, and doing without WebSockets — none of which is
included.

## Optional services

Set these when you want the features (see `backend/.env.example` for all variables):

| Feature | Variables | Notes |
|---|---|---|
| E-mail | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Needed for password-reset links, e-mail verification and e-mail notifications. Without it, administrators issue temporary passwords |
| AI authoring | `AI_PROVIDER=openai-compatible`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | A daily limit per teacher is set in **Settings** |
| Code judge | `CODE_RUNNER_PROVIDER=piston`, `CODE_RUNNER_URL`, `CODE_RUNNER_API_KEY` | Run the judge isolated from the database and the API host |
| Map tiles | `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION` | The default is OpenStreetMap's public tile server; check its usage policy or use your own provider |

None of these was exercised against a real service during development.

## After the first start

Sign in as the administrator and, under **Settings**, set the institution's name and **time
zone** (it decides what "today" means for attendance and due dates), the registration rules and
the attendance limits. Then create the academic catalogue (terms, departments, courses,
sections) and the accounts, or import accounts from a CSV file.

## Backups

Back up both, at the same moment if possible:

1. the PostgreSQL database (`pg_dump`), and
2. the upload directory (`STORAGE_DIR`).

A database without its files has broken attachments; files without the database are unreadable
names. Practise a restore before you need one.

## Updating

```bash
git pull
npm ci
npm run db:generate
npm run build
npm run db:deploy      # applies new migrations; safe when there are none
# restart the process
```

Back up before applying migrations.

## Limits of this setup

- **One API process.** Rate limits and real-time delivery are kept in the memory of the process.
  Several instances behind a load balancer would need a shared rate-limit store, a Socket.IO
  adapter and sticky sessions; none of that is included. Background jobs are safe to run on more
  than one instance, but `SCHEDULER_ENABLED=false` on all but one avoids duplicate work.
- **Uploads on local disk.** For object storage, replace the storage functions in
  `backend/src/services/storage.js`.
- **No load testing** was done. The largest data set used was the demo school (three classes,
  ten students).
- **Database client.** The project uses Prisma's JavaScript engines (`PRISMA_SCHEMA_ENGINE=js`,
  the default in `.env.example`), so installing needs no native downloads. `npm run db:deploy`,
  `db:seed` and `db:reset` work this way. Creating new migrations (`npm run db:migrate`) needs
  Prisma's native engine: unset `PRISMA_SCHEMA_ENGINE` on a machine that can download it.
