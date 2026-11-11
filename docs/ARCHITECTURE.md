# Architecture

EduSphere is one PostgreSQL database, one Node.js API process and one single-page web app.

```
 Browser (React SPA)
    │  HTTPS: JSON under /api, WebSocket under /socket.io, session cookie
    ▼
 API process (Express 5 + Socket.IO + background jobs)
    │                         │                    │
    ▼                         ▼                    ▼
 PostgreSQL (Prisma)    Local disk (uploads)   Optional: SMTP, AI provider, code judge
```

In development the web app is served by Vite on port 5173, which forwards `/api` and
`/socket.io` to the API on port 4000, so the browser only talks to one origin. In production
either a reverse proxy does the same, or the API serves the built web app itself
(`SERVE_FRONTEND=true`).

## Repository

| Path | Contents |
|---|---|
| `backend/src/modules/<feature>/` | One folder per feature: routes, and the domain logic behind them |
| `backend/src/services/` | Cross-cutting services: settings, permissions, audit, notifications, mail, storage, real time, scheduler, AI, code runner |
| `backend/src/middleware/` | Sessions and CSRF, validation, rate limits, error handling |
| `backend/src/lib/` | Pure helpers: grading and quiz scoring, geodesy, sanitising, file-type checks, exports (CSV, XLSX, PDF) |
| `backend/prisma/` | `schema.prisma` (74 models), the migration, `seed.js` |
| `backend/tests/` | `unit/` (pure logic) and `api/` (HTTP against a real PostgreSQL) |
| `frontend/src/pages/` | Screens, grouped by area (`classes/`, `admin/`, `auth/`, …) |
| `frontend/src/components/` | Shared UI: form controls, dialogs, tables, rich-text editor, map, QR scanner, code editor |
| `frontend/src/lib/` | API client, date and number formatting in the institution's time zone, query helpers |
| `e2e/` | Playwright tests |

## Backend

### A request, step by step

1. **Security headers** (Helmet): Content-Security-Policy, `frame-ancestors`, `nosniff`, HSTS in production.
2. **Session**: the cookie is looked up (hashed) in the `Session` table; `req.user` is set.
3. **Rate limit** per signed-in user, or per address when nobody is signed in.
4. **CSRF**: every request that changes something must come from a trusted origin and carry the session's CSRF token.
5. **Validation**: route parameters, query and body are parsed with zod schemas. Unknown fields are dropped; errors come back as `422` with a message per field.
6. **Access**: role guards, then membership — every class-scoped route loads the caller's relation to the class. A class the caller does not belong to answers `404`.
7. **Handler**, usually inside a database transaction.
8. **Errors** are turned into `{ "error": { "code", "message", "details" } }`. Unexpected errors are logged with the request id and answered with a generic message.

Responses are `{ "data": …, "meta": … }`. The full list of endpoints is generated from the route
definitions: [API.md](API.md).

### Rules that live in exactly one place

| Rule | Where |
|---|---|
| Grade computation | `modules/gradebook/compute.js` (pure, unit-tested) |
| Recording a grade and its history | `recordGrade` in `modules/gradebook/service.js` |
| Quiz scoring and what a student may see of a question | `lib/quizScoring.js` |
| Whether something is published | `lib/visibility.js` (evaluated at read time, so a scheduled item appears on time even if the background job is late) |
| Geofence decision | `lib/geo.js` |
| HTML that users may store | `lib/sanitize.js` |
| Accepted upload types | `lib/fileTypes.js` |

### Data model

The schema is in `backend/prisma/schema.prisma`. The main groups:

- **People**: `User`, `Session`, `AuthToken`, `StudentProfile`, `TeacherProfile`, `Permission`, `RolePermission`
- **Catalogue**: `Department`, `AcademicProgram`, `AcademicYear`, `Semester`, `Course`, `Section`, `GradingScale`
- **Classes**: `Class`, `ClassSchedule`, `Enrollment`, `ClassInvitation`
- **Content**: `LearningModule`, `Lesson`, `LearningResource`, `LessonProgress`, `Bookmark`, `File`
- **Assessment**: `Assignment`, `AssignmentSubmission`, `Rubric`, `QuestionBank`, `Question`, `Quiz`, `QuizAttempt`, `StudentAnswer`, `ProgrammingProblem`, `ProgrammingSubmission`
- **Attendance**: `ClassroomLocation`, `AttendanceSession`, `AttendanceRecord`, `AttendanceAttempt`, `AttendanceCorrectionRequest`
- **Grades**: `GradingPeriod`, `GradeCategory`, `GradeItem`, `GradeEntry`, `GradeHistory`, `GradeOverride`, `FinalGrade`, `GradeAppeal`
- **Communication**: `Announcement`, `Notification`, `Conversation`, `Message`, `DiscussionThread`, `CalendarEvent`, `ConsultationSlot`
- **System**: `AuditLog`, `SystemSetting`, `AIGenerationRequest`, `AIGeneratedModule`

Two design points worth knowing:

- **A quiz attempt stores a snapshot of each question.** Editing a question later does not change
  what a student was asked or how the attempt was scored.
- **Most records are never hard-deleted.** Accounts are deactivated or anonymised, classes are
  archived, questions are soft-deleted, and foreign keys are `RESTRICT`, so grades and history
  cannot disappear as a side effect.

### Background jobs

Jobs run inside the API process (`services/scheduler.js`). Each one claims its work with a
conditional update, so running it twice, or on two instances, does no harm.

| Job | Every | What it does |
|---|---|---|
| `quiz.autoSubmit` | 30 s | Submits attempts whose time ran out while the student was away |
| `attendance.autoClose` | 1 min | Closes attendance sessions after their end time and marks the remaining students absent |
| `publishing` | 1 min | Publishes scheduled items, sends their notifications and deadline reminders |
| `maintenance` | 1 h | Removes expired sessions and tokens, orphaned uploads, location data past its retention period, and old notifications |

Set `SCHEDULER_ENABLED=false` to run an instance without jobs.

### Real time

Socket.IO shares the session cookie with the REST API. Events: `notification:new`,
`message:new`, `message:read`, `message:deleted`, and `attendance:update` for the teacher's live
attendance screen. Every screen also works without a socket: data is re-fetched when a screen is
opened and after each action.

### Files

Uploads go to `STORAGE_DIR` under random names and are only readable through `/api/files`, which
checks on every request that the caller may see the record the file belongs to. To use object
storage instead, replace the four functions marked "storage backend" in `services/storage.js`.

### External services

Each one sits behind a small service with a replaceable transport, which is how the tests fake it:

| Service | File | When it is not configured |
|---|---|---|
| E-mail (SMTP) | `services/mail.js` | Messages are kept in a development mailbox; nothing is sent |
| AI provider | `services/ai.js` | `503 AI_UNAVAILABLE` |
| Code judge | `services/codeRunner.js` | `503 CODE_RUNNER_UNAVAILABLE`; programs in quizzes go to manual grading |

## Web app

- **Routing**: `src/App.jsx` lists every route. `Protected` requires a session, `Only` restricts by role. Heavy screens (editor, charts, map, code editor) are loaded on demand.
- **Server data**: TanStack Query. Reads use `useQuery` with the API client in `src/lib/api.js`; writes use the `useAction` helper, which shows the result, maps field errors onto the form and refreshes what changed.
- **Session**: `src/auth/AuthContext.jsx` loads the session once, keeps the CSRF token in memory and sends it with every write. Nothing is kept in `localStorage` except the colour theme.
- **Dates**: all dates are shown in the institution's time zone (`src/lib/format.js`), not the device's, so "due 11:59 PM" means the same for everyone.
- **User-written HTML** is rendered only through `components/RichText.jsx`. It was sanitised by the server when it was stored, and the Content-Security-Policy forbids inline scripts.
- **Offline**: a service worker caches the application shell only. API responses are never cached, so no private data is left on a shared computer.
- **Styling**: Tailwind CSS 4 with theme tokens in `src/index.css` (light and dark).

## Why these choices

| Choice | Reason |
|---|---|
| Session cookie, not a token in the browser | An HTTP-only cookie cannot be read by injected script, and a session can be ended on the server at once |
| PostgreSQL only | Transactions and constraints protect grades and attendance; one service to operate |
| Jobs in the API process | No queue or second service to run for a single institution |
| Prisma's JavaScript engines | Installation needs no native binary downloads |
| Pure functions for grading, scoring and geofencing | The rules that matter most can be tested without a database |
