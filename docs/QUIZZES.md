# Quizzes and examinations: parts, shuffling and marking

Two things a teacher can count on:

- **The system marks the answers.** Every question that has an answer key is marked the moment a
  student hands in. The teacher marks essays and uploaded files; a short answer waits for the
  teacher only in the [cases named below](#the-one-case-where-a-short-answer-waits), and the
  builder shows them on the question.
- **A quiz is taken part by part.** Multiple choice stays with multiple choice, true or false
  with true or false. Shuffling changes the order *inside* each part, never the parts.

The rules live in three small files that have no database and no web in them, each with its
tests: `backend/src/lib/answerMatch.js` (comparing a typed answer with the key),
`backend/src/lib/quizScoring.js` (marking) and `backend/src/lib/quizParts.js` (parts and order).

## Who marks what

| Question | Marked by | How |
|---|---|---|
| Multiple choice, true or false | The system | Right or wrong |
| Multiple response | The system | Part of the points; each wrong pick cancels a right one, so ticking everything earns nothing |
| Modified true or false | The system | Half for spotting a false statement, all with an accepted correction |
| Identification | The system | Right when it matches an accepted answer ([below](#how-a-typed-answer-is-compared)) |
| Short answer **with** accepted answers | The system | Right when it matches an accepted answer, wrong when it does not |
| Fill in the blanks, matching | The system | Part of the points for each blank or pair that is right |
| Ordering | The system | Right or wrong as a whole, unless the question gives partial credit |
| Programming | The system | The best result among the programs the student had checked. A program that could not be checked waits for the teacher ([Grading](GRADING.md#quizzes)) |
| Essay | **The teacher** | There is no key to check an essay against |
| File upload | **The teacher** | The same |
| Short answer **without** an accepted answer | **The teacher** | Nothing to check against: it is an essay in all but name |

Partial credit can be switched off per question. An answer that was left empty scores 0 and
never waits for anybody.

### The one case where a short answer waits

A short answer is marked wrong when it matches none of the accepted answers — like an
identification question. Two things change that, both visible on the question in the builder as
the badge **Other answers wait for you**:

- **The teacher asks for it**: in the question, tick *I look at the answers that match none of
  these*. An answer that matches is still marked right at once; any other waits for the teacher.
- **The accepted answer is a whole sentence** (every accepted answer has more than six words),
  and the teacher has not decided otherwise. Nobody types a sentence word for word, so marking
  everything else wrong would be unfair to a student who is right in other words. Untick the
  same box to have the system mark these too, or — better — list the short answers that are
  right ("less dense", "it is less dense than water").

While an answer waits, the student's score for that attempt is not shown and not written to the
gradebook, exactly as for an essay. The builder's summary says how many questions of a quiz can
wait; a quiz where it says *The system checks every question* never waits.

The teacher can overrule any score the system gave (*Results → the attempt → Change score*).
That is kept in the audit log.

## How a typed answer is compared

For identification, short answer, fill in the blanks and the correction of a modified
true-or-false statement. The aim: an answer that any teacher would call the same as the key is
right — **and nothing else is**. The system does not guess at spelling, and it does not judge
meaning.

These make no difference:

| | Typed | Key |
|---|---|---|
| Capital letters, spacing, a full stop | ` central   processing unit. ` | `Central Processing Unit` |
| Dots of an abbreviation, apostrophes, quotes | `C.P.U.`, `Boyles law` | `CPU`, `Boyle's Law` |
| Accents | `Las Pinas`, `Nino` | `Las Piñas`, `Niño` |
| "The", "a", "an" in front, and "it is…", "the answer is…" | `the CPU`, `It is a compiler.` | `CPU`, `compiler` |
| "The" or "an" in front of the key | `algorithm`, `Hobbit` | `An algorithm`, `The Hobbit` |
| Words together, apart or with a hyphen | `harddisk`, `mother board`, `wifi`, `email` | `hard disk`, `Motherboard`, `Wi-Fi`, `e-mail` |
| "and" and "&", a comma between words | `R and D`, `Rizal Jose` | `R&D`, `Rizal, Jose` |
| How a number is written | `1000`, `2.5`, `eight`, `twenty-one`, `5kg`, `50 percent` | `1,000`, `2.50`, `8`, `21`, `5 kg`, `50%` |
| A name with its abbreviation in the key | `CPU`, or `Central Processing Unit` | `Central Processing Unit (CPU)` |
| A note in brackets in the key | `Mercury` | `Mercury (planet)` |

These stay different, because the difference means something:

| Typed | Key | Why |
|---|---|---|
| `ROM`, `keybord` | `RAM`, `keyboard` | Another word. Spelling is never guessed |
| `C`, `C#` | `C++` | Signs that are part of the answer |
| `xy`, `x1`, `ab` | `x-y`, `x-1`, `a/b` | A hyphen or slash between single letters or numbers is a sign |
| `23`, `2,3` | `2, 3`, `23` | Two numbers are not one number |
| `192.168.1.10`, `v1.10` | `192.168.1.1`, `v1.1` | Text with several numbers is taken as typed |
| `A, B`, `A B` | `B`, `AB` | Two answers where one was asked |
| `TCP`, `planet` | `TCP/IP`, `Mercury (planet)` | Part of the answer, or only the note |
| `positive`, `minor` | `A positive`, `A minor` | An "A" in front of the key can be the answer itself, so it is kept. Write the key without "a" where it is only an article |
| `LAN` | `Local Area Network` | Not in the key. List both, or write the key as `Local Area Network (LAN)` |

**Several answers at once.** In an identification or short-answer question with several accepted
answers ("Name an input device": keyboard, mouse, scanner), a student who gives more than one —
`keyboard, mouse and scanner` — is right as long as *every* one of them is an accepted answer.
One that is not makes the answer wrong.

**Exactly as written.** A question can ask for the answer letter for letter (*Exactly as
written* in the editor; `caseSensitive` in an import). Then only the spaces around the answer and
a full stop after it are ignored: `Na` is right, `NA`, `na` and `the Na` are wrong. Use it for
chemical symbols, code and anything else where a capital or a sign is the answer.

`backend/tests/unit/answer-match.test.js` holds both lists — what must be right and what must
stay wrong. A change to the comparison that moves a pair from one list to the other changes
students' scores, and that test is where it shows.

## Parts

A **part** is a group of questions that are given together: "Part I. Multiple Choice", "Part II.
True or False", "Part III. Essay". Students see which part they are in, how many parts there are,
which questions belong to it and what it is worth — while answering, in the list of questions,
and when they look at their answers afterwards. The teacher sees the same headings in the
builder and when looking at a student's attempt.

### Which part a question belongs to

1. **A question with a part name belongs to the part of that name.** The name is the *Part* field
   of the question; an import sets it from the headings of the paper ("Part II. True or False")
   or from `section` in JSON ([Importing questions](QUESTION-IMPORT.md)). Capital letters,
   spacing and punctuation in the name make no difference.
2. **A question without one goes with the questions of its kind**: into the named part that
   speaks of its kind (a true-or-false question into "Part II. True or False"), and otherwise
   into a part called after the kind ("Essay").
3. **The parts come in the order in which they first appear** among the quiz's questions. Where
   the questions of a part are kept together (below), the builder moves a question inside its
   part only, and the arrows on a part's heading move the whole part.

Students see the parts numbered in the order they get them — *Part 2 of 4 · True or False* — so
the numbering the teacher wrote in front of a name ("Part II.", "Test B:") is left out, and a
part named by its number alone is called after the kind of its questions.

### When the questions of a part are kept together

| The quiz | What students get |
|---|---|
| **Shuffled** | Part by part. Every student gets the questions of each part in a different order; the parts stay in the teacher's order |
| Not shuffled, **with part names** | Part by part, each part in the teacher's order |
| Not shuffled, no part names | Exactly the order the teacher wrote. Where the kinds happen to come one after the other, the parts are shown; where the teacher mixed them on purpose, there are none |

So a shuffled examination never gives an essay between two multiple-choice questions, and a
teacher who writes a quiz in one deliberate order, without part names and without shuffling,
gets exactly that order.

**A quiz with nothing to group has no parts.** Without part names, twenty multiple-choice
questions are one list, and so are five questions of five different kinds — calling each of
those a part would only mean that shuffling does nothing. Such a quiz is shuffled as a whole.
Parts by kind begin where a quiz has several kinds of question and at least two of one kind.

**Questions drawn at random from a bank** join the part of their kind (or of their part name,
when the bank's questions have one). The order of the parts is taken from everything the quiz
*may* give, so it is the same for every student whatever was drawn for them.

**The choices** of multiple-choice questions are shuffled by their own switch, as before.

The part of each question is kept in the attempt when it starts, so a later change to the
question bank does not move anything in a paper that was already handed out. Attempts from
before parts were kept show their parts by the kind of question, where their order allows it.

## Marking again

Attempts keep the marks they were given. When the rules for marking improve — as they did when
the system began to mark short answers itself, and to compare typed answers the way described
above — attempts that were handed in before are not changed behind the teacher's back.

*Results* shows a notice when answers **wait for the teacher although the system can check
them**, with the button **Check them now**. It marks the handed-in answers of that quiz again, by
the answer key each attempt holds:

- an answer that waited and that the system can decide is marked: right or wrong;
- an answer that was marked wrong for a difference that no longer counts (`harddisk` for
  `hard disk`) is marked right;
- a score **never goes down**: everything that was right before is still right;
- a score **the teacher gave** is never touched, and neither is an essay, a file, a program, or
  an attempt that stands as failed for a rule violation;
- the gradebook follows, each attempt notes that it was marked again, and the audit log keeps
  who asked for it and what changed.

`POST /quizzes/:quizId/results/recheck` is the same action; it answers with what changed.

## When students see their score

Marking and showing are two different settings. The system marks at once; the quiz's *Scores
shown* setting says when students see the result: **right after submitting**, **after the quiz
closes**, **when I release the results** (the default: press *Release results* on the results
page) or **never** (the score only reaches the gradebook). A student whose attempt still has an
answer waiting for the teacher sees "waiting for grading" until it is marked, whatever the
setting.

## Tests

| File | Covers |
|---|---|
| `backend/tests/unit/answer-match.test.js` | The comparison of typed answers: the pairs that must match and those that must not, exact comparison, several answers at once |
| `backend/tests/unit/quiz.test.js` | Marking of every type of question; who marks a question, and that the web app says the same; which blanks and pairs were counted as right |
| `backend/tests/unit/quiz-parts.test.js` | Which part a question belongs to, the order questions are given in, the parts an attempt shows |
| `backend/tests/api/quiz-marking-parts.test.js` | Through the API: a shuffled quiz taken part by part by a whole class, random questions, moving a part; short answers marked at once; what waits for the teacher; marking again |
| `e2e/tests/quiz-parts.spec.js` | In a browser: the builder with its parts, a student taking a shuffled examination part by part, the score that is there on handing in |
