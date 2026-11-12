# Deployment

EduSphere has **not** been operated for a real institution. Treat this as a starting point and
test it in your own environment first.

There are two ways to host it:

| | [One server](#one-process-one-port) | [Vercel and Neon](#vercel-and-neon) |
|---|---|---|
| What runs | One Node.js process that stays up, your PostgreSQL, a disk | The web app from Vercel's network, the API as a function that starts on demand, PostgreSQL at Neon |
| You operate | A server (or a container host), HTTPS, backups | Nothing; both have free plans with monthly allowances |
| Live updates | Pushed at once (WebSockets) | Screens ask again every few seconds |
| Uploads | On disk, 25 MB each by default | In the database, 4 MB each, 300 MB in total by default |
| Timed work (closing a quiz, scheduled posts) | On a timer | When somebody uses the site, and once a day |
| Fits | Real classes, a whole school | A demonstration, a pilot with a few classes |

The application is the same in both; it adapts to where it runs.

## One server

### What you need

| | |
|---|---|
| Node.js | 22.12 or newer; tested with 22, 24 and 26 |
| PostgreSQL | 14 or newer (developed against 18). The embedded server used by `npm run dev` is for development only |
| Disk | A persistent directory for uploaded files (`STORAGE_DIR`), or `STORAGE_DRIVER=database` to keep them in PostgreSQL |
| HTTPS | Required. Browsers only provide location and camera access on secure pages, and session cookies are marked `Secure` |
| Memory | Password hashing uses about 32 MB per sign-in at the default work factor |

### One process, one port

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
| `GET /readyz` | The database answers and has every table this version uses (503 otherwise). The answer includes the round trip to the database in milliseconds |

`npm run smoke -- https://lms.example.edu` checks a running production site from outside: pages,
security headers, the API, the database, and that the development helpers are closed. With
`SMOKE_EMAIL` and `SMOKE_PASSWORD` of an administrator it also signs in and stores, reads and
deletes a small file.

### Web app on a separate host

`frontend/dist` is a static single-page app and can be served by any static host or CDN,
provided that the same origin forwards `/api` and `/socket.io` to the API and answers unknown
paths with `index.html`. Two things to carry over yourself:

- The security headers (Content-Security-Policy and the others in `backend/src/app.js`) are sent
  by the API. A separate host must send them for the HTML it serves. `vercel.json` shows how.
- If the web app and the API end up on different origins, set `CORS_ORIGINS`,
  `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true`. Same origin is simpler and safer.

If the host in front cannot pass WebSockets on, set `REALTIME_ENABLED=false`: the web app then
refreshes its live screens on a timer instead.

## Vercel and Neon

No server to look after: Vercel serves the web app and runs the API as a single function
(`api/index.js`), and the data lives in a Neon PostgreSQL database. `vercel.json` holds the whole
setup, so the Vercel project needs no build settings.

### What is different there

| | On Vercel |
|---|---|
| Uploaded files | Kept in the database (table `FileBlob`), because a function has no lasting disk. One file can be at most **4 MB**: Vercel refuses larger requests before the API sees them, so the web app checks the size first and says so. All files together are limited to 300 MB (`STORAGE_QUOTA_MB`); the administrator's **Settings** page shows how full the store is |
| Live updates | No WebSockets. The attendance monitor and an open conversation ask again every 5 seconds, the numbers in the page header every minute. The header and dashboard timers stop after ten minutes without keyboard or mouse and catch up when the reader returns; every request counts against the monthly allowance |
| Background jobs | No timer runs between requests. The first request after a job is due runs it (claimed in the table `JobState`, so two instances never do the same turn), and Vercel calls `/api/internal/cron` once a day. Nothing is decided by this: time limits, check-in windows and publishing times are enforced when a request is handled, whether or not a job has run. What waits for the next visitor or the daily call is the tidying up (marking absentees, closing attempts nobody opened) and the sending of notifications, reminders and their e-mail copies |
| Rate limits | Counted per function instance, so they are looser than on one server. The lockout after failed sign-ins is kept in the database and works as usual |
| Security headers for pages | Sent by Vercel from `vercel.json`. A test keeps them identical to what the API sends |
| Demo accounts | Never: a function always runs in production mode |

### Setting it up

1. **Import the repository** as a project in Vercel. Leave the build settings empty.
2. **Add a PostgreSQL database** under the project's *Storage* tab (Neon). It must provide
   `DATABASE_URL` and, for migrations, a direct address (`DATABASE_URL_UNPOOLED`; Neon sets both).
3. **Add these environment variables** for *Production*:

   | Variable | Value |
   |---|---|
   | `SEED_ADMIN_EMAIL` | E-mail address of the first administrator |
   | `SEED_ADMIN_PASSWORD` | A temporary password of at least 10 characters. It must be changed at the first sign-in |
   | `CRON_SECRET` | A long random text. Vercel sends it with the daily call, which then runs every job; without it the call only runs what is due |
   | `NODEJS_HELPERS` | `0`, for *Production* and *Preview*. Tells Vercel to hand requests to the application as they are, instead of reading their bodies first |
   | `NODE_OPTIONS` | `--experimental-require-module`, for *Production* and *Preview*. **Without it the API does not start.** Vercel's Node.js runtime refuses to load an ES module with `require()` unless this is set, and a dependency does exactly that (`sanitize-html` requires `htmlparser2`). The build stops and says so when the variable is missing |
   | `APP_URL` | Only with a custom domain: its full address, for example `https://lms.example.edu` |

   The optional services ([below](#optional-services)) are configured the same way.
4. **Deploy** (push to the production branch). The build
   (`scripts/vercel-build.mjs`) generates the database client, builds the web app, then — for
   production deployments only — creates or updates the tables and makes sure the role
   permissions, the default grading scale and the first administrator exist. If the database
   step fails, the build fails and the previous deployment stays live.
5. **Check**: `https://<your-site>/readyz` answers `{"status":"ready"}`. Sign in, choose a new
   password, then delete `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` from the project.

`npm run smoke -- https://<your-site>` checks more from your own computer ([above](#health-checks)).

### If the API does not answer

- **`503 STARTUP_FAILED`** on every API address: the application could not start — a setting
  it rejects, or a dependency Vercel's runtime will not load (`ERR_REQUIRE_ESM`: the project
  lacks `NODE_OPTIONS=--experimental-require-module`). The reason is in the function's log
  (Vercel → the project → *Logs*; the free plan keeps it for an hour). Without opening Vercel,
  `CRON_SECRET=<the project's value> npm run smoke -- https://<your-site>` prints it too.
- **Vercel's own page, `FUNCTION_INVOCATION_FAILED`**: the function ended before it could
  answer at all. Look at the same log.
- **`503 DATABASE_UNAVAILABLE` or `DATABASE_OUT_OF_DATE`**: the database cannot be reached, or
  has not been migrated by a production build yet.
- **Sign-in answers "Please correct the highlighted fields" although both fields are filled
  in**: Vercel read the request before the application could. Check that the variable
  `NODEJS_HELPERS=0` is set for the project, and deploy again. The smoke check tests this.

### Preview deployments

A preview (a deployment of any other branch) **never changes the database** and **does not run
background jobs**. Unless you give previews their own database, they read and write the
production data, so open them with care. A preview whose code expects newer tables answers
`503 DATABASE_OUT_OF_DATE` instead of failing in odd ways.

- `MIGRATE_ON_BUILD=true` on an environment makes its builds migrate anyway (for previews with
  a database of their own); `MIGRATE_ON_BUILD=false` stops production builds from migrating.
- `SCHEDULER_ENABLED=true` lets a preview run the background jobs.

### What the free plans allow

Figures from the providers' plan pages on 2026-11-11
([Vercel Hobby](https://vercel.com/docs/plans/hobby), [Neon](https://neon.com/docs/introduction/plans)).
They change; check them.

| Allowance per month | Free plan | What uses it |
|---|---|---|
| Vercel: requests | 1,000,000 | Every page, script and API call. A signed-in tab that is being used makes about one request a minute by itself |
| Vercel: function running time | 4 hours of processor time, 360 GB-hours of memory | Processor time is counted while the API computes; memory for as long as an instance has work in progress. The API keeps an instance busy for about a second after its last database query, to close the connection cleanly |
| Neon: database running time | 100 compute-hours, about 400 hours at the smallest size | The database runs while the site is in use and pauses after 5 minutes without queries. The first request after a pause takes a second or two longer |
| Neon: storage | 1 GB | All records and all uploaded files |
| Neon: data sent to the API | 5 GB | Every query result, and every download of an uploaded file |

Nothing is charged on these plans, so a used-up allowance means **the site stops**: Vercel
suspends the feature concerned for up to 30 days, and Neon's free plan has no paid overage
either. Vercel's free plan is for personal, non-commercial use, runs the scheduled call at most
once a day and keeps the function's logs for one hour.

In round numbers this is a pilot — a few classes, files in the low megabytes — not a campus. No
measurement was made with real users. For more, move to paid plans or to [one server](#one-server);
the same database works with both.

### Good to know

- **Region.** `regions` in `vercel.json` says where the function runs. It is set to Singapore
  (`sin1`) because the database of this deployment is there (Neon `ap-southeast-1`); without
  it, Vercel runs functions in Washington, D.C. (`iad1`). **Change it to the Vercel region next
  to your database.** The free plan allows one region. The function pays for the distance on
  every query, and one page asks for several: across an ocean that is about a quarter of a
  second each. The build says where the two are when the database is a Neon one, and `/readyz`
  reports the round trip: some tens of milliseconds when they are next to each other (it
  includes opening a connection when none is open), a few hundred when they are not.
- **Node.js version.** `engines` in `package.json` stops at the newest version this was tested
  with (26), so that Vercel does not move the site to a new major version by itself.
- **Database connections.** Each function instance keeps at most 5 (`DATABASE_POOL_MAX`) and
  closes an unused one after a second (`DATABASE_POOL_IDLE_MS`). Use the pooled address for
  `DATABASE_URL`.
- **`sslmode=require`** in a database address means encrypted *and* verified against the public
  certificate authorities. A server with a self-signed certificate needs `sslmode=no-verify`.
- **Moving to a server later.** Point the server at the same database and set
  `STORAGE_DRIVER=database` to keep reading the files stored there. There is no tool yet that
  moves files between the database and a disk.
- **Trying it locally.** `npx vercel build` writes what Vercel would deploy to `.vercel/output`;
  `node e2e/vercel/serve.mjs` serves it the way Vercel routes it (see [TESTING.md](TESTING.md)).

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

With `STORAGE_DRIVER=database` (the default on Vercel) the files are inside the database, so
`pg_dump` covers everything. Neon's free plan can only rewind a database by six hours; take your
own dumps of anything you cannot afford to lose.

## Updating

On Vercel, merging into the production branch updates the site; the build applies new migrations.
On a server:

```bash
git pull
npm ci
npm run db:generate
npm run build
npm run db:deploy      # applies new migrations; safe when there are none
# restart the process
```

Back up before applying migrations.

## Limits

- **One API process on a server.** Rate limits and real-time delivery are kept in the memory of
  the process. Several instances behind a load balancer would need a shared rate-limit store, a
  Socket.IO adapter and sticky sessions; none of that is included. Background jobs are safe to
  run on more than one instance, but `SCHEDULER_ENABLED=false` on all but one avoids duplicate work.
- **Uploads on local disk or in the database.** Object storage (S3 and the like) is not included;
  it would be a third back-end in `backend/src/services/storage.js`, and the way to lift the
  size limits on Vercel.
- **The tests check Vercel against a stand-in.** The output of Vercel's own build tool is served
  locally the way Vercel routes it (the function with only its traced files on a read-only disk,
  Node.js 26, no `require()` of ES modules unless `NODE_OPTIONS` allows it, the request size
  limit), with a local PostgreSQL in
  place of Neon. The first real deployments still failed on something the stand-in did not
  reproduce then (Vercel refusing to `require()` an ES module; it does now), so treat it as a
  filter, not as proof. Vercel freezing an instance
  between requests, several instances at once and a Neon database under real use are not
  exercised by any test; `npm run smoke` against the live address shows what works there.
- **No load testing** was done. The largest data set used was the demo school (three classes,
  ten students).
- **Database client.** The project uses Prisma's JavaScript engines (`PRISMA_SCHEMA_ENGINE=js`,
  the default in `.env.example`), so installing needs no native downloads. `npm run db:deploy`,
  `db:seed` and `db:reset` work this way. Creating new migrations (`npm run db:migrate`) needs
  Prisma's native engine: unset `PRISMA_SCHEMA_ENGINE` on a machine that can download it.
