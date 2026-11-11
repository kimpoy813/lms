# Security and privacy

What EduSphere does to protect accounts and student records, and what it leaves to whoever
operates it. No independent security review has been done.

## Accounts and sessions

| Topic | How it works |
|---|---|
| Passwords | Hashed with scrypt (work factor `PASSWORD_HASH_COST`, 15 by default; old hashes are upgraded at the next sign-in). At least 10 characters; common passwords and passwords containing the user's name or e-mail are refused |
| Sign-in | The same answer for a wrong e-mail and a wrong password. After 5 failed attempts the account is locked for 15 minutes (both adjustable). Failed sign-ins are also rate-limited per address and per e-mail |
| Sessions | A random token in an `HttpOnly` cookie; only its hash is stored. Sessions last 7 days, extended while in use. A user can see and end their sessions; changing the password ends the others |
| Cookie | `Secure` whenever the request arrived over HTTPS, `SameSite=Lax`, and the `__Host-` name prefix when secure. No tokens are kept in browser storage |
| CSRF | Every changing request must come from a trusted origin (`APP_URL`, the request's own host, `CORS_ORIGINS`) **and** carry the session's token in `X-CSRF-Token` |
| Recovery | Reset links are single-use and expire. Asking for a reset never reveals whether an address has an account. An administrator can issue a temporary password that must be changed at first sign-in |
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
| Code judge | Programs that students submit are sent to the configured judge to be run |
| E-mail | Optional. Notifications by e-mail are off by default and each user opts in |
| Notifications | Old notifications are removed by the maintenance job |

The app's privacy notice (`/privacy`) tells students about location use, quiz signals and who
sees their records.

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
  Keep it on its own host or network with no access to the database.
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
