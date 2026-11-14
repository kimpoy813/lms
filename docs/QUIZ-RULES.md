# Strict rules in quizzes and examinations

A quiz or an examination can be taken under strict rules: from the moment the student starts
until they submit, they stay on the quiz page. Leaving it, copying from it, pasting into it,
pressing a screenshot key or printing it is a **violation**. A violation ends the attempt, and an
attempt that was ended counts as **failed, with 0 points**, until the class teacher reopens it.

The rules are **on for every new quiz and examination and off for practice quizzes**. The teacher
chooses for each quiz, and can allow up to five warnings before an attempt is ended.

What a web page can notice has limits, and some of them matter. They are listed under
[Limits you should know](#limits-you-should-know); read them before you rely on this for an
examination.

## For the teacher

### Setting it up

*New quiz* or *Edit* → **Fairness**:

| Setting | Meaning |
|---|---|
| Strict rules while answering | On: the rules below apply. Off: leaving the tab is only noted for you, as before |
| Warnings before an attempt is ended | 0 (the default): the first violation ends the attempt. 1 to 5: that many violations only draw a warning, and the one after them ends the attempt |

With no warnings, something the student did not choose — a pop-up of another program that takes
over the screen, a call on a phone — ends the attempt too, and you reopen it. One or two warnings
spare you most of that.

The rules bind an attempt that was **started under them**: the student read them and agreed.
An attempt that was already running when you switched them on is not bound. Switching them off
frees the attempts that are running. Changing them after students have started is written to the
audit log.

### When an attempt is ended

You get a notification that leads to the attempt, and the results page of the quiz names the
students whose attempts wait for you. Each attempt shows what was recorded, to the second, and
the answers the student had given, unmarked. You decide:

| You choose | What happens |
|---|---|
| **Reopen the attempt** | The student continues the same attempt with the answers already given. Violations are counted from zero again and the same rules apply |
| **Count the answers** | The attempt is handed in as it stands and scored like any other: what the computer can mark is marked, an essay or a file waits for you. The student gets no more time |
| **Remove attempt** | The attempt is deleted with its answers, and the student can start a new one if the quiz is still open. You are asked for a reason |
| nothing | It stays failed with 0 points |

The student is notified of the first two. Each decision is written to the audit log with your
name and what you wrote. An administrator can do everything here that the class teacher can.

### Reopening

| Field | Empty means | Otherwise |
|---|---|---|
| Time for the student (minutes) | The time that was left on the clock when the attempt was ended, and at least one minute. A quiz without a time limit gets no timer | The minutes you give |
| Must continue by (*Must finish by* when there is no timer) | Until the quiz closes. Once the quiz has closed, you have to give a time | The time you give, which may be later than the quiz closes |
| Note | | Kept with the attempt, for example why you reopened it |

**The clock starts when the student presses Continue**, not when you press Reopen: you may decide
in the evening and the student continue the next morning. An attempt that is not continued by
the time you set is handed in with the answers it has.

### What you see about an attempt

*Results → the student → What was recorded* shows, with the time of each:

- the start, and under which rules;
- every violation, with its number and what followed (a warning, or the end of the attempt);
- when the student came back, and after how long: two seconds away and ten minutes away are
  different stories;
- that the file chooser of a file-upload question was open, and for how long; the same for the
  list of a drop-down on a touch screen, where it took the focus;
- that the connection came back, and how long it had been gone (a page without a connection
  cannot say so at the time);
- that the device slept with the quiz on the screen;
- a violation that was reported late because the connection was down, with both times;
- your own decisions.

## For the student

Before a student can start, the rules are on the page of the quiz, and the Start button shows
them once more: what counts as a violation, what follows from one, and what to do first (close
other tabs and apps, switch on Do Not Disturb, charge the device). The attempt begins only with
**I understand, start**.

While answering, a line above the questions repeats the rule and says how many warnings are
left. The page asks the device to keep its screen on; where the browser refuses (a phone that
is saving its battery, an older browser), the line tells the student to keep it on themselves,
because a screen that locks by itself counts as leaving.

A warning names what was recorded and when. When the attempt is ended, the student sees what
was recorded, that the attempt counts as failed with 0 points, that only the teacher can reopen
it, and that the answers given are kept — and is told to speak to the teacher if something
outside their control caused it. They see neither the questions nor a score, and cannot start
another attempt of that quiz while this one waits.

## What counts as a violation

| The student | The page notices it by |
|---|---|
| **switched to another tab or app**, minimised the browser, or let the screen lock | the page going out of sight |
| **clicked outside the quiz window**: another window, the address bar, a pop-up | the window being without the focus for a full second |
| **closed, reloaded or left the page**, or opened it a second time in another tab, browser or device | the page being put away, or being opened again (see [below](#when-the-page-cannot-report)) |
| **copied text from the quiz**, or cut it | a copy with text of the questions selected. Nothing reaches the clipboard |
| **pasted text that was not written in the quiz**, or dragged it in | a paste into an answer of text that the student did not copy or cut from an answer of their own. The text is kept out |
| **pressed a screenshot key** | the Print Screen key; the screenshot shortcuts of macOS and Windows where the system lets the page see them, which is seldom |
| **tried to print the quiz** | the print shortcut (which is stopped) or the browser's print command. What comes out of the printer is one line saying that a quiz cannot be printed |

One act is counted once: leaving a tab also takes the focus, and may be followed by the browser
putting the page away, and that is one violation.

**Stopped without being counted.** A slip of the hand should not end an examination, so the page
stops what it can stop: the reload keys, the Back button, the right-click menu, links in a
question, dragging text out of a question, and the browser's shortcuts for finding, saving,
viewing the source and the developer tools. The browser is told to ask before it closes or
reloads the page, and not to reload it when it is pulled down on a phone; not every browser
does as it is told (see the limits). The text of the questions cannot be selected.

**Not a violation:**

- moving between questions, in any order;
- cutting, copying and pasting **within the student's own answers**, also from one answer to
  another and in the code editor of a programming question;
- running a Python program in the browser (it runs in a hidden part of the same page);
- the file chooser of a file-upload question, for up to three minutes. It is noted for the
  teacher with how long it was open;
- on a touch screen, the list of a drop-down (a matching question, the language of a program),
  which the phone draws over the page: if the browser takes the focus from the page for it,
  that is noted and not counted, for up to half a minute;
- a window that loses the focus for less than a second;
- the focus that the system's own screenshot tool or print dialog takes right after a screenshot
  key or a print command that was counted, unless the student stays away for ten seconds;
- a lost connection. Answers and reports are sent when it returns;
- a clock that jumps: the device went to sleep with the quiz on the screen and the browser said
  nothing about it. A page cannot tell that from a browser that hung, so it is noted for the
  teacher and not counted. (Where the browser does say that the screen went off or was locked,
  that is leaving the page.)

## When the page cannot report

A page that is being closed has little time to say so, and one without a connection cannot say
anything. So:

- **A report is written down in the browser first** and offered until the server has answered:
  every few seconds on the quiz page, every half minute on the other pages of the site, when
  the connection returns, and the next time the site is opened in that browser. It carries how
  long ago it happened, so the server files it at the right time and the teacher sees the time
  that was left then. The server counts a report once, however often it is sent.
- **The page tells the server each time it opens the attempt.** The first time is expected.
  A second time means the page was closed or reloaded in between. If nothing was reported about
  that — the browser was killed, the battery ran out, the attempt was opened in a second browser
  or on a second device — the opening itself is counted as "closed, reloaded or left the page".
  If leaving had already been counted and the student was not seen on the page since, it is the
  end of that absence and is not counted again.
- **Going to another page of the site** while an attempt is open is leaving the quiz page.
- A violation that is reported **after time ran out** changes nothing: the attempt was handed in
  as usual, and the report is kept for the teacher to see.

## So that nobody has to reload

Reloading counts, so the page must not make it the only way on:

- **Answers are saved as the student goes** and sent again by themselves after a lost
  connection. Nothing is lost by waiting.
- **The code editor of a programming question is a download of its own.** It is fetched when the
  attempt starts. If it cannot be fetched — the connection dropped at that moment, or a new
  version of EduSphere was installed during the examination — the program is written in a plain
  text box instead, and is saved, run and checked all the same.
- Python that will not load in the browser is run by the server's code runner, as in any quiz.

Installing a new version of EduSphere in the middle of an examination is still best avoided.

## What "failed" means

- The attempt is closed and scores **0 points**. The answers are kept as they were and are not
  marked.
- In the gradebook the attempt counts as 0 points, like any other score. Where a quiz allows
  several attempts, its own rule (the highest, the latest or the average) decides as usual, so a
  better attempt from before still counts under "highest". The 0 is in the class average of the
  quiz; the attempt is left out of the question analysis.
- The student and the teacher are notified.
- The student cannot start another attempt of that quiz, whichever attempt would count, until
  the teacher has decided.
- In the export of results the attempt reads "Ended: rule violation".

## Limits you should know

- **The checks run in the student's browser.** A student who knows how to change what a web page
  does can switch them off. Nothing on a web page can prevent that; only a locked-down
  examination browser, or a person in the room, can. The rules stop what most students would
  try and make the rest visible in the record. They do not make cheating impossible.
- **A second device, a photo of the screen, a book, another person** are invisible to a web
  page. Against a picture of the screen being passed on, the student's name and ID number (the
  e-mail address where there is no number) are printed faintly across the questions.
- **Screenshots are mostly invisible.** A page is told about the Print Screen key on some
  keyboards and systems. It is not told about a phone's screenshot buttons, about the screenshot
  shortcuts of macOS, or about a screen recorder. A screenshot tool that takes the focus for
  more than a second is counted as clicking outside the window.
- **On a phone a page learns less.** It notices switching apps, locking the screen and closing
  the page. Whether it notices a notification being pulled down or a second app in split-screen
  depends on the phone. Some phone browsers reload a page that is pulled down whatever the page
  asks, and do not ask before closing it: there a careless swipe is a violation.
- **Text that the keyboard puts in arrives like typing.** A paste from the menu or with the
  keys is noticed. The clipboard strip of a phone's keyboard, voice typing and word suggestions
  are not: the page only sees letters arriving.
- **The rules are for everyone who takes the quiz.** A student whose software takes the focus
  as it works — a screen magnifier, an on-screen keyboard, dictation — cannot be exempted
  alone. Allow warnings, or expect to reopen that student's attempt.
- **False alarms happen.** A pop-up of another program, a system dialog, a call: the page cannot
  tell them from a student who left on purpose. That is what warnings and reopening are for.
- **The file chooser is a gap of up to three minutes** in a quiz with file-upload questions:
  while it is open, the page cannot see what else the student does. The record shows how long
  it was open.
- **A window that never had the focus** — the attempt opened in a window in the background — is
  not held to have lost it until it has had it once.
- **A browser that does not say where the focus is.** If keys arrive while the browser claims
  that the page has no focus, the page stops going by the focus for the rest of the attempt,
  says so in the record, and still notices the page going out of sight. This and the allowance
  for drop-downs are there because an examination ended wrongly is worse than a click that was
  missed. The record shows each time one of them was used.
- **Being signed out** in the middle of an attempt (for example from the list of devices on the
  profile page, used on another device) takes the student off the page, and coming back counts
  as opening it a second time.
- **What was tested.** The browser tests run in Chromium on a desktop, where a tab cannot really
  be switched or a window lose the focus: those two are produced the way the page sees them.
  Keys, the clipboard, reloading, the Back button, a second browser, the file chooser and Python
  in the browser are done for real. **Nothing was tried on a real phone, in Safari or Firefox,
  or in the browser inside a chat app.** Try a short quiz with your own devices before an
  examination, and start with a warning or two.

## Privacy

- **Recorded:** the kind and the time of each violation and which key it was (for example
  "Print Screen"), when the student came back and after how long, the use of the file chooser
  or of a drop-down that took the focus, a lost connection, a device that slept, a browser that
  could not say where the focus was. Ending, reopening and counting an attempt are written to
  the audit log, as every such change is.
- **Not recorded:** no camera, no microphone, no picture of the screen, no keystrokes, not what
  was on the clipboard, not which page or program the student went to. Text that is pasted from
  outside is kept out of the answer and is not stored anywhere.
- The record belongs to the attempt and is deleted with it; the entries in the audit log and
  the notifications stay, as after any other change. A report that could not be sent yet is
  kept in the browser's own storage until it has been delivered.
- Students read the rules and agree to them before each attempt, and again before they continue
  a reopened one. The privacy notice of the app (`/privacy`) says in plain words what is
  recorded and what is not, and that the teacher can undo what the rules decided.

## Code

| What | Where |
|---|---|
| The rules (pure): kinds, what a violation leads to, the clock of a reopened attempt | `backend/src/modules/quizzes/rules.js` |
| Routes: start, `/violations`, `/open`, `/events`, `/reopen`, `/count-answers` | `backend/src/modules/quizzes/routes.js`; listed in [API.md](API.md) |
| Watching the page, keeping and sending reports | `frontend/src/lib/quizGuard.js` |
| The code editor and its plain stand-in | `frontend/src/components/LazyCodeEditor.jsx` |
| The attempt page: rules, warnings, the ended and the reopened attempt | `frontend/src/pages/classes/QuizAttempt.jsx`, `quiz/Rules.jsx` |
| The teacher's side: record, reopening, counting | `frontend/src/pages/classes/QuizResults.jsx` |
| Tests | `backend/tests/unit/quiz-rules.test.js`, `backend/tests/api/quiz-rules.test.js`, `frontend/src/lib/quizGuard.test.js`, `e2e/tests/quiz-rules.spec.js` |
