# Quizzes and examinations: parts, shuffling and marking

Two things a teacher can count on:

- **The system marks the answers.** Every question that has an answer key is marked the moment a
  student hands in, also a short answer that is a whole sentence: the system looks for its
  [key words](#a-sentence-is-checked-by-its-key-words) in what the student wrote, whatever the
  wording. The teacher marks essays and uploaded files; a short answer waits for the teacher
  only in the [cases named below](#when-a-short-answer-waits), and the builder shows them on
  the question.
- **A quiz is taken part by part.** Multiple choice stays with multiple choice, true or false
  with true or false. Shuffling changes the order *inside* each part, never the parts.

The rules live in four small files that have no database and no web in them, each with its
tests: `backend/src/lib/answerMatch.js` (comparing a typed answer with the key),
`backend/src/lib/keyWords.js` (checking a sentence by its key words),
`backend/src/lib/quizScoring.js` (marking) and `backend/src/lib/quizParts.js` (parts and order).

## Who marks what

| Question | Marked by | How |
|---|---|---|
| Multiple choice, true or false | The system | Right or wrong |
| Multiple response | The system | Part of the points; each wrong pick cancels a right one, so ticking everything earns nothing |
| Modified true or false | The system | Half for spotting a false statement, all with an accepted correction |
| Identification | The system | Right when it matches an accepted answer ([below](#how-a-typed-answer-is-compared)) |
| Short answer **with** accepted answers | The system | A word or a phrase: right when it is an accepted answer, wrong when it is not ([how](#a-word-or-a-phrase)). A sentence, or where the teacher asks for it: by its [key words](#a-sentence-is-checked-by-its-key-words) — right, half right or wrong |
| Fill in the blanks, matching | The system | Part of the points for each blank or pair that is right |
| Ordering | The system | Right or wrong as a whole, unless the question gives partial credit |
| Programming | The system | The best result among the programs the student had checked. A program that could not be checked waits for the teacher ([Grading](GRADING.md#quizzes)) |
| Essay | **The teacher** | There is no key to check an essay against |
| File upload | **The teacher** | The same |
| Short answer **without** an accepted answer | **The teacher** | Nothing to check against: it is an essay in all but name |

Partial credit can be switched off per question. An answer that was left empty scores 0 and
never waits for anybody.

### When a short answer waits

A short answer with accepted answers is marked by the system, at once. Three things make an
answer wait for the teacher:

- **There is no accepted answer.** Nothing to check against. The builder shows the badge
  **Graded by you**.
- **The teacher asks for it**: in the question, tick *I look at the answers that match none of
  these*. An answer that is right is still marked at once; any other waits for the teacher.
  The badge is **Other answers wait for you**.
- **The system has a doubt**: the key words of the accepted answer are there, and the answer
  may still say the opposite ("The contents are *not* lost"). Key words cannot tell whether
  that is right. [These doubts](#the-doubts-it-sees) are the only thing the system leaves to
  the teacher of its own accord, and the answer says which doubt it was.

While an answer waits, the student's score for that attempt is not shown and not written to the
gradebook, exactly as for an essay. The builder's summary says how many questions of a quiz can
wait, and how many are checked by key words.

The teacher can overrule any score the system gave (*Results → the attempt → Change score*).
That is kept in the audit log.

## A sentence is checked by its key words

Nobody types a sentence word for word. So where an accepted answer of a **short answer**
question is a sentence, the system does not compare letters: it looks for the key words of
that answer in what the student wrote. The builder shows the badge **Checked by key words**
and, under the accepted answer, the words it looks for.

| | |
|---|---|
| Question | What is an algorithm? |
| Accepted answer | An algorithm is a step-by-step procedure for solving a problem |
| Key words | step · procedure · solving · problem |

| The student writes | Key words | Marked |
|---|---|---|
| `It is a procedure that solves problems step by step.` | 4 of 4 | right |
| `a procedure to solve problems` | 3 of 4 | right |
| `a procedure for a problem` | 2 of 4 | half the points |
| `a procedure` | 1 of 4 | wrong |
| `An algorithm is an algorithm` | 0 of 4 | wrong |

### The teacher says where

In the question, the box **Check by key words** says whether the key words are looked for.
Left alone, it follows what the teacher types:

- **on for a sentence**: an accepted answer of more than six words, or of four words and more
  that state something — `It stores data permanently`, `RAM is volatile memory`. The system
  tells by words such as *is, are, has, can, it, they, because, when* (and *ay, dahil, kapag,
  ito*);
- **off for a word or a phrase**, the name of a thing: `Basic Input Output System`, `do while
  loop`. A title, with a capital letter on every word (`As You Like It`), is a name however it
  reads. Such an answer is [taken as it stands](#a-word-or-a-phrase).

The system can guess wrong: `The earth revolves around the sun` has none of those words, and
is taken for a phrase. So the teacher can tick the box — every accepted answer of the question
is then checked by its key words, a single word too (`photosynthesis`: the answer has to have
it) — or clear it, and a sentence is then taken as it stands like a phrase. The choice is
saved with the question (`keyWords` in a [question file](QUESTION-IMPORT.md)). *Exactly as
written* switches key words off.

Below the box, the editor shows the key words and how many of them an answer needs, and has a
field **Try an answer**: type what a student might write, and see how it is marked — before
any student gives it.

### What a key word is

**The key words** are the words of the accepted answer that carry meaning: not "the", "is",
"of", "it" and the like (in English and in Filipino), and not the words that the question
already gives — "algorithm" above, which any student can repeat.

**A key word is found**

- in any form: *solve, solves, solved, solving, solution*; *lose, lost, loss*; *mouse, mice*;
- with a slip of one letter in a word of six letters or more: *procedrue*, *permanantly* — but
  `ROM` is never `RAM`, and `asynchronous` is not `synchronous`;
- written together or apart: *hard disk, harddisk*; *motherboard, mother board*;
- as a number however it is written: *eight, 8*;
- as "not volatile" for *non-volatile*, and the other way round.

### How many are needed

- **Right** — all the points: two thirds of the key words, or more.
- **Half right** — half the points: a third of them or more, and two at least. One word in
  common is not half an answer. (Of two key words, one is half.) Nothing is half right where
  the question gives no partial credit.
- **Wrong**: fewer.

| Key words | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| Right with | 1 | 2 | 2 | 3 | 4 | 4 | 5 | 6 | 6 |
| Half right with | – | 1 | – | 2 | 2 | 2 | 3 | 3 | 3 |

A **number** in the accepted answer has to be in the student's answer: "a unit of data made of
16 bits" has four of the five key words of "…made of eight bits", and is half right at most.

Where a question has several accepted answers, the one the student comes closest to counts.
A short accepted answer next to the sentence ("8 bits") is still right as it stands.

### The doubts it sees

Words can all be there, and the answer can still say the opposite. Where the key words give an
answer points and one of these five things is seen, the system gives no score: the answer
waits for the teacher, who is told what was seen.

| The accepted answer | The student writes | The teacher is told |
|---|---|---|
| `The contents of RAM are lost when the computer is turned off` | `They are not lost` | It says "not" about "lost", and the accepted answer does not |
| `No, RAM is temporary storage because it loses data…` | `Yes, it loses data when the power is off` | It begins with "Yes" where the accepted answer begins with "No" |
| `Because ice is less dense than liquid water` | `Ice has a higher density than liquid water` | It says "higher density" where the accepted answer says "less dense" |
| `RAM is faster than a hard disk because it is electronic` | `A hard disk is faster than RAM, it is electronic` | It compares with "than", but not with what the accepted answer compares with |
| `RAM is volatile and ROM is non-volatile` | `ROM is volatile and RAM is non-volatile` | It puts "ROM" with "volatile", and the accepted answer puts it with "non-volatile" |

- **"Not"** counts for the word it is about, and only where both have that word: `It is not
  software, it is a procedure for solving a problem` raises no doubt, and neither does `we never
  lose the files` against `…the files are not lost`. *No, never, nothing, cannot, isn't,
  doesn't* and the like count as "not", and so do *hindi* and *wala*. "No power" agrees with
  "without power" and with "when the power is off".
- **Opposites** are a list of some eighty pairs in `backend/src/lib/keyWords.js`: more and
  less, faster and slower, before and after, input and output, row and column, permanent and
  temporary, allows and prevents, opened and closed, absorbs and releases… An accepted answer
  that has both ("takes input and gives output") raises no doubt, and neither does an answer
  that has the word of the accepted answer as well ("easy to read, not difficult"). "Denser" and
  "higher density" count as "more dense"; "volatile" is the opposite of "non-volatile", for any
  word with "non-".
- **"On" and "off"** are opposites where they say what state a thing is in: `when the computer
  is turned on` waits for `When the computer is turned off`, and `…when the power is on` for
  `…when the power is off`. "Stored **on** the disk" is a place, and raises no doubt.
- **A comparison that is turned round as a whole says the same**, and raises no doubt:
  `Liquid water is denser than ice` is right for `Ice is less dense than liquid water`, and `A
  hard disk is slower than RAM` for `RAM is faster than a hard disk`.
- **Two things that changed places** are seen where both parts say what something *is* or
  *has*: "RAM **is** volatile and ROM **is** non-volatile". The items of a list may come in any
  order: "programs and files", "files and programs".
- A doubt costs the teacher a look. It never costs the student a point: an answer that the
  key words give nothing to is simply wrong, with or without a "not".

### What a teacher can do

- **Try it first.** *Try an answer*, in the question editor, marks what you type the way a
  student's answer will be marked.
- **Keep the accepted answer to what a right answer needs.** Every word in it that carries
  meaning is a key word, and a student has to give two thirds of them: an accepted answer with
  an example and a side remark asks for those too. To *Why does ice float on water?*, the key
  words of `Because ice is less dense than liquid water` are *dense · liquid*, and "it is less
  dense" is half right; the key word of `Because ice is less dense than water` is *dense*, and
  it is right.
- **Add another accepted answer** for another way of saying it: "They are erased when the
  computer is turned off" next to "The contents of RAM are lost…". A short one is welcome too:
  "input device" next to the sentence that explains why.
- **Say where key words are looked for**: tick or clear *Check by key words*.
- **Look at the answers yourself**: tick *I look at the answers that match none of these*, or
  make the question an essay.
- **Ask for the exact words**: *Exactly as written* switches the key words off.

### What it cannot do

It looks for words; it does not understand them.

| The student writes | Accepted answer | What happens |
|---|---|---|
| `A problem is a procedure for solving steps` | `…a step-by-step procedure for solving a problem` | Right: the key words are all there. Their order is not looked at |
| `The server sends a request to the client` | `The client sends a request to the server` | Right: the same words. Who does what to whom is not looked at |
| `The data is erased` | `The contents of RAM are lost…` | Wrong: "erased" is not "lost" until the teacher accepts both |
| `It is an input device` | `A keyboard is an input device because it sends data into the computer`, to the question *Is a keyboard an input or an output device?* | Wrong: the question gives "input" and "device", so the key words are *sends · data · computer*. Accept "input device" as well |
| `The reaction gives off heat to its surroundings` | `The reaction absorbs heat from its surroundings` | Right: two of the three key words are there, and "gives off" is not in the list of opposites. (`…releases heat to its surroundings` waits for the teacher: "releases" is in the list.) |

This is why the teacher sees, on every answer that was checked this way, which key words were
found and which were missing (*Results → the attempt*), and can change the score. Students see
the same line where the quiz shows them the correct answers.

`backend/tests/unit/key-words.test.js` holds the examples these rules were made from.

### A word or a phrase

An accepted answer that is not checked by key words is the name of a thing, and has to be
given as it is. The answer is right when it *is* that accepted answer
([compared as below](#how-a-typed-answer-is-compared)) — and also

- with *a, an, the, of, is, are, was, were, it, its, this, that, these, those, they, called*
  added or left out: `brain of computer` for `the brain of the computer`;
- in the singular or the plural: `volatile memories` for `volatile memory`;
- without the words that the question gives, or with them. To *What type of memory is RAM?*:
  `volatile` is right for `volatile memory`, `volatile memory` for `volatile`, and `RAM is
  volatile` for both. Left out or added, not both — that would be another answer: `output
  device for typing` is not `input device for typing`. And an accepted answer that only
  repeats the question is taken as it stands: to *Is a keyboard an input device or an output
  device?*, only `input device` is right for `input device`;
- with several things in another order: `control unit and arithmetic logic unit` for
  `arithmetic logic unit and control unit`.

Every other word counts, and so does the order of the words:

| The student writes | Accepted answer | |
|---|---|---|
| `OR gate` | `AND gate` | wrong |
| `while loop` | `do while loop` | wrong |
| `digital to analog converter` | `analog to digital converter` | wrong |
| `Basic Input System` | `Basic Input Output System` | wrong |
| `memory that is volatile` | `volatile memory` | wrong: another order. Right with *Check by key words* |
| `volatile memory and non-volatile memory` | `volatile memory` | wrong: it is not looked for inside a longer answer |
| `memory` | `volatile memory` | wrong: nothing is half right |
| `more dense than water` | `less dense than water` | wrong |

A word in capitals is taken for a name: `IT support` is not "it", and an `AND gate` is not
"and".

**Identification** is stricter still: a term, compared as below, and nothing more.

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
the system began to mark short answers itself, to compare typed answers the way described
above, and to check a sentence by its key words — attempts that were handed in before are not
changed behind the teacher's back.

*Results* shows a notice when the system **can check answers that were handed in earlier** —
answers that wait for the teacher although it can mark them, and answers that today's rules
give more than they have — with the button **Check them now**. It marks the handed-in answers
of that quiz again, by the answer key each attempt holds:

- an answer that waited and that the system can decide is marked: right, half right or wrong;
- an answer that was marked wrong for a difference that no longer counts (`harddisk` for
  `hard disk`, a sentence in the student's own words) is marked right;
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
| `backend/tests/unit/key-words.test.js` | A sentence checked by its key words: the forms of a word, what is a key word, right, half right and wrong, numbers, the five doubts and what is no doubt; the teacher's choice; a word or a phrase, and what must stay wrong for it |
| `backend/tests/unit/quiz.test.js` | Marking of every type of question; who marks a question and whether its key words are looked for, and that the web app says the same; which blanks and pairs were counted as right |
| `frontend/src/lib/quizMarking.test.js` | What the teacher is told of each doubt; a sentence, or the name of a thing |
| `backend/tests/unit/quiz-parts.test.js` | Which part a question belongs to, the order questions are given in, the parts an attempt shows |
| `backend/tests/api/quiz-marking-parts.test.js` | Through the API: a shuffled quiz taken part by part by a whole class, random questions, moving a part; short answers marked at once, a sentence by its key words; what waits for the teacher; trying an answer; marking again |
| `e2e/tests/quiz-parts.spec.js` | In a browser: the builder with its parts, the key words and the try-out box of a question, a student taking a shuffled examination part by part, the score that is there on handing in |
| `e2e/tests/quiz-key-words.spec.js` | In a browser: a student who answers in their own words and has the score at once, an answer with a "not" that waits, and what the teacher is shown of it; the box *Check by key words* for a phrase, with *Try an answer* |
