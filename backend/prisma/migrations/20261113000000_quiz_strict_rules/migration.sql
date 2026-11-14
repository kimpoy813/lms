-- Strict rules for quizzes and examinations.
--
-- While a student answers, leaving the page, copying, pasting or a screenshot key is a violation.
-- Violations end the attempt as failed; the teacher can reopen it or count its answers.
--
--   Quiz.strictMode / violationWarnings   whether the rules apply, and how many warnings come first
--   QuizAttempt.rulesAcceptedAt           the student started under the rules (and was shown them)
--   QuizAttempt.terminatedAt / …Kind      the attempt stands as failed, and for what
--   QuizAttempt.reopened… / resumeSeconds a teacher reopened it; the clock starts when the student continues
--   QuizAttempt.pageOpenedAt / awaySince  the quiz page being opened a second time shows that it was closed
--   QuizAttemptEvent.clientKey            a report the browser may send twice is counted once

ALTER TABLE "Quiz"
  ADD COLUMN "strictMode" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "violationWarnings" INTEGER NOT NULL DEFAULT 0;

-- Practice quizzes are not graded: they stay as they were until a teacher switches the rules on.
UPDATE "Quiz" SET "strictMode" = false WHERE "kind" = 'PRACTICE';

-- Attempts that are open right now were started before the rules existed. Their
-- "rulesAcceptedAt" stays empty, so nothing is held against a student who was never told.
ALTER TABLE "QuizAttempt"
  ADD COLUMN "rulesAcceptedAt" TIMESTAMPTZ(3),
  ADD COLUMN "violationCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "terminatedAt" TIMESTAMPTZ(3),
  ADD COLUMN "terminationKind" TEXT,
  ADD COLUMN "reopenedAt" TIMESTAMPTZ(3),
  ADD COLUMN "reopenedById" TEXT,
  ADD COLUMN "resumeSeconds" INTEGER,
  ADD COLUMN "pageOpenedAt" TIMESTAMPTZ(3),
  ADD COLUMN "awaySince" TIMESTAMPTZ(3);

ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_reopenedById_fkey" FOREIGN KEY ("reopenedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "QuizAttemptEvent" ADD COLUMN "clientKey" TEXT;

CREATE UNIQUE INDEX "QuizAttemptEvent_attemptId_clientKey_key" ON "QuizAttemptEvent"("attemptId", "clientKey");
