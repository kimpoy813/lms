# EduSphere

A learning management system for colleges and universities: classes, lessons, assignments,
quizzes, QR + GPS attendance, a weighted gradebook, messaging and administration — for
administrators, teachers and students.

- **Backend** — Node.js 22 or newer, Express 5, PostgreSQL through Prisma, Socket.IO
- **Web app** — React 19, React Router 7, TanStack Query, Tailwind CSS 4 (installable, works on phones)
- **Hosting** — one Node.js server, or Vercel with a Neon database ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md))
- **Tests** — 539 API and unit tests, 312 web-app unit tests, 59 end-to-end browser tests ([docs/TESTING.md](docs/TESTING.md))

## Quick start

You need **Node.js 22.12 or newer** (tested with 22, 24 and 26). A PostgreSQL server is optional for development.

```bash
npm install
npm run dev
```

Open <http://localhost:5173> and sign in with a demo account (below).

`npm run dev` does everything a first run needs, and is safe to repeat:

1. creates `backend/.env` from `backend/.env.example` if it is missing;
2. starts a PostgreSQL server from the `embedded-postgres` npm package when nothing is listening
   on the port in `DATABASE_URL` (data is kept in `.local/postgres`);
3. applies the database migrations and loads the demo data;
4. runs the API on port 4000 and the web app on port 5173, both reloading on changes.

To use your own PostgreSQL (14 or newer), set `DATABASE_URL` in `backend/.env` first.

Recent npm versions do not run the install scripts of dependencies unless you approve them.
EduSphere does not need them: `npm run dev` and `npm test` prepare what those scripts would
have (checked with npm 10 and npm 12 on Linux).

### Demo accounts

The password of every demo account is `Demo-Pass-2026`.

| Role | E-mail | Notes |
|---|---|---|
| Administrator | `admin@edusphere.demo` | |
| Teacher | `teacher@edusphere.demo` | teaches IT 101 and CS 201 |
| Teacher | `teacher2@edusphere.demo` | teaches GE 105 |
| Student | `student@edusphere.demo` | also `student2` … `student10@edusphere.demo` |
| Teacher (pending) | `pending.teacher@edusphere.demo` | waits for an administrator's approval |

Demo accounts cannot sign in when `NODE_ENV=production`. For a real installation, set
`SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` and run `npm run db:seed` once: it creates the first
administrator, who must change the password at first sign-in.

## What is included

| Area | Features |
|---|---|
| Accounts | Sign-in with lockout, self-registration (students; teachers on approval), password reset, e-mail verification (optional), sessions per device, profile and avatar |
| Classes | Academic catalogue (terms, departments, programmes, courses, sections), join codes, enrolment requests, class list, archiving |
| Learning content | Modules and lessons with a rich-text editor, attachments, video embeds, prerequisites, scheduled publishing, progress tracking, bookmarks, class library |
| Assignments | Text and file submissions (photos from a phone are made smaller before they are sent), due dates, late penalties, attempts, rubrics, feedback, returning grades, bulk download |
| Quizzes | 12 question types, question banks and random pools, import from PDF/Word/text, time limits enforced by the server, autosave, automatic and manual scoring, item analysis |
| Strict rules in quizzes and examinations | Leaving the quiz page, copying, pasting, a screenshot key or printing ends the attempt as failed with 0 points; the teacher sees what was recorded and can reopen it, count its answers or remove it. On for quizzes and examinations, off for practice; up to five warnings can be allowed first. What a web page can and cannot notice: [docs/QUIZ-RULES.md](docs/QUIZ-RULES.md) |
| Attendance | Sessions by code, rotating QR code and GPS geofence; manual marking, correction requests, summaries, exports. See [docs/ATTENDANCE.md](docs/ATTENDANCE.md) |
| Grades | Grading periods and weighted categories, grading scales, transmutation, overrides with reasons, history, appeals, publishing, exports. See [docs/GRADING.md](docs/GRADING.md) |
| Communication | Announcements, direct messages, class discussions, notifications (in-app, real time; e-mail optional), calendar, consultation booking |
| Insight | Dashboards per role, class analytics, at-risk indicators |
| Coding exercises | Problems with visible and hidden tests in Python, Java, C, C++ and JavaScript. Python that a student is only trying out runs in the student's own browser, as often as they like. What counts is run and checked outside EduSphere: in throw-away machines on Vercel, or by a judge server you run (optional) |
| AI-assisted authoring | Drafts of modules, quizzes, examinations, rubrics and assignments, from a topic, a document or a module the teacher chooses. A teacher reviews every draft before anything reaches a class (optional) |
| Administration | A set-up guide for a new school, users (import from CSV), enrolment, settings, per-role permissions, audit log |

## Optional services

EduSphere runs without any of these. Nothing is simulated when a service is missing — the
feature says that it is not set up.

| Service | Configure | Without it |
|---|---|---|
| AI authoring | On Vercel: `AI_PROVIDER=vercel-ai-gateway`, nothing else (Vercel wants a payment card on the account first). Or any OpenAI-compatible chat-completions API: `AI_PROVIDER=openai-compatible` with `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`. [The choices, and what is free](docs/DEPLOYMENT.md#the-ai-assistant) | The AI studio explains that AI is not set up; no drafts are generated |
| Code judge | On Vercel: `CODE_RUNNER_PROVIDER=vercel-sandbox`, nothing else ([how it works](docs/DEPLOYMENT.md#checking-students-programs)). Or `CODE_RUNNER_PROVIDER=piston` with `CODE_RUNNER_URL` (a sandboxed [Piston](https://github.com/engineer-man/piston) instance) | Students can write code but not run it; programs in quizzes are marked by the teacher |
| E-mail | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | No e-mail is sent, and the site says so instead of promising one: “Forgot password” tells people to ask the school, administrators issue temporary passwords, addresses are not verified, and the settings that need e-mail cannot be switched on. In development, messages are kept in a mailbox readable at `GET /api/dev/mailbox` from the same computer |
| Map tiles | `MAP_TILE_URL` (defaults to OpenStreetMap) | The classroom picker shows a plain grid; coordinates can be typed or taken from the device |

Student code is never executed on EduSphere's server. Python that a student is trying out runs in
that student's own browser, shut into a sandbox that can reach neither the site nor the network
([how](docs/SECURITY.md#python-in-the-browser)); an administrator can switch that off under
**Settings → Programming**.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Database, migrations, demo data, API and web app (see above). `-- --no-seed` skips the demo data, `-- --api-only` skips the web app |
| `npm run build` | Builds the web app into `frontend/dist` |
| `npm start` | Runs the API. With `SERVE_FRONTEND=true` it also serves `frontend/dist` |
| `npm test` | API and unit tests, then the web-app unit tests |
| `npm run test:e2e` | Browser tests (see [docs/TESTING.md](docs/TESTING.md)) |
| `npm run lint` | ESLint |
| `npm run db:embedded` | Only the embedded PostgreSQL |
| `npm run db:deploy` | Applies pending migrations |
| `npm run db:seed` | Loads the demo data and creates the first administrator (does nothing if they exist) |
| `npm run db:reset` | **Deletes all data**, re-creates the tables and loads the demo data. Asks first; refuses in production. `-- --yes` skips the question |
| `npm run docs:api` | Regenerates [docs/API.md](docs/API.md) from the route definitions |
| `npm run smoke -- <address>` | Checks a running production site from outside: pages, security headers, API, database |

## Configuration

All settings are environment variables, documented in [`backend/.env.example`](backend/.env.example).
Real environment variables take precedence over `backend/.env`. The most important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection |
| `APP_URL` | Public address of the web app: used in e-mail links, QR codes and as a trusted origin |
| `NODE_ENV` | `production` switches off demo accounts and development helpers |
| `TRUST_PROXY` | Set when the API is behind a reverse proxy |
| `STORAGE_DIR` | Where uploaded files are kept (outside the web root) |
| `STORAGE_DRIVER` | `disk` (default) or `database`, for hosts without a lasting disk |
| `SERVE_FRONTEND` | Serve the built web app from the API (one port in production) |

On Vercel none of these needs to be set; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#vercel-and-neon).

Institution-level options (time zone, registration rules, lockout, attendance radius limits,
at-risk thresholds, AI quota) are changed in the web app under **Settings** by an administrator.

## Project layout

```
backend/     API: src/modules/<feature>, src/services, src/middleware, prisma/ (schema, migrations, seed), tests/
frontend/    Web app: src/pages, src/components, src/lib, src/layout
api/         The API as a Vercel Function (entry point only)
e2e/         Browser tests (Playwright); vercel/serve.mjs runs a Vercel build locally
scripts/     dev.mjs (one-command launcher), embedded-postgres.mjs, vercel-build.mjs, smoke.mjs, ai-check.mjs
docs/        Architecture, deployment, security and privacy, attendance, grading, quiz rules, testing, API reference
vercel.json  Build, routing and security headers on Vercel
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Security and privacy](docs/SECURITY.md)
- [QR + GPS attendance](docs/ATTENDANCE.md)
- [Grading](docs/GRADING.md)
- [Strict rules in quizzes and examinations](docs/QUIZ-RULES.md)
- [Testing](docs/TESTING.md)
- [API reference](docs/API.md) (generated)

## Python in the browser: whose software it is

The Python that runs in students' browsers is [Pyodide](https://pyodide.org) 314.0.7: CPython
3.14 built for WebAssembly. Its files are served as they come in the `pyodide` npm package,
unchanged. Pyodide is distributed under the Mozilla Public License 2.0 and its source is at
<https://github.com/pyodide/pyodide>; CPython and the libraries built into it come under their
own licences, which that project lists.

## Known limits

Read this before relying on EduSphere for real classes.

- **Checked only against local stand-ins.** AI authoring and the Piston judge were developed and
  tested against fake services, never against a real AI provider or a real Piston instance.
  Vercel's AI Gateway was asked for real once, from a build, and refused every model until a
  payment card is on the account ([what was seen](docs/TESTING.md#the-ai-assistant-against-a-real-account)).
  E-mail was never sent through a real SMTP server.
- **Python in the browser is close to the server's Python, not identical.** It is the same
  language version (3.14) built for the browser. Programs that use files, threads, the network or
  third-party packages, and results that can differ between the two (the order of a set, the last
  digits of a decimal number, very deep recursion, memory limits) are handed to the server's code
  runner instead of being judged in the browser. Tried in Chromium only; the first run downloads
  about 13 MB (less where the host compresses). "Submit for checking" and quiz answers never rely on it.
- **The Vercel Sandbox judge was run for real, but not by a class.** From a Vercel build it
  prepared its machine image and passed `scripts/judge-image.mjs --full` on a real account (all
  five languages, and the programs a judge has to withstand; see [docs/TESTING.md](docs/TESTING.md#the-code-runner-against-a-real-account)).
  What that does not show: forty students pressing "Run" in the same minute against the limits
  of Vercel's free plan (ten machines at a time, twenty new ones a minute, some 3,000 to 5,000
  programs a month). `npm run smoke` checks the code runner of your own site.
- **Not checked at all.** Scanning a QR code with a real camera (the scan link and typing the
  code were tested), map tiles, Windows and macOS, PostgreSQL versions other than 18.
- **One API instance on a server.** Rate limits and real-time delivery live in the memory of one
  process. Running several instances needs a shared rate-limit store and a Socket.IO adapter,
  which are not included. Uploaded files are stored on local disk, or in the database.
- **On Vercel the application gives things up:** files of at most 4 MB (300 MB in total by
  default), screens that refresh every few seconds instead of at once, timed work that waits for
  the next visitor, looser rate limits. The free plans of Vercel and Neon stop the site when a
  monthly allowance runs out. This setup was checked against the output of Vercel's own build
  tool, served by a local stand-in — not under real use.
  See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#vercel-and-neon).
- **Photos are reduced, not kept.** Where space is short (on Vercel: above 1 MB) a JPEG, PNG or
  WebP picture is redrawn in the browser at 2048 pixels on its long side and saved as JPEG; the
  original never reaches the server. Fine for a photographed page, wrong for a drawing that has
  to stay exact: send that as a PDF, or raise `REDUCE_PHOTOS_OVER_MB`. Tried in Chromium only.
- **GPS attendance is a deterrent, not proof.** A student who fakes the phone's location can
  pass the geofence. See [docs/ATTENDANCE.md](docs/ATTENDANCE.md) for what is and is not prevented.
- **The strict rules of a quiz are a deterrent, not a locked room.** They are checked by the
  student's own browser: a second device, a photo of the screen and most ways of taking a
  screenshot are invisible to a web page, a phone tells a page less than a computer does, and a
  student who knows how can switch the checks off. A pop-up or a call can end an honest
  student's attempt, which is why the teacher can allow warnings and reopen attempts. Tried in
  Chromium on a desktop only, never on a real phone.
  See [docs/QUIZ-RULES.md](docs/QUIZ-RULES.md#limits-you-should-know).
- **Not included:** single sign-on, two-factor authentication, integration with a student
  information system, video conferencing, plagiarism detection, a native mobile app,
  translations (English only).
- **Database changes.** The project runs Prisma with its JavaScript engines so that no native
  binaries have to be downloaded. Creating a *new* migration with `npm run db:migrate` needs
  Prisma's native engine (unset `PRISMA_SCHEMA_ENGINE`), which was not available where this was built.
