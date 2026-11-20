-- Teacher-controlled anonymous class ranking for released grades.
-- Each enrolled student receives an unlinkable per-class secret code (`Enrollment.rankingCode`)
-- so classmates can view standings without revealing names, e-mails, or student numbers.
ALTER TABLE "Class"
  ADD COLUMN "gradeRankingEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "gradeRankingShowScores" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Enrollment"
  ADD COLUMN "rankingCode" TEXT;

CREATE UNIQUE INDEX "Enrollment_classId_rankingCode_key"
  ON "Enrollment"("classId", "rankingCode");
