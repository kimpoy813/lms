# Security and privacy

What EduSphere does to protect accounts and student records, and what it leaves to whoever
operates it. No independent security review has been done.

## Accounts and sessions

| Topic | How it works |
|---|---|
| Passwords | Hashed with scrypt (work factor `PASSWORD_HASH_COST`, 15 by default; old hashes are upgraded at the next sign-in). At least 10 characters; common passwords and passwords containing the user's name or e-mail are refused, and the message names the word to leave out |
| Sign-in | The same answer for a wrong e-mail and a wrong password. After 5 failed attempts the account is locked for 15 minutes (both adjustable). Failed sign-ins are also rate-limited per address and per e-mail |
| Sessions | A random token in an `HttpOnly` cookie; only its hash is stored. Sessions last 7 days, extended while in use. A user can see and end their sessions; changing the password ends the others |
| Cookie | `Secure` whenever the request arrived over HTTPS, `SameSite=Lax`, and the `__Host-` name prefix when secure. No tokens are kept in browser storage |
| CSRF | Every changing request must come from a trusted origin (`APP_URL`, the request's own host, `CORS_ORIGINS`) **and** carry the session's token in `X-CSRF-Token` |
| Recovery | Reset links are single-use and expire. Asking for a reset never reveals whether an address has an account. An administrator can issue a temporary password that must be changed at first sign-in. A site without an e-mail server answers every request for a reset link alike — "this site does not send e-mail" — which reveals nothing about accounts either; there, e-mail verification cannot be required and is not enforced |
| Registration | Students may register themselves; teachers can request an account that an administrator approves. Both can be switched off |
| Demo accounts | Refused when `NODE_ENV=production` |

## Who can see what

- **Roles.** Administrator, teacher, student. Every endpoint checks the role and then the
  caller's relation to the record: a teacher sees only their own classes, a student only classes
  they are enrolled in. A class someone does not belong to answers "not found".
- **Students never see** other students' grades, submissions, attendance or quiz attempts.
  Whether students see the class list is a per-class choice. Messaging between students is off
  by default.
- **Unpublished work** (drafts, scheduled items, unreturned grades, answer keys) is filtered on
  the server, not hidden in the browser. The answer key of a quiz is not sent while an attempt is open.
- **Permissions.** An administrator can switch a set of capabilities on or off per role (for
  example exporting grades, downloading submissions, using AI, creating classes).
- **Audit log.** Sign-ins and changes to accounts, classes, grades, attendance and settings are
  recorded with who, when and from which address. The log can be searched and exported by
  administrators and cannot be edited through the application.

## Input and output

| Topic | How it works |
|---|---|
| Validation | Every request is parsed against a schema; unknown fields are dropped |
| SQL | All queries go through Prisma with parameters |
| Rich text | Everything typed into an editor, and all AI output, is sanitised on the server before it is stored. Scripts, event handlers and unknown tags are removed. Video frames may only come from YouTube and Vimeo |
| Browser policy | Content-Security-Policy without inline scripts, `frame-ancestors 'self'`, `nosniff`, a restrictive Permissions-Policy (location and camera for the app itself only), HSTS in production |
| Uploads | Accepted only if the extension is on the allow-list **and** the content matches it. Stored outside the web root, or in the database, under random names. Served only after a permission check, as a download or — for a few safe types — in a sandboxed preview. Size limit `MAX_UPLOAD_MB` |
| Rate limits | Per user or address: general API use, sign-in, uploads, check-ins, messages, AI requests, code runs |
| Errors and logs | Unexpected errors return a generic message with a request id. Cookies, passwords, tokens and API keys are removed from logs |
| API responses | Sent with `Cache-Control: no-store`; the service worker never caches them |
| Database connection | A database address with `sslmode=require` (or stricter) is encrypted and the server's certificate is verified; only `sslmode=no-verify` skips the check |
| Scheduled call | `GET /api/internal/cron` runs the background jobs on hosts without a timer. With `CRON_SECRET` set it requires that secret; without one it only runs jobs that are due anyway, which any request does |

## Personal data

| Data | Handling |
|---|---|
| Location (attendance) | Coordinates are used once to compute a distance and are **not stored**. The distance, the reported accuracy and refused attempts are erased after the retention period (default 180 days). See [ATTENDANCE.md](ATTENDANCE.md) |
| Quiz integrity signals | Leaving the tab during a quiz is recorded for the teacher and announced to the student beforehand. It is informational; nothing is decided automatically |
| Accounts that leave | An administrator can deactivate an account, or anonymise it: name, e-mail, ID number and profile are replaced and notifications, tasks and bookmarks deleted, while grades and attendance stay for the institution's records. What the person wrote — submissions, messages, discussion posts — is kept as written and may still identify them |
| AI | Only what a teacher types or attaches for a draft is sent to the AI provider. No AI feature sends student records. The key stays on the server |
| Code judge | A program a student runs or submits is sent to the configured judge with the test inputs and the limits. Nothing that says whose it is goes with it: no name, no account, no class. The expected outputs are never sent; the API compares. See [Running students' programs](#running-students-programs) |
| E-mail | Optional. Notifications by e-mail are off by default and each user opts in |
| Notifications | Old notifications are removed by the maintenance job |

The app's privacy notice (`/privacy`) tells students about location use, quiz signals and who
sees their records.

## Running students' programs

A program written by a student is code from a stranger. It is never run by the API or on its
host. What happens instead, with `CODE_RUNNER_PROVIDER=vercel-sandbox`
(`backend/src/services/judge/`):

| Risk | What stands against it |
|---|---|
| The program attacks the site, its database or its secrets | It runs in a virtual machine of its own at Vercel (a Firecracker microVM), made for this one submission and deleted afterwards. Nothing of the site is in it: no credentials, no connection to the database, no environment of the API |
| It reaches other computers: to send data out, to fetch a solution, to attack somebody | The machine is created with the network policy `deny-all`: no outbound connections, no name resolution. Checked by `scripts/judge-image.mjs --full` |
| It reads the tests it is going to be checked with | The expected outputs never leave the API. The inputs are in the machine, in a file and a folder only root can read; the program runs as a user without any rights (no groups, no `sudo`: the kernel's no-new-privileges flag is set) and gets each input on its standard input, one at a time |
| It changes the compiled program, the report or the runner between tests | After compiling, the build folder belongs to root and is read-only for the program. The report is written by the runner when nothing of the program is running any more, into a folder the program cannot write to |
| It uses up the machine: endless loop, memory, processes, output | Every compilation and every test has its own limits: time (the problem's limit; 50 s for all tests together), memory (kernel control group, with the problem's limit plus room for the language's runtime), 64 processes, 64 KB of output, files of at most 32 MB. Whatever a test leaves running is ended before the next one starts. Where control groups are not available the runner falls back to per-process limits, with approximate memory limits for Java and JavaScript |
| A program made to look like it passed | The verdict is made by the API from what the program printed, against outputs the program never saw |
| The site is made to use machines on somebody else's Vercel account, prepared to report whatever suits them | On Vercel the machines are started with the project's identity token, which Vercel sends along with each request. EduSphere uses a token only when it was issued to the project Vercel names as the deployment's own (`VERCEL_PROJECT_ID`); any other token that arrives with a request stops the check instead of being used or passed over. It does not rely on Vercel removing such a header when a visitor sends one, which Vercel's documentation does not promise |
| The identity token ends up in a log, an error report or an answer | The function's entry point takes it out of the request before the application sees the request, and hands it to the code runner only. It is valid for about an hour and never stored |
| The site's Vercel account is used up | Each user may start 20 runs a minute. Vercel's plan limits what all of them can use together; see [DEPLOYMENT.md](DEPLOYMENT.md#what-the-free-plans-allow) |

What remains:

- **Hidden tests leak slowly, as with any judge.** A program sees the input of the test it is
  run on, and the student sees whether each hidden test passed, was too slow or crashed. Someone
  determined can ask yes-or-no questions about a hidden input with every submission. Hidden
  tests keep honest students from hard-coding answers; they are not a secret store.
- **Time is measured on shared hardware.** The same program can take a little longer or shorter
  from one run to the next. Leave room in time limits.
- **The administrator's check and the operator's check** (`POST /api/admin/code-runner/check`,
  and `GET /api/internal/code-runner-check` opened by a value derived from `CRON_SECRET`) each
  start one machine. The second exists so that a deployment can be checked without signing in;
  without `CRON_SECRET` it does not exist.
- **Vercel is a processor of what is sent**: the program and the test inputs. See its terms
  before using this with real students.
- **A project that hides its system variables** (*Settings → Environment Variables →
  Automatically expose System Environment Variables* switched off) does not tell the function
  which project it is, and the identity token can then not be compared with it.
  `npm run smoke` says so.

## What the operator must do

- **Serve over HTTPS.** Cookies, geolocation and the camera depend on it.
- **Keep `NODE_ENV=production`** on real installations: it disables demo accounts and the
  development mailbox, and enables HSTS.
- **Set `TRUST_PROXY`** correctly behind a reverse proxy; otherwise rate limits and the audit log
  see the proxy's address instead of the user's. (On Vercel this is set by itself.)
- **Back up** the database and the upload directory, and protect the backups: they contain
  student records. When files are kept in the database, the database backup contains them too.
- **On Vercel, treat preview deployments as production.** Unless they have a database of their
  own they read and write the live records. They are behind Vercel's own sign-in by default;
  keep it that way. Set `CRON_SECRET`.
- **Run the code judge isolated.** EduSphere never runs student code itself, but the judge does.
  A Piston server belongs on its own host or network with no access to the database. With Vercel
  Sandbox the machines are Vercel's, started with the identity of your Vercel project: whoever
  can deploy code to the project can start them, as they can do anything else in its name.
- **Decide what may go to an AI provider** before enabling it, and tell teachers.
- **Check local law.** In the Philippines the Data Privacy Act of 2012 applies to student
  records and location data. EduSphere provides controls (retention, anonymising, an audit log,
  a privacy notice); it does not make an institution compliant by itself.

## Known gaps

- No two-factor authentication and no single sign-on.
- No encryption of uploaded files at rest beyond what the disk or the database provides.
- Rate limits are kept in memory per process, so they reset on restart and are not shared
  between instances. On Vercel, where instances come and go, they are correspondingly weaker;
  the lockout of an account after failed sign-ins is kept in the database and is not affected.
- On Vercel the security headers of pages come from `vercel.json` and those of API responses
  from the application. A test fails when the two differ, but a header changed in the Vercel
  dashboard would not be noticed.
- A faked GPS position passes the attendance geofence. See [ATTENDANCE.md](ATTENDANCE.md).
- The development mailbox (`/api/dev/mailbox`, never in production) holds password-reset links.
  It answers only requests made on the same computer, but a development server should still not
  be exposed to the internet with real accounts in it.
- No antivirus scanning of uploads.

## Reporting a problem

Please report security problems privately to the maintainers of this repository rather than in
a public issue.
