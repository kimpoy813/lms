# QR + GPS attendance

A teacher opens an attendance session for a class meeting. Students check in from their own
phones. The server — never the phone — decides whether a check-in counts.

## For the teacher

When opening a session the teacher chooses:

| Option | Meaning |
|---|---|
| Start and end time | Check-ins are accepted only inside this window |
| Late after | Check-ins after this time are recorded as **late** instead of **present** |
| QR code | Students scan the code shown on the teacher's screen |
| Code | Students type a short code (for phones whose camera cannot scan) |
| Require location | The student's phone must report a position inside the classroom's radius |
| Classroom and radius | A saved classroom location and a radius within the limits set by the administrator |

The live screen shows who has checked in, and — for each refused attempt — why it was refused
and how far away the phone reported to be. When the session ends (the teacher closes it, or its
end time passes) every enrolled student without a record is marked **absent**.

The teacher can always mark or change a student by hand. Marking someone present in a
location-verified session, or changing a record after the session closed, requires a written
reason and is written to the audit log. Students can file a correction request, which the
teacher approves or declines.

## What happens during a check-in

1. **The credential.** The student scans the QR code or types the code. The server checks that
   the session is open, inside its time window, allows that method, and that the student is
   enrolled in the class.
2. **The location**, if the session requires it. The browser asks for permission and sends the
   position and its accuracy. The server then checks, in this order:
   - the reading has valid coordinates and an accuracy value — otherwise it is refused;
   - the accuracy is no worse than the allowed limit (default 100 m) — otherwise the student is
     asked to try again, because presence is never assumed from a vague reading;
   - the great-circle distance to the classroom is within the radius — otherwise the check-in is
     refused and the student is told the distance.
3. **The record.** One record per student and session. A second check-in returns the existing
   record.

Every refused attempt is stored with its reason, and shown to the teacher. After eight refused
attempts within a minute a student has to wait.

### The QR code

- The code contains the session id, a time-window counter and a signature made with a secret
  that never leaves the server. It cannot be forged or predicted.
- It rotates (default every 20 seconds; the administrator can choose 15–60 seconds or switch
  rotation off). A code is accepted during its own window and the next one, so a slow scan still
  works but a photo sent to a friend stops working within about 40 seconds.
- Scanning it with the phone's own camera opens the web app on the check-in screen; scanning
  inside the app works too.
- After a successful scan the student has three minutes to complete the location step without
  scanning again.

## Privacy

- **Coordinates are not stored.** The student's position is used once, in memory, to compute the
  distance. Only the distance and the reported accuracy are saved.
- Even those are erased after the retention period (setting *Keep location verification data
  for*, default 180 days), together with the refused attempts. The attendance status itself is kept.
- Students never receive the classroom's coordinates, only the radius.
- Location is requested only at the moment of a check-in, and only when the session requires it.
  There is no tracking.
- The privacy notice in the app (`/privacy`) explains this to students in plain language.

## Limits you should know

- **A faked location passes.** A student who uses a developer tool or an app that makes the
  phone report false coordinates can satisfy the geofence. A web application cannot detect this
  reliably. The rotating QR code is what requires someone to be in the room at that moment, so
  use **QR and location together** when it matters. The combination raises the effort; it does
  not make cheating impossible.
- **A student in the room can relay the code** to someone who also fakes their location.
- **Indoor positioning is imprecise.** Inside buildings phones often report an accuracy of
  30–100 m or worse. With a small radius, honest students will be refused. Choose a radius that
  fits the building (the default is 50 m) and keep the typed code and manual marking as a fallback.
- **Browsers only give a location on secure pages.** The web app must be served over HTTPS
  (or from `localhost` during development), and the student must allow location access.
- **The camera scanner was not tested with a real camera** during development; the scan link
  and the typed code were.

## Settings

Administrators set these under **Settings → Attendance**:

| Setting | Default |
|---|---|
| Default geofence radius | 50 m |
| Smallest / largest radius a teacher may set | 10 m / 300 m |
| Least accurate GPS reading accepted | 100 m |
| QR code rotation interval | 20 s |
| Keep location verification data for | 180 days |

Whether attendance may count toward grades is a separate setting (*Attendance may count toward
grades*, off by default). See [GRADING.md](GRADING.md).

## Code

| What | Where |
|---|---|
| Distance and geofence decision | `backend/src/lib/geo.js` |
| QR tokens, check-in, closing sessions | `backend/src/modules/attendance/service.js` |
| Endpoints | `backend/src/modules/attendance/routes.js` |
| Erasing old location data | `backend/src/jobs/maintenance.js` |
| Tests | `backend/tests/api/attendance.test.js`, `backend/tests/unit/core.test.js`, `e2e/tests/attendance.spec.js` |
