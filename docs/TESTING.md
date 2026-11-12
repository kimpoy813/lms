# Testing

| Suite | Command | Size | Needs |
|---|---|---|---|
| API and unit tests | `npm run test:backend` | 310 tests in 16 files, about a minute | Nothing: starts its own PostgreSQL |
| Web-app unit tests | `npm run test:frontend` | 22 tests in 4 files, a few seconds | Nothing |
| Both of the above | `npm test` | | |
| Browser tests | `npm run test:e2e` | 27 tests, about two minutes | A Chromium browser and the demo data |
| Lint | `npm run lint` | | |
| A running production site | `npm run smoke -- <address>` | about 30 checks, a few seconds | The site's address |

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
| `programming-ai.test.js` | Coding problems, programs inside quizzes, AI drafts and their review |
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
(`setAiTransport`, `setCodeRunnerTransport`), so those tests prove how EduSphere handles the
answers — not that a real provider or judge works. Rate limits are off in tests unless a test
sends the header `x-test-rate-limit: 1`.

Run one file with `cd backend && npx vitest run tests/api/quizzes.test.js`.

## Web-app unit tests

`frontend/src/lib/*.test.js`: date and number formatting in the institution's time zone, the
distance helper, CSV parsing, and the idle detection that pauses timed refreshing. Screens are
covered by the browser tests, not by component tests.

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

First time:

```bash
npx playwright install chromium     # downloads the browser
npm run test:e2e
```

The suite starts the app with `npm run dev` if it is not already running, and uses the demo
data. Tests create what they need and remove it again, but they do write to the development
database; run `npm run db:reset` afterwards if you want a clean demo.

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
npx vercel build                 # asks to link a project the first time; writes .vercel/output
DATABASE_URL=… node e2e/vercel/serve.mjs      # http://localhost:3900
npm run smoke -- http://localhost:3900
```

`e2e/vercel/serve.mjs` is a stand-in for Vercel's network. It applies the route table Vercel
generated from `vercel.json` (headers, rewrites, the fallback to the app page), serves the static
files, and runs the function from a copy that contains only the files Vercel would ship, on a
read-only disk, refusing request bodies over 4.5 MB. It loads the function with `require()`,
which fails when anything the entry point imports statically uses a top-level `await`, and it
reads request bodies ahead of a function that does not look like a server, as Vercel's request
helpers do. With `NODE_ENV=development` and a database that holds the demo data, the browser
tests run against it:

```bash
E2E_BASE_URL=http://localhost:3900 E2E_NO_SERVER=1 npm run test:e2e
```

Vercel does not say whether a function reached through a rewrite sees the original address or
the rewritten one; `EMULATE_URL=original` and `EMULATE_URL=rewritten` (the default) cover both.

What the stand-in cannot show: the rest of Vercel's own launcher, an instance being frozen
between requests, several instances at once, and Neon. Those need a real deployment; there,
`CRON_SECRET=… npm run smoke -- https://<your-site>` also reports how Vercel loaded the function,
which address it passed on and whether it left request bodies alone.

## What is not tested

- A real AI provider, a real code judge, a real SMTP server and real map tiles.
- Scanning a QR code with a camera. The browser tests check in by code and location.
- Browsers other than Chromium; real phones.
- Windows and macOS.
- Load and concurrency beyond a few simultaneous requests.
- Vercel and Neon under real use (see above for what was checked instead).
- Accessibility with a screen reader. Form controls have labels, and menus, dialogs and tabs work from the keyboard, but no audit was done.
