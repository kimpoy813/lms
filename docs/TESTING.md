# Testing

| Suite | Command | Size | Needs |
|---|---|---|---|
| API and unit tests | `npm run test:backend` | 277 tests in 14 files, about a minute | Nothing: starts its own PostgreSQL |
| Web-app unit tests | `npm run test:frontend` | 19 tests in 3 files, a few seconds | Nothing |
| Both of the above | `npm test` | | |
| Browser tests | `npm run test:e2e` | 20 tests, about two minutes | A Chromium browser and the demo data |
| Lint | `npm run lint` | | |

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

How the database is provided (`backend/tests/setup/global.js`):

- by default a private PostgreSQL is started from the `embedded-postgres` package in a temporary
  directory and removed afterwards;
- with `TEST_DATABASE_URL` set, a throw-away database is created on that server and dropped at
  the end.

Your development database is never touched.

The AI provider and the code judge are replaced by fakes inside the tests
(`setAiTransport`, `setCodeRunnerTransport`), so those tests prove how EduSphere handles the
answers — not that a real provider or judge works. Rate limits are off in tests unless a test
sends the header `x-test-rate-limit: 1`.

Run one file with `cd backend && npx vitest run tests/api/quizzes.test.js`.

## Web-app unit tests

`frontend/src/lib/*.test.js`: date and number formatting in the institution's time zone, the
distance helper, CSV parsing. Screens are covered by the browser tests, not by component tests.

## Browser tests

Playwright drives the real web app with the demo accounts (`e2e/tests/`):

| File | Covers |
|---|---|
| `auth.spec.js` | Sign-in, sign-out, returning to the requested page, what each role may not open |
| `attendance.spec.js` | A session that requires location: a student inside the radius is checked in with the typed code, one far away and one without a location are refused; the teacher sees the attempts |
| `announcements.spec.js` | A teacher posts to a class; a student in it sees the post, a student outside does not |
| `quiz.spec.js` | A student takes a quiz and sees the score; the answer key is not sent while the attempt is open |
| `smoke.spec.js` | Every main page and class tab opens for each role without errors or sideways scrolling; the sign-in page on a phone-sized screen |

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

## What is not tested

- A real AI provider, a real code judge, a real SMTP server and real map tiles.
- Scanning a QR code with a camera. The browser tests check in by code and location.
- Browsers other than Chromium; real phones.
- Windows and macOS.
- Load and concurrency beyond a few simultaneous requests.
- Accessibility with a screen reader. Form controls have labels, and menus, dialogs and tabs work from the keyboard, but no audit was done.
