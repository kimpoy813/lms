# Grading

Every class has its own gradebook. The teacher decides its structure; EduSphere does the
arithmetic, shows each student how their grade was computed, and keeps a history of every change.

## Structure

```
Class
└── Grading periods      e.g. Midterm 50 %, Final 50 %          (weights total 100 %)
    └── Categories       e.g. Quizzes 25 %, Assignments 20 %,
                              Activities 15 %, Major Examination 40 %   (weights total 100 %)
        └── Items        one column per assignment, quiz or manual item, each with maximum points
```

A new class starts with *Midterm and Final (50 / 50)* and the categories above. This is only a
starting point: before any grade is recorded the teacher can rename and re-weight everything or
apply another template (*Prelim, Midterm and Final 30 / 30 / 40*, or *One grading period*).
Nothing here is assumed to be an institutional rule.

Publishing an assignment or a quiz with a category creates its column. Scores flow into the
column automatically; manual items (recitation, a paper examination) are typed into the gradebook.

## How a grade is computed

1. **Inside a category** the grade is *points earned ÷ points possible* over the items that count.
   Items are weighted by their points, not one item one vote.

   | Status of a score | Effect |
   |---|---|
   | Graded | Counts |
   | Missing | Counts as zero if the class treats missing work as zero; otherwise left out |
   | Exempt | Never counts — neither earned nor possible |
   | Not graded yet | Does not count yet |

2. **A period grade** is the weighted average of its category grades. A category with nothing
   that counts yet is left out, and the remaining weights are scaled up proportionally — so a
   student's running grade is not dragged down by work that has not been given yet.
3. **The overall grade** is the weighted average of the period grades, in the same way.
4. **Transmutation** (optional, per class): *shown grade = base + raw × (100 − base) ÷ 100*.
   With a base of 50, a raw 60 % is shown as 80 %. A base of 0 switches it off.
5. The result is **rounded** to the class's number of decimals and then looked up in the
   **grading scale** (for example 1.00–5.00, or letters). Scales are defined by an
   administrator; each band has a minimum percentage, a label and whether it is a passing grade.
6. A **teacher override** replaces the computed value of one period or of the overall grade. It
   requires a written reason, and the computed value stays visible next to it.

When nothing has been graded the grade is empty, not zero.

The same code computes the teacher's gradebook, the student's view and the finalised record
(`backend/src/modules/gradebook/compute.js`). The student's grades page spells the computation
out in words for each period.

### Attendance in grades

Off by default. An administrator can allow it (*Attendance may count toward grades*); a teacher
can then add an attendance category. Its grade is
*(present + late × late credit) ÷ (present + late + absent)*, with a late credit of one half
unless the class sets another value. Excused sessions are left out.

## Where scores come from

### Assignments

- The teacher enters a score, or scores a rubric: the score is the sum of the chosen levels.
- **Late penalty** (per assignment): none, a flat percentage, or a percentage per day late with a
  cap. Any started day counts as a full day. The penalty is applied to the score, and both the
  raw score and the penalty are shown to the student.
- The score is written to the gradebook when the teacher saves it. The student sees it when the
  work is **returned**.

### Quizzes

- Objective questions are scored by the server when the attempt is handed in:

  | Type | Scoring |
  |---|---|
  | Multiple choice, true/false, identification | Right or wrong |
  | Multiple response | Partial credit; each wrong pick cancels a right one, so ticking everything earns nothing |
  | Modified true/false | Half for spotting a false statement, full with an accepted correction |
  | Fill in the blanks, matching | Partial credit per blank or pair |
  | Ordering | All or nothing, unless the question allows partial credit |
  | Short answer | Full marks when it matches an accepted answer; otherwise the teacher reviews it, because a differently worded answer may still be right |

  Partial credit can be switched off per question. Answers are compared without regard to
  capital letters unless the question says otherwise.
- Essays and file uploads wait for the teacher. The total is shown to the student only when
  every answer has a score.
- **Programming questions** take the best result among the programs the student had checked
  during the attempt (*tests passed, by weight*, or all-or-nothing if the problem says so). A
  program that was saved but never checked is checked once when the quiz is handed in. If it does
  not compile, or the code judge cannot be reached or stays busy for more than a few seconds, the
  answer waits for the teacher.
- With several attempts allowed, the quiz counts the **highest**, the **latest** or the
  **average** attempt, as chosen by the teacher.
- The answer key is never sent to the browser while an attempt is open. Time limits are kept by
  the server: when time runs out the attempt is submitted with what was saved.

## Publishing, locking and finalising

| Step | Effect |
|---|---|
| **Publish** a period | Students see its computed grade. The overall grade appears once every period is published. Until then they see only scores already released to them: returned assignments and quizzes whose results are visible |
| **Lock** a period | Scores in it can no longer be changed. Unlocking requires a reason |
| **Finalise** the class | The final grades are stored as a record; from then on the stored record counts, not a fresh computation. Reopening is logged |

Every change of a score is written to the grade history with who changed it, when, and the old
and new value. Publishing, locking and finalising are written to a publishing log.

## Appeals

A student can ask for a grade to be reviewed, with an explanation. The teacher accepts or
declines with a written response, and the student is notified. Accepting does not change a score
by itself: the teacher then corrects the score in the gradebook, which is recorded in the history.

## Exports

The gradebook can be exported as CSV, Excel or PDF by roles that hold the *grades.export*
permission.

## Tests

`backend/tests/unit/grading.test.js` covers the computation (scales, transmutation, weights,
missing/exempt/ungraded work, overrides, attendance, late penalties) and
`backend/tests/api/gradebook.test.js` the workflow.
