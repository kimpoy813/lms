# EduSphere

A learning management system for colleges and universities: classes, lessons, assignments,
quizzes, QR + GPS attendance, a weighted gradebook, messaging and administration — for
administrators, teachers and students.

- **Backend** — Node.js 22, Express 5, PostgreSQL through Prisma, Socket.IO
- **Web app** — React 19, React Router 7, TanStack Query, Tailwind CSS 4 (installable, works on phones)
- **Tests** — 277 API and unit tests, 19 web-app unit tests, 20 end-to-end browser tests

## Quick start

You need **Node.js 22.12 or newer**. A PostgreSQL server is optional for development.

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
| Assignments | Text and file submissions, due dates, late penalties, attempts, rubrics, feedback, returning grades, bulk download |
| Quizzes | 12 question types, question banks and random pools, import from PDF/Word/text, time limits enforced by the server, autosave, automatic and manual scoring, item analysis |
| Attendance | Sessions by code, rotating QR code and GPS geofence; manual marking, correction requests, summaries, exports. See [docs/ATTENDANCE.md](docs/ATTENDANCE.md) |
| Grades | Grading periods and weighted categories, grading scales, transmutation, overrides with reasons, history, appeals, publishing, exports. See [docs/GRADING.md](docs/GRADING.md) |
| Communication | Announcements, direct messages, class discussions, notifications (in-app, real time; e-mail optional), calendar, consultation booking |
| Insight | Dashboards per role, class analytics, at-risk indicators |
| Coding exercises | Problems with visible and hidden tests, checked by an external judge (optional) |
| AI-assisted authoring | Drafts of modules, questions, rubrics and assignments that a teacher reviews before anything reaches a class (optional) |
| Administration | Users (import from CSV), enrolment, settings, per-role permissions, audit log |

## Optional services

EduSphere runs without any of these. Nothing is simulated when a service is missing — the
feature says that it is not set up.

| Service | Configure | Without it |
|---|---|---|
| AI authoring | `AI_PROVIDER=openai-compatible`, `AI_API_KEY`, `AI_MODEL` (any OpenAI-compatible chat-completions API) | The AI studio explains that AI is not set up; no drafts are generated |
| Code judge | `CODE_RUNNER_PROVIDER=piston`, `CODE_RUNNER_URL` (a sandboxed [Piston](https://github.com/engineer-man/piston) instance) | Students can write code but not run it; programs in quizzes are marked by the teacher |
| E-mail | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | No e-mail is sent. Administrators reset passwords by issuing a temporary one. In development, messages are kept in a mailbox readable at `GET /api/dev/mailbox` from the same computer |
| Map tiles | `MAP_TILE_URL` (defaults to OpenStreetMap) | The classroom picker shows a plain grid; coordinates can be typed or taken from the device |

Student code is never executed by EduSphere itself.

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
| `SERVE_FRONTEND` | Serve the built web app from the API (one port in production) |

Institution-level options (time zone, registration rules, lockout, attendance radius limits,
at-risk thresholds, AI quota) are changed in the web app under **Settings** by an administrator.

## Project layout

```
backend/     API: src/modules/<feature>, src/services, src/middleware, prisma/ (schema, migration, seed), tests/
frontend/    Web app: src/pages, src/components, src/lib, src/layout
e2e/         Browser tests (Playwright)
scripts/     dev.mjs (one-command launcher), embedded-postgres.mjs
docs/        Architecture, deployment, security and privacy, attendance, grading, testing, API reference
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Security and privacy](docs/SECURITY.md)
- [QR + GPS attendance](docs/ATTENDANCE.md)
- [Grading](docs/GRADING.md)
- [Testing](docs/TESTING.md)
- [API reference](docs/API.md) (generated)

## Known limits

Read this before relying on EduSphere for real classes.

- **Checked only against local stand-ins.** AI authoring and the code judge were developed and
  tested against fake services, never against a real AI provider or a real Piston instance.
  E-mail was never sent through a real SMTP server.
- **Not checked at all.** Scanning a QR code with a real camera (the scan link and typing the
  code were tested), map tiles, Windows and macOS, PostgreSQL versions other than the embedded 18.
- **One API instance.** Rate limits and real-time delivery live in the memory of one process.
  Running several instances needs a shared rate-limit store and a Socket.IO adapter, which are
  not included. Uploaded files are stored on local disk.
- **GPS attendance is a deterrent, not proof.** A student who fakes the phone's location can
  pass the geofence. See [docs/ATTENDANCE.md](docs/ATTENDANCE.md) for what is and is not prevented.
- **Not included:** single sign-on, two-factor authentication, integration with a student
  information system, video conferencing, plagiarism detection, a native mobile app,
  translations (English only).
- **Database changes.** The project runs Prisma with its JavaScript engines so that no native
  binaries have to be downloaded. Creating a *new* migration with `npm run db:migrate` needs
  Prisma's native engine (unset `PRISMA_SCHEMA_ENGINE`), which was not available where this was built.
