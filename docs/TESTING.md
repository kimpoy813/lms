# Testing

| Suite | Command | Size | Needs |
|---|---|---|---|
| API and unit tests | `npm run test:backend` | 539 tests in 28 files, about a minute and a half | Nothing: starts its own PostgreSQL. Five of them run only on request (below) |
| Web-app unit tests | `npm run test:frontend` | 312 tests in 11 files, about ten seconds | Nothing |
| Both of the above | `npm test` | | |
| Browser tests | `npm run test:e2e` | 59 tests in 12 files, about six minutes | A Chromium browser and the demo data |
| Lint | `npm run lint` | | |
| A running production site | `npm run smoke -- <address>` | about 30 checks, a few seconds | The site's address |
| The code runner on a real Vercel account | `npm run judge:check` | 29 checks, about a minute | Vercel credentials; starts eight machines ([below](#the-code-runner-against-a-real-account)) |

## API and unit tests

`backend/tests/unit/` tests the pure rules — grade computation, late penalties, quiz scoring and
question validation, the strict rules of a quiz (what a violation leads to, the clock of a
reopened attempt), the geofence, password hashing, time-zone helpers, upload type checks and
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
| `quiz-rules.test.js` | [Strict rules](QUIZ-RULES.md): an attempt starts only with the rules accepted; a violation draws the warnings the quiz allows and then ends the attempt with 0 points and its answers unmarked; a report sent twice, sent late, or from before a reopening; the quiz page opened a second time; what the student and the teacher are shown and told; reopening (the time left, the time by which to continue, the clock that starts with Continue), counting the answers, the gradebook, the audit log, who may do what |
| `attendance.test.js` | Sessions, QR tokens, the geofence, refused attempts, corrections, exports |
| `gradebook.test.js` | Structure, computation, overrides, publishing, locking, finalising, appeals |
| `communication.test.js` | Direct messages, class discussions, calendar, consultations, tasks, search |
| `dashboard.test.js` | Dashboards and analytics |
| `forms.test.js` | Requests shaped the way the web app's forms send them, with every optional field present and empty. A date left empty is no date — it was once stored as 1 January 1970, which the other files could not notice because they leave optional fields out |
| `first-day.test.js` | A new installation: the administrator's set-up guide, and a site without an e-mail server (what it tells people, what it refuses to promise, which settings it will not switch on) |
| `migrations.test.js` | Migrations through the adapter production uses: a file is applied whole (a semicolon in a comment ends nothing) and completely or not at all; a failed one is found, explained and can be let through again; what the data-only migrations change |
| `programming-ai.test.js` | Coding problems, programs inside quizzes, what the web app is told about trying Python in the browser. AI drafts and their review; drafts from a module the teacher chose: which lessons are used, how the room is shared between them, that a module of another teacher is refused and an empty one is said to be empty, that the model is told the purpose and the questions that exist already |
| `ai-gateway.test.js` | The assistant inside a Vercel Function, through the function's real entry point, asking a pretend AI Gateway that is a small server inside the test: the request really leaves the application and its answer is really read. The project's identity is the one that came with the request, read anew each time, and one of another project is not passed on; each refusal Vercel documents (no payment method, no credit, a budget, a model outside the free credit, a restriction of the team) becomes the right sentence for the teacher and the right detail for the administrator; a busy service is asked once more, within the time that is left; a service that never answers is given up on; a model that refuses a part of the request is asked again without it; requests that failed are not counted against the teacher; the administrator's check; a link is passed on only when it leads to vercel.com |
| `code-runner.test.js` | The API with programs checked in Vercel Sandbox machines, Vercel's SDK replaced by a pretend account: one machine per submission, only the inputs uploaded, a verdict per test, a judge that is busy, being prepared or out of its allowance (what a student is told, what the administrator is told), the checks for the administrator and for the operator, a quiz handed in while the judge is busy |
| `code-runner-vercel.test.js` | The same judge inside a Vercel Function, through the function's real entry point, with Vercel's part played by the test: the machines are started with the identity token that came with the request (also when the request's body arrives late, and without mixing several requests at once); a token of another project starts nothing; the token never shows in an answer; the machine is removed after the answer where the platform keeps the function awake, and before it where it does not; machines that were never removed are deleted by the daily job |
| `serverless.test.js` | The application as it runs on a function platform: files kept in the database (whole and partial downloads, quota, clean-up), background jobs claimed by requests and by the scheduled call, work that outlives a response, the Vercel entry point and what it notes about each request |

`backend/tests/unit/hosting.test.js` covers what is easy to break without noticing: how a
database address turns into connection options (TLS on, certificate checked), which failures
count as "the database is away", and that `vercel.json` still matches the application — the
security headers it sends for pages, and the different ones for the frame Python programs run in,
are compared with the ones the API sends. Also that no `.env` file is read on Vercel or travels
with the function.

`ai-provider.test.js` and `ai-config.test.js` cover the AI service without a database: what each
refusal means, how one request is asked and its answer read, which configuration switches the
assistant on (a key, or Vercel's gateway on Vercel), that the time it is given on Vercel is less
than Vercel gives the request (read from `vercel.json`), and that the identity of the Vercel
project is sent to Vercel's gateway and nowhere else, whatever `AI_BASE_URL` says.

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
(`setAiTransport`, `setCodeRunnerTransport`, `setSandboxSdk`, and in `ai-gateway.test.js` a
pretend service on the same computer), so those tests prove how EduSphere handles the answers —
not that a real provider or judge works. For the Vercel Sandbox judge that proof is a separate
run against a real account ([below](#the-code-runner-against-a-real-account)); for the AI
assistant there is none yet ([below](#the-ai-assistant-against-a-real-account)). Rate limits are off in tests unless a test
sends the header `x-test-rate-limit: 1`.

Two unit files belong to the code runner:

- `judge-sandbox.test.js` drives `services/judge/vercelSandbox.js` against the pretend account
  (`tests/helpers/fakeSandbox.js`): which machine it asks for, what it uploads, how it reads the
  answer, and everything about the prepared image — missing, being installed, failed, expired,
  incomplete — including that a request never replaces a young image and a deployment replaces
  it only once. Also whose identity starts the machines: which token is used when several are
  around, and that one of another project, or one whose time is over, stops everything.
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
distance helper, CSV parsing, the idle detection that pauses timed refreshing, the rules for
making photos smaller (which files, to what size, what the person is told — the redrawing itself
needs a browser and is in the browser tests), when a program is run in the browser and what the
student is told about it (`codeRunner.test.js`), and the service worker with a pretend browser
around it (`serviceWorker.test.js`: what it keeps, and that it leaves the API and the frame for
Python programs alone). `quizGuard.test.js` drives the watcher of a quiz with
[strict rules](QUIZ-RULES.md) with a pretend browser window: what is counted (leaving, losing
the focus for a second, closing, copying, pasting, the screenshot and print keys), what is only
stopped (reload, Back, shortcuts, the right-click menu, links), what is left alone (the
student's own text, the file chooser, the list of a drop-down on a touch screen, a short loss
of focus, a device that slept, a browser that does not say where the focus is), that one act is
counted once, that the screen is kept on or the student told when it cannot be, and that a
report is kept until the server has it. Screens are covered by the
browser tests, not by component tests.

`frontend/src/lib/pyRunner/` has the tests of [Python in the browser](#python-in-the-browser).

## Browser tests

Playwright drives the real web app with the demo accounts (`e2e/tests/`):

| File | Covers |
|---|---|
| `auth.spec.js` | Sign-in, sign-out, returning to the requested page, what each role may not open |
| `attendance.spec.js` | A session that requires location: a student inside the radius is checked in with the typed code, one far away and one without a location are refused; the teacher sees the attempts |
| `announcements.spec.js` | A teacher posts to a class; a student in it sees the post, a student outside does not |
| `quiz.spec.js` | A student takes a quiz and sees the score; the answer key is not sent while the attempt is open |
| `quiz-rules.spec.js` | [Strict rules](QUIZ-RULES.md) from both sides. The student reads the rules before starting; leaving the page ends the attempt, and the questions and the score are gone; the teacher sees what was recorded and reopens; the student continues with the answers already given and the time that was left. Pasting from outside draws the warning the quiz allows and a screenshot key then ends the attempt, while reload and Back are only stopped; reloading for real and a second browser; another page of the site; the file chooser; a programming question, where the student's own code is cut, pasted and run in the browser and code from elsewhere is counted; the same question when the code editor cannot be downloaded, answered in a plain text box without a reload; a quiz without the rules; a phone-sized screen; the teacher's settings. Leaving a tab and losing the focus are produced the way the page sees them (headless Chromium has one tab that always has the focus); keys, the clipboard, reloading, Back, the second browser, the file chooser and Python are real |
| `smoke.spec.js` | Every main page and class tab opens for each role without errors or sideways scrolling; the sign-in page on a phone-sized screen |
| `live.spec.js` | A new message appears in an open conversation and a check-in on the teacher's attendance monitor without reloading — pushed over a socket, or fetched on a timer when the server cannot push |
| `documents.spec.js` | An uploaded file comes back byte for byte (whole and in part), an oversized one is refused, the gradebook and attendance export as PDF and spreadsheet, a test paper in PDF form is read into questions |
| `code-runner.spec.js` | The three screens of the code runner, with the server's answers replaced on their way to the page (the development server has no judge): a busy checker is asked again by the page, the student sees why it takes longer, and a limit that was hit is told in words; one that stays busy is given up after three more tries, and one that is being prepared is explained at once; the administrator's "Check now" shows every language with its version, the language that failed, or the reason in full; the problem editor says when a slow program cannot get through all tests |
| `python-in-browser.spec.js` | Python in a real browser, on the practice problem of the demo data: the sample tests run without the server being asked; a program the browser cannot run faithfully goes to the server by itself, "Run on the server instead" and "Submit for checking" always do, and so does C++; the frame opened by itself with a student's session has no origin, no cookies, no storage and no network; the administrator's switch sends everything to the server again |
| `ai-studio.spec.js` | The assistant's screens, with the model's answers written by the test (the development server has no AI service): an examination drafted from a module becomes a draft quiz of the chosen questions, an assignment is saved into the module; what a teacher reads when the service refuses, and that the choices made stay; the administrator's "Check now" with Vercel's refusal, its link, a link that leads elsewhere (not shown), and an answer |
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

The function gets its configuration from the environment it is started in, as on Vercel: no
`.env` file is read there, and `vercel.json` keeps such files out of the function, so the
`backend/.env` of your development server takes no part (it once did, and uploads failed for a
folder that file named).

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

## Python in the browser

A Python program that is only being tried runs in the student's browser. Three things have to
hold: the browser's Python gives the answers the server's Python gives, the program cannot leave
its sandbox, and the page knows when it must ask the server instead.

| What | Where | How |
|---|---|---|
| The same answers | `frontend/src/lib/pyRunner/runtime.test.js` | 94 programs (`fixtures/programs.js`: reading input every way a beginner does, printing, syntax errors, every way a program can end, errors and their tracebacks, numbers and their formatting, text, lists, dictionaries and sets, classes, generators, recursion that ends and recursion that does not, the standard library a first course uses, long output) are run by the code the web app runs them with, on Pyodide under Node.js. What the server's checker says about each is in `fixtures/reference.json`, written by `node scripts/python-reference.mjs` with the checker's own runner and CPython 3.14.4. The two must agree on output, error output and outcome — or the web app must have noticed that it has to ask the server |
| Knowing when to ask the server | the same file, and `index.test.js` with the sandbox played by the test | Programs that use files, threads, sockets, packages outside Python's library, or the machine's number sizes; failures that can be the browser's own; answers wrong only by the order of a set or the last digits of a decimal number; a browser without what Python needs; Python that cannot be fetched or does not start |
| The same comparison and limits as the server | `judge.test.js` | Imports the server's own `backend/src/lib/judging.js` and compares: every pair of outputs in every comparison mode, where long output is cut, how many tests are run at most. Also the wording of each outcome |
| Stopping a program that does not end | `index.test.js` | The sandbox is taken away after three times the problem's limit; what was printed is kept; later tests are not run |
| The sandbox | `e2e/tests/python-in-browser.spec.js`, `backend/tests/unit/hosting.test.js` | In Chromium: the frame has no origin, cookies and storage are refused, `fetch` is refused. The headers that do this are compared between the API and `vercel.json` |

`node scripts/python-reference.mjs --check` compares the reference with the Python on the
computer it runs on, and says so when that is another version than the one recorded.

**What was done by hand,** on 2026-11-13, in Chromium against the development server and against
the built app behind the local stand-in for Vercel: a correct program, a wrong one, a runtime
error (the traceback names `main.py` and the line), a syntax error, own input, a program handed
to the server, an endless loop (stopped after 9.2 seconds with its earlier output kept), a loop
of four million steps (1.1 seconds). The first run took 2.5 seconds including the download from
the same computer, later ones 0.16 seconds. In the built app the frame was served with its own
policy, the pages with theirs, and Python's files were identical to the package's. During
development about 240,000 results of mathematical functions were also compared with CPython
3.14.4 once; that comparison is not part of the suite.

**What that does not show:** browsers other than Chromium, real phones (speed and memory), a
slow connection for the first 13 MB, and the site on Vercel itself.

## The AI assistant against a real account

`scripts/ai-check.mjs` (`npm run ai:check`) asks the configured AI service one small question,
the way the application asks for a draft. The Vercel build runs it when `AI_PROVIDER` is set.
With `--models` it also reads the catalogue of Vercel's AI Gateway, lists the models that suit
the assistant and tries the likely ones.

**What was run.** On 2026-11-13, in a preview build on this project's free-plan account, with
the project's own identity and no key: the catalogue was read (511 models, 119 of them suitable),
and every model that was tried, the ones without a price included, was refused with
`403 customer_verification_required`: Vercel wants a payment card on the account before its free
credit can be used. Nothing was charged and no credit was used. Vercel answers `401` to a
missing or invalid identity and answered `403` here, so the project's identity was taken as a
valid way of asking; and what the gateway answers to an account without a card is known.

**What has not been run:** a single request that a model answered. Everything about answers —
that the drafts are usable, how long they take, what they cost, whether the model EduSphere asks
by default is covered by the free credit when the request is made — is tested against pretend
services only. After a card is added, or a key of another service is set, "Check now" under
Administration → Settings and the build log say whether the assistant answers.

## The code runner against a real account

`scripts/judge-image.mjs` uses the real service: it makes sure the machine image exists and runs
a small program in every language (the Vercel build does that on every deployment that has
`CODE_RUNNER_PROVIDER=vercel-sandbox`). With `--full` (`npm run judge:check`) it also runs, in
real machines, what a judge has to withstand, and fails when a single check does:

| Language | Checked |
|---|---|
| Python | runs; an endless loop is stopped at the time limit; 400 MB with a 64 MB limit is refused; a process bomb is held; endless output is cut; **the tests, the job, system files, `sudo` and the network are out of reach**; a crash is explained with its line; the next test is not disturbed |
| C | runs; a segmentation fault and a division by zero are named; the exit code is passed on |
| C++ | runs; sorts two million numbers in time; 600 MB with a 128 MB limit is refused |
| Java | runs with a class that is not called `Main`; heap beyond the limit is refused; deep recursion has room; non-English characters are printed |
| JavaScript | runs; heap beyond the limit is refused; an endless loop is stopped |
| | the limits also hold without kernel control groups; a program that does not compile is answered in the compiler's words |

At the end it lists what is left on the account — the images, their snapshots and whether the
image in use is kept for good — and deletes machines of single programs that an earlier run or
the site left behind.

It needs to be somebody on the Vercel account: inside a Vercel build that is the build itself;
elsewhere set `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`, or `VERCEL_OIDC_TOKEN`
from `vercel env pull`. It starts eight machines for a few seconds each.

**What was run.** On 2026-11-12 and 2026-11-13, in preview builds of the branch that introduced
the judge, on a free-plan account, region `sin1`: the image was prepared in 44 to 50 seconds
(1.0 to 1.1 GB as a snapshot), every check above passed, limits were enforced by kernel control
groups, and a check of five languages took 5.1 seconds from start to answer. The account agreed
to keep the image until it is deleted, the build's identity was the one of the project Vercel
named, and no machine was left on the account afterwards. The production build that followed the
merge (2026-11-13) found the image in place, passed the five languages again (6.8 seconds for the
check: one second for the machine, one for the upload, the rest for compiling and running) and
removed the image of the earlier recipe.

**What that run does not show.**

- *The deployed function.* A build has its identity in its environment; a function gets it with
  each request. How the function takes it from the request is tested with Vercel's part played
  by the test (`code-runner-vercel.test.js`) and was tried in the built function behind the local
  stand-in; that Vercel sends it shows only on a live site.
  `CRON_SECRET=… npm run smoke -- https://<your-site>` has the live site start a machine and
  reports which identity it used; "Check now" under Administration → Settings does the same for
  an administrator.
- *Many students at once*, against the limits of the plan.
- *An image that went missing*: what Vercel answers then is taken from its SDK, and the repair
  was only exercised against the pretend account.

## What is not tested

- A real AI provider answering ([above](#the-ai-assistant-against-a-real-account)), a real Piston
  server, a real SMTP server and real map tiles.
- Python in the browser outside Chromium, and on Vercel itself.
- Scanning a QR code with a camera. The browser tests check in by code and location.
- Browsers other than Chromium; real phones. This includes making photos smaller: a picture
  drawn in Chromium with a phone's orientation note was used, not a file from a camera, and
  Safari on an iPhone was never tried. A browser that cannot redraw a picture sends it as it is.
- The strict rules of a quiz on a real phone, in Safari or Firefox, or in the browser inside a
  chat app; a person really switching tabs or windows; a real screenshot tool or print dialog.
  What a page is told differs between browsers and systems, which is why the
  [limits](QUIZ-RULES.md#limits-you-should-know) say to try a short quiz on your own devices
  first.
- Windows and macOS.
- Load and concurrency beyond a few simultaneous requests. For the code runner that includes a
  class pressing "Run" at the same time.
- Vercel and Neon under real use (see above for what was checked instead).
- Accessibility with a screen reader. Form controls have labels, and menus, dialogs and tabs work from the keyboard, but no audit was done.
