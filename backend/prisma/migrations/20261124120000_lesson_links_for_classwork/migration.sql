-- Work may be linked to a lesson as well as its parent module. Existing work stays unlinked.
ALTER TABLE "Assignment" ADD COLUMN "lessonId" TEXT;
ALTER TABLE "Quiz" ADD COLUMN "lessonId" TEXT;

CREATE INDEX "Assignment_lessonId_idx" ON "Assignment"("lessonId");
CREATE INDEX "Quiz_lessonId_idx" ON "Quiz"("lessonId");

ALTER TABLE "Assignment"
  ADD CONSTRAINT "Assignment_lessonId_fkey"
  FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Quiz"
  ADD CONSTRAINT "Quiz_lessonId_fkey"
  FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;
