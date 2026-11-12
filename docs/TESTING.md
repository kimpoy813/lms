# Testing

| Suite | Command | Size | Needs |
|---|---|---|---|
| API and unit tests | `npm run test:backend` | 416 tests in 22 files, about a minute | Nothing: starts its own PostgreSQL. Five of them run only on request (below) |
| Web-app unit tests | `npm run test:frontend` | 40 tests in 6 files, a few seconds | Nothing |
| Both of the above | `npm test` | | |
| Browser tests | `npm run test:e2e` | 33 tests, about three minutes | A Chromium browser and the demo data |
| Lint | `npm run lint` | | |
| A running production site | `npm run smoke -- <address>` | about 30 checks, a few seconds | The site's address |
| The code runner on a real Vercel account | `npm run judge:check` | 29 checks, about a minute | Vercel credentials; starts eight machines ([below](#the-code-runner-against-a-real-account)) |

## API and unit tests

`backend/tests/unit/` tests the pure rules — grade computation, late penalties, quiz scoring and
question validation, the geofence, password hashing, time-zone helpers, upload type checks and
HTML sanitising. `backend/tests/api/` sends real
HTTP requests to the application against a real PostgreSQL database, one file per area:

| File | Covers |
|---|---|
| `auth.test.js` | Sign-in and lockout, registration, e-mail verification, password reset, sessions, CSRF, rate limits, security headers |
| `admin.test.js` | Users, catalogue, grading scales, settings, audit log, administrator-only areas |
| `classes.test.js` | Classes, join codes, enrolment requests, bulk enrolment, class-list privacy, archiving |
| `content.test.js` | Modules and lessons, resources and file access, announcements, notifications |
| `assignments.test.js` | The submission window (server clock), submitting, grading and returning |
| `quizzes.test.js` | Question types, attempts, server-kept time, scoring, results, item analysis |
| `attendance.test.js` | Sessions, QR tokens, the geofence, refused attempts, corrections, exports |
| `gradebook.test.js` | Structure, computation, overrides, publishing, locking, finalising, appeals |
| `communication.test.js` | Direct messages, class discussions, calendar, consultations, tasks, search |
| `dashboard.test.js` | Dashboards and analytics |
| `forms.test.js` | Requests shaped the way the web app's forms send them, with every optional field present and empty. A date left empty is no date — it was once stored as 1 January 1970, which the other files could not notice because they leave optional fields out |
| `first-day.test.js` | A new installation: the administrator's set-up guide, and a site without an e-mail server (what it tells people, what it refuses to promise, which settings it will not switch on) |
| `migrations.test.js` | Migrations through the adapter production uses: a file is applied whole (a semicolon in a comment ends nothing) and completely or not at all; a failed one is found, explained and can be let through again; what the data-only migrations change |
| `programming-ai.test.js` | Coding problems, programs inside quizzes, AI drafts and their review |
| `code-runner.test.js` | The API with programs checked in Vercel Sandbox machines, Vercel's SDK replaced by a pretend account: one machine per submission, only the inputs uploaded, a verdict per test, a judge that is busy, being prepared or out of its allowance (what a student is told, what the administrator is told), the checks for the administrator and for the operator, a quiz handed in while the judge is busy |
| `serverless.test.js` | The application as it runs on a function platform: files kept in the database (whole and partial downloads, quota, clean-up), background jobs claimed by requests and by the scheduled call, work that outlives a response, the Vercel entry point |

`backend/tests/unit/hosting.test.js` covers what is easy to break without noticing: how a
database address turns into connection options (TLS on, certificate checked), which failures
count as "the database is away", and that `vercel.json` still matches the application — the
security headers it sends for pages are compared with the ones the API sends.

How the database is provided (`backend/tests/setup/global.js`):

- by default a private PostgreSQL is started from the `embedded-postgres` package in a temporary
  directory and removed afterwards;
- with `TEST_DATABASE_URL` set, a throw-away database is created on that server and dropped at
  the end.

Your development database is never touched. On a fresh checkout the suite also generates the
database client (`prisma generate`) if it is missing.

The whole suite can be pointed at another way of running:

| Run | Checks |
|---|---|
| `STORAGE_DRIVER=database npm run test:backend` | Every test that uploads or downloads, with the files kept in PostgreSQL |
| `TEST_DATABASE_URL='postgresql://…?sslmode=require' npm run test:backend` | Against a server that only accepts encrypted connections (with `NODE_EXTRA_CA_CERTS` for a private certificate authority) |

The AI provider and the code judge are replaced by fakes inside the tests
(`setAiTransport`, `setCodeRunnerTransport`, `setSandboxSdk`), so those tests prove how EduSphere
handles the answers — not that a real provider or judge works. For the Vercel Sandbox judge that
proof is a separate run against a real account
([below](#the-code-runner-against-a-real-account)). Rate limits are off in tests unless a test
sends the header `x-test-rate-limit: 1`.

Two unit files belong to the code runner:

- `judge-sandbox.test.js` drives `services/judge/vercelSandbox.js` against the pretend account
  (`tests/helpers/fakeSandbox.js`): which machine it asks for, what it uploads, how it reads the
  answer, and everything about the prepared image — missing, being installed, failed, expired,
  incomplete — including that a request never replaces a young image and a deployment replaces
  it only once.
- `judge-runner.test.js` runs the program that works inside the machine
  (`services/judge/vmRunner.mjs`) **for real**: Python and C programs are compiled and started on
  the computer the tests run on (tests are skipped where `python3` or `gcc` is missing). By
  default that happens without root, in a temporary folder. The part that needs root — the
  program gets a user without rights and kernel limits — creates a user called `judge-run` and
  the folder `/judge` on that computer, so it runs only on request:

  ```bash
  cd backend && JUDGE_TEST_ISOLATED=1 npx vitest run tests/unit/judge-runner.test.js   # needs sudo without a password
  ```

Run one file with `cd backend && npx vitest run tests/api/quizzes.test.js`.

## Web-app unit tests

`frontend/src/lib/*.test.js`: date and number formatting in the institution's time zone, the
distance helper, CSV parsing, the idle detection that pauses timed refreshing, and the rules for
making photos smaller (which files, to what size, what the person is told — the redrawing itself
needs a browser and is in the browser tests). Screens are covered by the browser tests, not by
component tests.

## Browser tests

Playwright drives the real web app with the demo accounts (`e2e/tests/`):

| File | Covers |
|---|---|
| `auth.spec.js` | Sign-in, sign-out, returning to the requested page, what each role may not open |
| `attendance.spec.js` | A session that requires location: a student inside the radius is checked in with the typed code, one far away and one without a location are refused; the teacher sees the attempts |
| `announcements.spec.js` | A teacher posts to a class; a student in it sees the post, a student outside does not |
| `quiz.spec.js` | A student takes a quiz and sees the score; the answer key is not sent while the attempt is open |
| `smoke.spec.js` | Every main page and class tab opens for each role without errors or sideways scrolling; the sign-in page on a phone-sized screen |
| `live.spec.js` | A new message appears in an open conversation and a check-in on the teacher's attendance monitor without reloading — pushed over a socket, or fetched on a timer when the server cannot push |
| `documents.spec.js` | An uploaded file comes back byte for byte (whole and in part), an oversized one is refused, the gradebook and attendance export as PDF and spreadsheet, a test paper in PDF form is read into questions |
| `first-day.spec.js` | What a new school meets first: the set-up guide ticks a step when the thing is done; replacing a temporary password leads to the dashboard, and a refused password names the word to leave out; a module and an assignment are created with every date left empty; a meeting that takes only a code opens check-in on the code; "forgot password" on a site without e-mail; a photo as a phone stores it arrives smaller and upright, a long screenshot untouched |

First time:

```bash
npx playwright install chromium     # downloads the browser
npm run test:e2e
```

The suite starts the app with `npm run dev` if it is not already running, and uses the demo
data. Tests create what they need and remove it again, but they do write to the development
database — and an account cannot be deleted, only anonymised, so each run leaves one erased
account in the user list. Run `npm run db:reset` afterwards if you want a clean demo.

Two of the `first-day.spec.js` tests change one answer of the server on its way to the page
(`emailEnabled`, and the size above which photos are reduced), because a development server keeps
e-mail in its mailbox and reduces only what it would refuse. What the server itself answers in
production without e-mail is covered by `first-day.test.js` and was looked at in a production
build ([below](#the-vercel-build-locally)).

Options (environment variables):

| Variable | Meaning |
|---|---|
| `E2E_BASE_URL` | Where the web app is served (default `http://localhost:5173`) |
| `E2E_NO_SERVER=1` | Never start the app; fail if it is not running |
| `E2E_CHROMIUM_PATH` | Use this Chromium instead of the one Playwright downloads |
| `E2E_CHROMIUM_ARGS` | Extra browser flags, separated by spaces (for example `--no-sandbox` in a container) |

## The Vercel build, locally

`vercel.json`, the build step and the function entry point can be exercised without deploying:

```bash
export NODE_OPTIONS=--experimental-require-module   # as in the Vercel project; see below
npx vercel build                 # asks to link a project the first time; writes .vercel/output
DATABASE_URL=… node e2e/vercel/serve.mjs      # http://localhost:3900
npm run smoke -- http://localhost:3900
```

`e2e/vercel/serve.mjs` is a stand-in for Vercel's network. It applies the route table Vercel
generated from `vercel.json` (headers, rewrites, the fallback to the app page), serves the static
files, and runs the function from a copy that contains only the files Vercel would ship, on a
read-only disk, refusing request bodies over 4.5 MB. Three things it copies from Vercel's
Node.js runtime, each of which stopped or would have stopped the real site:

- **`require()` of an ES module is refused** unless `NODE_OPTIONS=--experimental-require-module`
  is set, as it must be in the Vercel project. Without it the function answers
  `503 STARTUP_FAILED`, and `vercel build` itself stops with the explanation.
- **With that variable, the entry point is loaded with `require()`**, which fails when anything
  it imports statically uses a top-level `await`. Without it, with `import()`.
- **Request bodies are read ahead of a function that does not look like a server**, as Vercel's
  request helpers do unless `NODEJS_HELPERS=0`.

With `NODE_ENV=development` and a database that holds the demo data, the browser tests run
against it:

```bash
E2E_BASE_URL=http://localhost:3900 E2E_NO_SERVER=1 npm run test:e2e
```

A function reached through a rewrite is given the address the browser asked for, with the
rewrite's query parameters added. Vercel does not document that, so the application also accepts
the rewritten address: `EMULATE_URL=rewritten` checks that form (`original` is the default).

What the stand-in cannot show: the rest of Vercel's own launcher, an instance being frozen
between requests, several instances at once, and Neon. Those need a real deployment; there,
`CRON_SECRET=… npm run smoke -- https://<your-site>` also reports how Vercel loaded the function,
which address it passed on and whether it left request bodies alone.

## The code runner against a real account

`scripts/judge-image.mjs` uses the real service: it makes sure the machine image exists and runs
a small program in every language (the Vercel build does that on every deployment that has
`CODE_RUNNER_PROVIDER=vercel-sandbox`). With `--full` (`npm run judge:check`) it also runs, in
real machines, what a judge has to withstand, and fails when a single check does:

| Language | Checked |
|---|---|
| Python | runs; an endless loop is stopped at the time limit; 400 MB with a 64 MB limit is refused; a process bomb is held; endless output is cut; **the tests, the job, system files, `sudo` and the network are out of reach**; an error trace is readable; the next test is not disturbed |
| C | runs; a segmentation fault and a division by zero are named; the exit code is passed on |
| C++ | runs; sorts two million numbers in time; 600 MB with a 128 MB limit is refused |
| Java | runs with a class that is not called `Main`; heap beyond the limit is refused; deep recursion has room; non-English characters are printed |
| JavaScript | runs; heap beyond the limit is refused; an endless loop is stopped |
| | the limits also hold without kernel control groups; a compile error is reported in the compiler's words |

It needs to be somebody on the Vercel account: inside a Vercel build that is the build itself;
elsewhere set `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`, or `VERCEL_OIDC_TOKEN`
from `vercel env pull`. It starts eight machines for a few seconds each.

**What was run.** On 2026-11-12, in preview builds of the branch that introduced the judge, on a
free-plan account, region `sin1`: the image was prepared in 44 seconds (1,103 MB as a snapshot),
every check above passed, limits were enforced by kernel control groups, and a check of five
languages took 5.1 seconds from start to answer.

**What that run does not show.**

- *The deployed function.* A build has its identity in its environment; a function gets it with
  each request. `CRON_SECRET=… npm run smoke -- https://<your-site>` has the live site start a
  machine and reports which identity it used; "Check now" under Administration → Settings does
  the same for an administrator.
- *Many students at once*, against the limits of the plan.
- *An image that expired*: what Vercel answers then is taken from its SDK, and the repair was
  only exercised against the pretend account.

## What is not tested

- A real AI provider, a real Piston server, a real SMTP server and real map tiles.
- Scanning a QR code with a camera. The browser tests check in by code and location.
- Browsers other than Chromium; real phones. This includes making photos smaller: a picture
  drawn in Chromium with a phone's orientation note was used, not a file from a camera, and
  Safari on an iPhone was never tried. A browser that cannot redraw a picture sends it as it is.
- Windows and macOS.
- Load and concurrency beyond a few simultaneous requests. For the code runner that includes a
  class pressing "Run" at the same time.
- Vercel and Neon under real use (see above for what was checked instead).
- Accessibility with a screen reader. Form controls have labels, and menus, dialogs and tabs work from the keyboard, but no audit was done.
