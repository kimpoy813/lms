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
deletes a small file. With `CRON_SECRET` it asks the site to check its code runner, and prints
an address at which that check can be repeated from a browser.

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
| Photos | A photo from a phone is 3 to 6 MB. JPEG, PNG and WebP pictures above **1 MB** (`REDUCE_PHOTOS_OVER_MB`; `0` = never) are made smaller in the browser before they are sent: at most 2048 pixels on the long side, saved as JPEG — a 4.5 MB photo became 0.6 MB when this was tried. The person is told, and the original is not kept. Pictures more than three times as long as they are wide (a screenshot of a scrolled page) are left alone, as is anything the browser cannot read |
| Live updates | No WebSockets. The attendance monitor and an open conversation ask again every 5 seconds, the numbers in the page header every minute. The header and dashboard timers stop after ten minutes without keyboard or mouse and catch up when the reader returns; every request counts against the monthly allowance |
| Background jobs | No timer runs between requests. The first request after a job is due runs it (claimed in the table `JobState`, so two instances never do the same turn), and Vercel calls `/api/internal/cron` once a day. Nothing is decided by this: time limits, check-in windows and publishing times are enforced when a request is handled, whether or not a job has run. What waits for the next visitor or the daily call is the tidying up (marking absentees, closing attempts nobody opened) and the sending of notifications, reminders and their e-mail copies |
| Rate limits | Counted per function instance, so they are looser than on one server. The lockout after failed sign-ins is kept in the database and works as usual |
| Security headers for pages | Sent by Vercel from `vercel.json`. A test keeps them identical to what the API sends |
| Demo accounts | Never: a function always runs in production mode |
| E-mail | Only with the `SMTP_…` variables ([below](#optional-services)). Without them the site tells people so instead of promising a message: see [Without an e-mail server](#without-an-e-mail-server) |

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
   | `NODE_OPTIONS` | `--experimental-require-module`, for *Production* and *Preview*. **Without it the API does not start.** Vercel's Node.js runtime refuses to load an ES module with `require()` unless this is set, and a dependency does exactly that (`sanitize-html` requires `htmlparser2`). The build stops and says so when the variable is missing. Its list also names `@vercel/sandbox`, which ships a second copy of itself for `require()`; the API loads the other copy, so that one alone would not need the variable |
   | `CODE_RUNNER_PROVIDER` | Optional: `vercel-sandbox`, for *Production* and *Preview*, to have students' programs run and checked. See [Checking students' programs](#checking-students-programs) |
   | `APP_URL` | Only with a custom domain: its full address, for example `https://lms.example.edu` |

   The optional services ([below](#optional-services)) are configured the same way.
4. **Deploy** (push to the production branch). The build
   (`scripts/vercel-build.mjs`) generates the database client, builds the web app, then — for
   production deployments only — creates or updates the tables and makes sure the role
   permissions, the default grading scale and the first administrator exist. If the database
   step fails, the build fails and the previous deployment stays live
   ([If a migration fails](#if-a-migration-fails)). With `CODE_RUNNER_PROVIDER=vercel-sandbox` it
   then makes sure the machine image for checking programs exists and runs a small program in
   every language; that step never stops a deployment.
5. **Check**: `https://<your-site>/readyz` answers `{"status":"ready"}`. Sign in, choose a new
   password, then delete `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` from the project. The new
   password may not contain the account's name or the first part of its e-mail address; for the
   first administrator, whose account is called "System Administrator", that rules out the words
   "system" and "administrator". The message names the word to leave out.

`npm run smoke -- https://<your-site>` checks more from your own computer ([above](#health-checks)).
With `CRON_SECRET` it also has the live site run a small program in every language.

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

### If a migration fails

A production build changes the tables before the new version goes live. Each migration file is
sent to PostgreSQL as one query, which the database treats as one transaction: a migration is
applied **completely or not at all**, so a failed one leaves the tables as they were. The build
fails, and the site keeps running on the previous deployment.

Prisma then records the migration as failed and refuses to apply anything until that is settled.
The next build says so in plain words — the migration's name, the database's own error and what
to do — instead of Prisma's `P3009`:

1. Remove the cause. The error is in the build log; usually it is a mistake in the migration
   file, fixed with a new commit.
2. Add the environment variable `MIGRATE_RETRY_FAILED=<name of the migration>` for *Production*
   and deploy again. The build marks that migration as rolled back, and it runs again.
3. Remove the variable. Left in place it does nothing — it only acts on a migration that is
   recorded as failed under exactly that name.

`prisma migrate resolve`, the usual tool for this, needs Prisma's native engine, which the build
on Vercel does not have. On a server of your own you can use either.

Two rules for writing a migration follow from "one query, one transaction": it must not contain
statements that PostgreSQL refuses inside a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`;
a test checks this), and a long data change holds its locks until the whole file is done.

### Preview deployments

A preview (a deployment of any other branch) **never changes the database** and **does not run
background jobs**. Unless you give previews their own database, they read and write the
production data, so open them with care. A preview whose code expects newer tables answers
`503 DATABASE_OUT_OF_DATE` instead of failing in odd ways.

- `MIGRATE_ON_BUILD=true` on an environment makes its builds migrate anyway (for previews with
  a database of their own); `MIGRATE_ON_BUILD=false` stops production builds from migrating.
- `SCHEDULER_ENABLED=true` lets a preview run the background jobs.
- With `CODE_RUNNER_PROVIDER=vercel-sandbox` set for *Preview*, previews check programs too, and
  their builds make sure of the machine image. They share it with production, and its allowance.

### Checking students' programs

Vercel can also run the programs students write for coding problems, in
[Vercel Sandbox](https://vercel.com/docs/sandbox). Set `CODE_RUNNER_PROVIDER=vercel-sandbox` for
*Production* and *Preview* and deploy. There is nothing else to set and no key to keep: the
machines are started with the project's own short-lived identity, which Vercel hands to the
function with every request. (*Settings → Security → Secure backend access with OIDC federation*
has to stay enabled, as it is by default.) EduSphere uses that identity only when it was issued
to the project the site is deployed to, and keeps it out of everything the application logs or
answers ([SECURITY.md](SECURITY.md#running-students-programs)).

How one program is checked:

1. The API asks Vercel for a fresh machine: a copy of a prepared one (the "image", below) in the
   region of the function, **without any network access**.
2. It uploads the program, the test inputs and the limits — never the expected outputs — and
   starts the runner (`backend/src/services/judge/vmRunner.mjs`) in the machine.
3. The runner compiles the program once and runs it once per test, as a user without rights and
   inside the limits of the problem, and reports what each run printed.
4. The API compares with the expected outputs. The machine is stopped and deleted — after the
   answer has gone out, which saves the student four seconds, or before it where Vercel gives
   the function no way to keep running after a response. A machine that was not removed for any
   reason ends itself within three minutes; a daily job deletes what is left of it.

Measured from a Vercel build on 2026-11-12, in `sin1`: about a second for the machine, a second
for the upload and under a second before the runner starts, so **about three seconds plus what
the program itself needs** (a Java program takes a second longer to compile).

**Languages**, as Ubuntu 26.04 packaged them when the image was prepared: Python 3.14, Java 25,
C and C++ (GCC 15), JavaScript (Node.js 22).

**The image** is a sandbox that was set up once (compilers installed, about a minute) and then
stopped; Vercel keeps its disk as a snapshot of about 1 GB. It is called
`edusphere-judge-<fingerprint of the recipe>-<region>` and is listed under the project's
*Sandboxes*.

- The build makes sure of it ("Machine image for checking students' programs" in the build log)
  and then runs a small program in every language, so the log of each deployment says whether
  every language works.
- It is kept until somebody deletes it. (By default Vercel removes a snapshot 30 days after it
  was last used, which a break between terms would be enough for; the image is created with
  that rule switched off. The build log says "kept until it is deleted", or the date when it is
  not.)
- When the image is missing — somebody deleted it, or it could not be kept after all — the first
  program finds out; the API prepares it again by itself, which takes a few minutes, and tells
  students to try again shortly.
- A later version of EduSphere with another recipe gets another image. Production builds remove
  the ones no longer in use.

**Limits for a program**: the time per test and the memory set in the problem (the memory is for
the program's own data; a language's runtime gets room on top), 64 processes, 64 KB of output per
test, and 50 seconds for all tests of one program together, compiling included. Tests a slow
program does not reach count as too slow; the problem editor says so when the numbers allow it.

**When Vercel says no.** The plan limits how many machines may start per minute and run at the
same time ([below](#what-the-free-plans-allow)). Then the API answers "busy": the page waits a
few seconds and asks again by itself, up to three times; a quiz that is being handed in waits
briefly, and otherwise leaves the program for the teacher to mark, as it does without a code
runner. When the monthly allowance is used up, students are told that checking is not available;
the reason is shown to the administrator and written to the function's log.

**Is it working?**

- **Administration → Settings → Server → Code runner → Check now** runs a small program in every
  language and shows the versions, or the reason in full. It starts one machine.
- `CRON_SECRET=… npm run smoke -- https://<your-site>` does the same from outside, and says
  whether Vercel hands the function the project's identity and lets it finish work after a
  response.
- `npm run judge:check`, on a computer with `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and
  `VERCEL_PROJECT_ID` (or the token from `vercel env pull`), also runs the programs a judge has
  to withstand: endless loops, memory and process bombs, attempts to read the tests or to reach
  the network. Eight machines. See [TESTING.md](TESTING.md#the-code-runner-against-a-real-account).

**Python that is only being tried runs in the browser.** "Run sample tests" and "Try my own
input" for a Python program do not start a machine at all: the program runs on the student's own
device, in the same Python version (3.14) built for browsers
([Pyodide](https://pyodide.org), served from this site: about 13 MB on the first run, about half of that over the wire where the
host compresses, and from the browser's store afterwards). Nothing is counted against the allowance, a class can press "Run"
as often as it likes, and an answer takes a fraction of a second instead of three.

- "Submit for checking" and programs in quizzes are always checked on the server, with the hidden
  tests, which never reach the browser.
- A program the browser's Python might run differently goes to the server by itself, as before:
  one that uses files, threads, the network or a package that is not part of Python, one that
  fails in a way that can be the browser's own (memory, very deep recursion), and one whose answer
  is wrong only by the order of a set or the last digits of a decimal number. The page says "Run
  on the server instead" where a student may want that anyway.
- A program that does not end is stopped after three times the problem's time limit (at least 3
  and at most 30 seconds): a phone is slower than the server.
- Java, C, C++ and JavaScript always run on the server.
- Without a code runner, Python can still be tried this way; nothing can be submitted for checking.
- **Settings → Programming → "Let students try Python in their own browser"** switches it off,
  and every run goes to the server again. How the program is kept from the site and the network:
  [SECURITY.md](SECURITY.md#python-in-the-browser).

Outside Vercel the same judge can be used with an access token (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`,
`VERCEL_PROJECT_ID`, `CODE_RUNNER_REGION`); the machines still run on Vercel. The same works on
Vercel, should a check ever report that no identity reached the function: an access token
(*Account Settings → Tokens*) in `VERCEL_TOKEN` and the team's ID in `VERCEL_TEAM_ID` take the
place of the project's identity. They are then a secret to look after, which the project's
identity is not.

### What the free plans allow

Figures from the providers' plan pages on 2026-11-11, those for Sandbox on 2026-11-12
([Vercel Hobby](https://vercel.com/docs/plans/hobby), [Vercel Sandbox](https://vercel.com/docs/sandbox/pricing),
[Neon](https://neon.com/docs/introduction/plans)). They change; check them.

| Allowance per month | Free plan | What uses it |
|---|---|---|
| Vercel: requests | 1,000,000 | Every page, script and API call. A signed-in tab that is being used makes about one request a minute by itself |
| Vercel: function running time | 4 hours of processor time, 360 GB-hours of memory | Processor time is counted while the API computes; memory for as long as an instance has work in progress. The API keeps an instance busy for about a second after its last database query, to close the connection cleanly |
| Neon: database running time | 100 compute-hours, about 400 hours at the smallest size | The database runs while the site is in use and pauses after 5 minutes without queries. The first request after a pause takes a second or two longer |
| Neon: storage | 1 GB | All records and all uploaded files |
| Neon: data sent to the API | 5 GB | Every query result, and every download of an uploaded file |
| Vercel Sandbox: machines started | 5,000 | One for every program that is checked on the server, however many tests it has (Python that is only being tried runs in the browser and starts none); one for every "Check now"; one per deployment |
| Vercel Sandbox: processor time | 5 hours | Measured: 2 to 6 seconds for a small program, most of it the machine itself. Together with the line above: **some 3,000 to 5,000 programs a month** |
| Vercel Sandbox: memory | 420 GB-hours | A machine has 2 GB and is counted for at least a minute: 12,000 programs |

Vercel Sandbox has limits that are not monthly as well: on the free plan **10 machines at the same
time**, and **20 new machines a minute**, rising to 40 while they keep coming. A machine is in
use for seven to ten seconds per program. A class of forty pressing "Submit for checking" within
the same few seconds (or "Run" in a language other than Python) therefore sees "busy" for some of
them, and the page asks again by itself. Snapshots may
take up to 15 GB, which Vercel's table calls "lifetime" without saying whether that is a ceiling
or a budget that is used up; the image takes about 1 GB of it.

Nothing is charged on these plans, so a used-up allowance means **the site stops**: Vercel
suspends the feature concerned for up to 30 days (for Sandbox: no new machines, so programs are
not checked, while the rest of the site goes on), and Neon's free plan has no paid overage
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
| E-mail | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Needed for password-reset links, e-mail verification and e-mail notifications. See [Without an e-mail server](#without-an-e-mail-server) |
| AI authoring | `AI_PROVIDER=vercel-ai-gateway` (on Vercel nothing else), or `AI_PROVIDER=openai-compatible` with `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | See [The AI assistant](#the-ai-assistant). A daily limit per teacher is set in **Settings** |
| Code judge | `CODE_RUNNER_PROVIDER=vercel-sandbox` (on Vercel nothing else), or `CODE_RUNNER_PROVIDER=piston` with `CODE_RUNNER_URL`, `CODE_RUNNER_API_KEY` | Vercel Sandbox: a machine per program on your Vercel account, see [Checking students' programs](#checking-students-programs). Piston: a server you run; keep it isolated from the database and the API host |
| Map tiles | `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION` | The default is OpenStreetMap's public tile server; check its usage policy or use your own provider |

E-mail, AI authoring, a Piston server and map tiles were never exercised against a real service
during development. The Vercel Sandbox judge was, from a Vercel build; see
[TESTING.md](TESTING.md#the-code-runner-against-a-real-account) for what that covers.

### The AI assistant

Teachers can have a first draft written for them in the **AI studio**: a module, a quiz or an
examination, an assignment, a rubric. The draft is made from a topic, from a document, or from
the lessons of a module the teacher chooses, and it stays a draft until the teacher has read and
approved it. EduSphere talks to the AI service from the server; the browser never does.

**What is sent to the service:** what the teacher typed or chose — the topic, the pasted text, or
the text of the chosen module's lessons (shortened to about 24,000 characters) — and the
instructions for the draft. Names, grades, submissions and other records of students are never
sent. Choose a service whose terms your school accepts for its teaching material.

There are three ways to connect one. None of them was tried with a real service during
development, apart from Vercel's refusal described below.

| | Set | Cost | Good to know |
|---|---|---|---|
| **Vercel's AI Gateway** | `AI_PROVIDER=vercel-ai-gateway` | $5 of credit a month is included, for a part of the models. **Vercel wants a payment card on the account first**, and says it does not charge it for this | No key: on Vercel the gateway is asked with the project's own identity, as the code runner is. From another host, put a key of the gateway into `AI_API_KEY` |
| **A service with a free plan and a key** | `AI_PROVIDER=openai-compatible`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | Free within the limits of the plan, no card | You create the key in an account of your own; see the two examples below |
| **Any other OpenAI-compatible service** | the same four | As that service charges | OpenAI itself is the default address (`https://api.openai.com/v1`, model `gpt-4o-mini`) |

**Vercel's AI Gateway, in detail.** What Vercel's pages said on 2026-11-13
([pricing](https://vercel.com/docs/ai-gateway/pricing), [questions](https://vercel.com/docs/ai-gateway/faq),
[rate limits](https://vercel.com/docs/ai-gateway/rate-limits)), and what was seen:

- Without a card every request is refused, whatever the model (`403 customer_verification_required`).
  That is what this project's account answered when it was asked from a build on 2026-11-13. The
  refusal names the page for adding a card; **Settings → Server → AI assistant → Check now** shows
  it as a link.
- The monthly credit covers [a part of the models](https://vercel.com/ai-gateway/models?freeTier=true),
  with lower limits on requests per minute. On that day the small models of Anthropic, Google and
  OpenAI were not among them. EduSphere asks `meta/muse-ember` unless `AI_MODEL` names another
  one: it was on the list, cost $0.10 per million tokens read and $0.50 written — about a fifth
  of a cent for a quiz drafted from a whole module, so the $5 are some 2,500 drafts — and every
  provider behind it was listed as neither keeping what it is sent nor training on it.
- **Buying credit ends the monthly free credit**, Vercel writes. To stay free, add the card and
  buy nothing. A budget can be set in the dashboard (*AI Gateway → Budgets*).
- When the month's credit is used up, or a model is not covered, teachers are told that the
  assistant needs an administrator's attention, and the administrator sees Vercel's reason.

**Two services with a free plan,** as their own and other pages described them in November 2026.
Limits and terms change; read them before a class depends on it.

- *Google AI Studio (Gemini).* A key from <https://aistudio.google.com> needs a Google account and
  no card. `AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`, `AI_MODEL` a
  current "Flash" model from the list in AI Studio (for example `gemini-3.5-flash`). The free plan
  allows some requests a minute and some hundreds a day for each project; AI Studio shows the
  numbers. **On the free plan Google may use what is sent to improve its products, and people may
  read it** (its terms for "unpaid services"; not for users in the EEA, Switzerland and the United
  Kingdom, and not on the paid plan). That is the text of your lessons.
- *Groq.* A key from <https://console.groq.com> needs no card. `AI_BASE_URL=https://api.groq.com/openai/v1`,
  `AI_MODEL` a model from its console. The free plan counts tokens per minute, and for some models
  that is less than a whole module with its questions: teachers are then told that the request is
  more than the service takes at once, and can ask for fewer items or draft from a topic.

**Is it working?**

- **Administration → Settings → Server → AI assistant → Check now** asks the service one small
  question and shows which model answered and how quickly, or the service's own words when it
  refused. Before a check, it shows the reason the last request of a teacher failed.
- `npm run ai:check` does the same from a computer that has the configuration. The Vercel build
  runs it when `AI_PROVIDER` is set, so the log of each deployment says whether the assistant
  answers (a failure is a warning, not a failed build).
- `npm run ai:check -- --models`, or `AI_CHECK=models` for one build, lists the models of
  Vercel's gateway that suit the assistant with their prices, and tries the likely ones.

**What a teacher is told when the service says no:**

| The service | The teacher reads | Who can do something |
|---|---|---|
| is busy (`429`) | To wait a minute and try again. EduSphere has already asked a second time after a short wait | The teacher |
| takes too long, or fails | To try again | The teacher |
| finds the request too large | To ask for fewer items, or to draft from a topic or a shorter module | The teacher |
| does not accept the key, the account, the model, or has no credit left | That the assistant needs an administrator, who finds the reason under **Settings** | The administrator |

Requests that fail are not counted against the teacher's daily limit.

**Settings that matter:** `AI_MODEL`; `AI_MAX_OUTPUT_TOKENS` (8000; lower it when a model writes
less than that at once and says so); `AI_TIMEOUT_MS` for the whole exchange (two minutes; on
Vercel 100 seconds, because Vercel ends a request after 120); the daily limit per teacher under
**Settings → AI**. A model that does not take a part of the request the usual way (a temperature,
the name of the length limit, an answer promised as JSON) is asked again without that part.

### Without an e-mail server

A production site without the `SMTP_…` variables sends nothing, and says so rather than promising
a message that would never arrive:

- **Forgotten password.** The page tells the person to ask the school. An administrator opens the
  account under **Users**, chooses *Reset password* and passes on the temporary password that is
  shown once; it must be replaced at the next sign-in.
- **New accounts.** Created by an administrator (singly or from a CSV file) with a temporary
  password each, or by students themselves if self-registration is on. "E-mail a set-password
  link" is not offered.
- **E-mail verification** is not asked for, and nobody is kept out for an unverified address.
  The settings *Require e-mail verification before first sign-in* and *Send e-mail
  notifications to users who opted in* cannot be switched on.
- **Notifications** reach people inside EduSphere only.
- **Keep a second administrator account.** An administrator's password can only be reset by
  another administrator. With a single one and no e-mail, a forgotten password means nobody can
  get in to reset it; the way back is then through the database. Create the second account on
  the first day.

Nothing has to be changed when SMTP settings are added later: the pages and settings come back.

## After the first start

Sign in as the administrator. The dashboard shows **Getting your school started**: seven steps
in the order they depend on each other, each with a button that leads to the right page, each
ticked by itself once the thing exists.

1. Name the school — and check the **time zone** on the same page: it decides what "today"
   means for attendance and due dates.
2. Put your own name on the administrator account.
3. Add the school year and its semesters, and mark the current one.
4. Add the courses that are taught. Departments, programmes and sections can follow later.
5. Create the teachers' accounts, or import them from a CSV file.
6. Create the first class: a course, a semester and a teacher.
7. Let the students in: give them the class code, enrol them, or import their accounts.

The guide can be hidden and disappears when all seven are done. The registration rules and the
attendance limits are under **Settings** too.

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
