# Importing questions

A teacher who already has the questions — typed in a file, written by a chat assistant, sent by a
colleague, downloaded from another class — does not type them in again. They paste them as **JSON**
(or choose a file), look at what was read, and add them to the quiz. Every question arrives with
its **answer key**, so the quiz can be marked by the computer right away.

**Nothing is saved until the teacher has seen the questions.** The import first shows each question
with the answer it read, marks the ones it was not sure about, and stores them only when the
teacher presses *Add*.

## In short

1. Open the quiz or examination (*Classes → the class → Quizzes → New quiz*, then *Create and add
   questions*).
2. Beside **Questions**, press **Import**.
3. Paste the JSON into the box, or choose a file. Press **Read the questions**.
4. Look at each question and its answer. Fix or untick what is not right.
5. Press **Add … questions to the quiz**.

The same dialog is in *Question banks → a bank → Import questions*, to fill a bank instead of a
quiz.

Questions can be imported into a quiz **until the first student starts it**, like every other
change to its questions.

## The format

A list of questions. Each one says what `type` it is, the `question` itself, and its `answer`:

```json
{
  "questions": [
    {
      "type": "multiple_choice",
      "question": "Which part of a computer carries out the instructions of a program?",
      "choices": ["RAM", "CPU", "Hard disk", "Monitor"],
      "answer": "CPU"
    },
    {
      "type": "true_false",
      "question": "One byte is made of 8 bits.",
      "answer": true
    },
    {
      "type": "identification",
      "question": "What do the letters CPU stand for?",
      "answer": ["Central Processing Unit", "central processor"]
    }
  ]
}
```

The list alone, without `{ "questions": … }` around it, is read as well.

### The types of question

| `type` | What the question needs | `answer` |
|---|---|---|
| `multiple_choice` | `choices`: two or more texts | The text of the one correct choice |
| `multiple_response` | `choices`: two or more texts | A list with the text of every correct choice |
| `true_false` | The question is a statement | `true` or `false` |
| `modified_true_false` | A statement. When it is false, `correction`: the word or phrase that makes it true (a list when several are accepted) | `true` or `false` |
| `identification` | — | The accepted answer, or a list of every wording that is accepted. Marked by the computer |
| `short_answer` | — | As for identification, but an answer that matches none of the wordings waits for the teacher instead of being marked wrong. The answer may be left out: the teacher then marks every answer |
| `fill_blanks` | Each blank is written as three underscores, `___`, in the question | One list for each blank, in the order of the blanks, with the wordings that are accepted |
| `matching` | `pairs`: a list of `{ "left": …, "right": … }`, at least two | — (the pairs are the answer) |
| `ordering` | `items`: two or more texts, **written in their correct order** | — (students see them shuffled) |
| `essay` | — | — (the teacher marks it) |
| `file_upload` | — | — (the student hands in a file; the teacher marks it) |
| `programming` | `programmingProblemId`: one of your own coding problems | — (the program is run against the problem's tests) |

One of each kind that a quiz usually has:

```json
{
  "questions": [
    { "type": "multiple_choice", "question": "Which part of a computer carries out the instructions of a program?", "choices": ["RAM", "CPU", "Hard disk", "Monitor"], "answer": "CPU", "points": 1, "difficulty": "easy", "explanation": "The CPU (central processing unit) executes instructions." },
    { "type": "multiple_response", "question": "Which of these are input devices?", "choices": ["Keyboard", "Monitor", "Mouse", "Printer"], "answer": ["Keyboard", "Mouse"], "points": 2 },
    { "type": "true_false", "question": "One byte is made of 8 bits.", "answer": true },
    { "type": "modified_true_false", "question": "The monitor is an input device.", "answer": false, "correction": ["output"] },
    { "type": "identification", "question": "What do the letters CPU stand for?", "answer": ["Central Processing Unit", "central processor"] },
    { "type": "short_answer", "question": "Name one operating system.", "answer": ["Windows", "Linux", "macOS", "Android"] },
    { "type": "fill_blanks", "question": "A byte has ___ bits, and half a byte is called a ___.", "answer": [["8", "eight"], ["nibble"]], "points": 2 },
    { "type": "matching", "question": "Match each device with what it is used for.", "pairs": [{ "left": "Keyboard", "right": "Input" }, { "left": "Monitor", "right": "Output" }, { "left": "Hard disk", "right": "Storage" }], "points": 3 },
    { "type": "ordering", "question": "Arrange these units from the smallest to the largest.", "items": ["bit", "byte", "kilobyte", "megabyte"], "points": 2 },
    { "type": "essay", "question": "Explain the difference between memory (RAM) and storage.", "points": 10, "wordLimit": 200, "explanation": "A good answer says that RAM is fast and loses its contents without power, and that storage keeps them." },
    { "type": "file_upload", "question": "Upload a photo of the flowchart you drew.", "points": 5 }
  ]
}
```

In the dialog, *How to write the JSON → Copy an example of every kind* puts such an example on the
clipboard.

### What else a question can say

All of these can be left out.

| Name | Meaning | When left out |
|---|---|---|
| `points` | What the question is worth | 1 |
| `difficulty` | `easy`, `medium` or `hard` | medium |
| `topic` | A label, used to filter a question bank and to draw random questions by topic | none |
| `section` | The part of the test the question comes from, such as "Part I". Kept with the question as a label, and shown when the import is reviewed | none |
| `explanation` | Why the answer is right. Students see it where the quiz shows them the correct answers after they submit. For an essay: what a good answer contains | none |
| `caseSensitive` | `true`: "Na" is right and "NA" is wrong. For typed answers | capitals do not matter |
| `partialCredit` | `false`: all or nothing, for multiple response, modified true or false, fill in the blanks and matching. `true`: part of the points for an ordering that is partly right | part of the points for part of the answer; an ordering is right or wrong as a whole |
| `wordLimit` | For an essay: the most words | no limit |

### How the text is read

- The text is taken **as it is written**. Nothing in it is treated as HTML, so a question can be
  about `<b>` or `x < 10` without anything going missing.
- A line break in the text starts a new paragraph.
- Text between single backticks is shown as code: `` `x < 10` ``.
- A program goes between two lines of three backticks, inside the question text. Its line breaks
  and indentation are kept. The language may follow the first three backticks:

  ```json
  {
    "questions": [
      {
        "type": "multiple_choice",
        "question": "What does this program print?\n```python\nfor i in range(3):\n    print(i * 2)\n```",
        "choices": ["0 1 2", "0 2 4", "2 4 6"],
        "answer": "0 2 4"
      }
    ]
  }
  ```

- Formatting (bold, lists, tables, subscripts) is given as HTML under the name `questionHtml`
  instead of `question`. It is cleaned the same way as text from the editor. A `question` that is
  as a whole a block of HTML, the way an editor writes it (`<p>…</p>`), is read as HTML too.
- **Pictures are not imported.** Add them in the editor afterwards; the import says so on a
  question that names a picture.

## What else is understood

People, and chat assistants, write the same thing in many ways. The reader takes these where the
meaning is clear:

- **Other names.** `options` for `choices`; `correctAnswer`, `correct`, `answerKey`, `solution`
  for `answer`; `prompt`, `text`, `stem`, `q` for `question`; `marks`, `score` for `points`;
  `rationale`, `feedback` for `explanation`; `category`, `tag` for `topic`; and others like them.
  Capitals, underscores and hyphens in names do not matter: `correct_answer` is `correctAnswer`.
- **Other names of the types**: `mcq`, `Multiple Choice`, `checkbox`, `True/False`, `tf`, `cloze`,
  `fill in the blank`, `match`, `sequence`, `long answer` and so on.
- **A type that is missing** is worked out: choices make a multiple-choice question (multiple
  response when several are correct), `true` or `false` as the answer makes a true-or-false one,
  blanks make fill in the blanks, pairs make matching, a typed answer makes an identification
  question, and a question with nothing else is an essay (with a note to check).
- **The answer as a letter**: `"answer": "B"`, `"b)"`, `"Option B"`. Letters written in front of
  the choices (`"A. RAM"`) are removed.
- **The answer marked on the choices**:

  ```json
  {
    "questions": [
      {
        "prompt": "Which of these are input devices?",
        "options": [
          { "text": "Keyboard", "isCorrect": true },
          { "text": "Monitor", "isCorrect": false },
          { "text": "Mouse", "isCorrect": true }
        ]
      }
    ]
  }
  ```

- **An answer key apart from the questions**, at the end of the file:

  ```json
  {
    "questions": [
      { "number": 1, "question": "Which part of a computer carries out the instructions of a program?", "choices": ["RAM", "CPU", "Hard disk"] },
      { "number": 2, "question": "One byte is made of 8 bits." },
      { "number": 3, "question": "What do the letters RAM stand for?" }
    ],
    "answer_key": { "1": "B", "2": "True", "3": "Random Access Memory" }
  }
  ```

  Each answer goes to the question that has its number (or its text). Where the questions have no
  numbers, or numbers that start again in every part of the test, the answers are taken in the
  order of the questions; a plain list of answers must then have one place for each question
  (`null` where a question has no answer). A note above the questions says how the key was used.

  When the key does not show whose its answers are — more answers than questions, numbers that
  only partly agree with the numbers of the questions, a number given to two answers — **none of
  them is used**. The note says why, and the questions are marked for you to give their answers.
  A question that has an answer of its own keeps it.
- **Choices in columns**, the way a spreadsheet saves them: `"option_a": "RAM", "option_b":
  "CPU", …` (or `A`, `B`, …, or `option1`, `option2`, …), with the answer as a letter.
- **The wrong answers listed apart from the correct one**: `"correct_answer": "CPU",
  "incorrect_answers": ["RAM", "Hard disk"]`, the form of many question sets found online (also
  `distractors`, `wrong_answers`). The choices are put together in alphabetical order — "All of
  the above" and the like stay last — so that the correct one is not always the first, and a note
  says so. Turn on *Shuffle the choices* in the quiz to give every student another order.
- **Parts of a test**, each with a heading, a type and the points of each question:

  ```json
  {
    "title": "Midterm examination",
    "sections": [
      {
        "title": "Part I. True or false",
        "type": "true_false",
        "pointsEach": 2,
        "questions": [
          { "question": "A bit is either 0 or 1.", "answer": true },
          { "question": "RAM keeps its contents when the power is off.", "answer": false }
        ]
      },
      {
        "title": "Part II. Identification",
        "type": "identification",
        "questions": [
          { "question": "The part of the computer that carries out instructions.", "answer": "CPU" }
        ]
      }
    ]
  }
  ```

- **Lists named after a type**: `{ "true_false": [ … ], "identification": [ … ] }`.
- **A whole reply of a chat assistant**: a sentence before the JSON and one after it, the JSON
  inside a block of three backticks, a comma too many, comments, curly quotes instead of straight
  ones, a line break inside a text. Paste all of it.

## When the reader is not sure

A wrong answer key that nobody notices is worse than a question that needs one more look. So the
reader **never guesses an answer**:

- **Red: must be fixed.** The question cannot be added as it is. The usual case is an answer that
  fits none of the choices ("The monitor" where the choice says "Monitor screen"): the key is left
  open, and the question says *Mark the correct choice*. Such a question starts unticked; *Fix*
  opens it in the editor, and after that it is added with the others.
- **Amber: check it.** The question was read, in one of two possible ways. Look at the answer that
  is shown.
- **Blue: already there.** The quiz (or the bank) already has a question with this text. It starts
  unticked. A quiz never gets the very same question twice — the same text, choices, answer and
  explanation — even when it is ticked; the same text with other choices or another answer is a
  different question, and is added when it is ticked.

**An answer given as a number** is the case that most needs a look, because some people count the
choices from 0 and others from 1. The reader decides for the whole file:

- A `0` anywhere among the answers: the file counts from 0.
- No `0`, and somewhere a number as large as its list of choices: the file counts from 1.
- Neither: it counts from 0, and every such question is marked amber with the choice that was
  taken, for the teacher to confirm.

Writing the answer as the text of the choice avoids the question altogether.

**An answer that is only "T" or "F"**, on a question that does not say its type and has no
choices, is read as true or false — and marked amber, because the letter could also be an answer
to type.

The four numbers at the top of the review — *ready*, *to double-check*, *need fixing*, *already
in the quiz* — add up to the number of questions that were found.

## When the JSON has a mistake

The message says where, in plain words, and shows what stands at that place:

> This JSON cannot be read. Line 2: a comma is missing before this, or the text before it is not
> closed with a double quote ("). It is at: "answer": "memory"}

When the mistake is in one question, or the end of the text is missing (a reply that was cut off,
or one that was not copied to its end), the questions that are whole are read anyway, and a note
above them says that some may be missing.

## Letting a chat assistant write the questions

EduSphere can draft questions itself where an administrator has set up an AI provider (*AI
studio*). Without one, any chat assistant the teacher already uses does the same, and the import
reads its answer:

1. In the import dialog, open **Let an AI chat write the questions**. Choose how many questions,
   how difficult, which kinds, and say what they are about.
2. **Copy the request** and paste it into the chat assistant.
3. Paste the lesson, notes or reading where the request ends with "Material:", and send it.
4. Copy the whole answer and paste it into the import box. (When the request itself is pasted
   there instead — it is what was copied last — the dialog says so, and reads nothing.)

EduSphere sends nothing to the assistant: the request is text that the teacher copies. What the
teacher pastes into the assistant is the teacher's to decide — it should not contain students'
names or marks.

**Read every question and its answer before adding them.** An assistant can be wrong, and it can
be wrong in the answer key. That is what the review step is for.

## Importing a test paper

The same dialog reads a test that was typed as a document: Word (`.docx`), PDF or text.

- Number the questions (`1.` or `1)`) and letter the choices (`A.`, `B.`, …).
- Mark the correct choice with a `*`, make it bold or highlighted in Word, or add a line
  `Answer: B`. An answer key at the end of the document (`Answer Key`, then `1. B`, `2. True`, …)
  is understood as well.
- Headings such as "Part II. True or False" or "Identification" set the type of the questions
  under them.
- Scanned pages, which are pictures of text, cannot be read.

## Downloading questions

Beside **Questions** in the quiz, and at the top of a question bank, the download button saves
the questions with their answers as a JSON file in the format above. Importing that file gives the
same questions again: a copy to keep, to use in another class, or to hand to a colleague.

- A question with formatting is written with `questionHtml`.
- Questions that a quiz draws at random from a bank are not in its file: they are not questions of
  the quiz but a rule for choosing some. Download the bank for those.
- A programming question is written with the id of its coding problem, which exists only in the
  account of the teacher who made it. Imported by someone else, it is marked for fixing.
- The file contains the answers. Keep it where students cannot read it. Each download is written
  to the audit log, with who made it and when.

## Limits

| | |
|---|---|
| Questions in one import | 300. A longer file is read up to there, and a note says so |
| Questions in one quiz | 300 of its own (questions drawn at random come on top) |
| Length of the text | 400,000 characters. Longer text is read up to there, and a note says so |
| Size of a file | 10 MB, or the upload limit of the server when that is lower |
| Who | A quiz: the teacher of the class, or an administrator, until the first student starts it. A bank: the teacher who owns it |

## For developers

| Part | Where |
|---|---|
| Reading JSON into draft questions, and writing questions as JSON | `backend/src/lib/questionJson.js` (pure; `parseQuestionJson`, `questionsToJson`) |
| Reading a test paper; choosing between the two readers | `backend/src/lib/questionImport.js` (`parseImport`) |
| Routes for a quiz | `backend/src/modules/quizzes/routes.js`: `POST /quizzes/:quizId/import/preview`, `POST /quizzes/:quizId/questions/bulk`, `GET /quizzes/:quizId/questions/export` |
| Routes for a bank | `backend/src/modules/quizzes/banks.js`: `POST /question-banks/:bankId/import/preview`, `POST /question-banks/:bankId/questions/bulk`, `GET /question-banks/:bankId/export` |
| The dialog | `frontend/src/pages/classes/quiz/ImportQuestions.jsx` |
| The examples and the request for a chat assistant | `frontend/src/lib/questionFormat.js` |

The preview answers `{ source, format, questions, summary, notes }`. Each question is in the shape
the question editor uses, with `number`, `warnings`, `errors`, and `duplicate: true` when its text
is already there; in `summary`, `found` is the sum of `ready`, `needsReview` and `duplicates`. The bulk route takes those questions back (without the four extra names) and is
all or nothing: when one question cannot be saved, none is, and the answer names each with its
errors. Adding to a quiz keeps each question in a question bank, as a single new question does; a
question that the bank already holds is used again instead of being stored twice. The requests and
answers are in [API.md](API.md).

The answer key never leaves the server on the student's side: an imported question is an ordinary
question, and is served to students the same way as one that was typed.

Tests: `backend/tests/unit/question-json.test.js` (what is read from JSON, including every example
in this document and in the dialog), `backend/tests/api/question-import.test.js` (the routes, and
a student marked by an imported key), `frontend/src/lib/questionFormat.test.js`, and
`e2e/tests/question-import.spec.js` (the dialog in a browser).
