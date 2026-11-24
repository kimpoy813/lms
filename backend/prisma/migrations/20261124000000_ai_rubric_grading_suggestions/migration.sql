-- AI grading is a teacher-private draft, separate from the official score and feedback.
ALTER TYPE "AIRequestType" ADD VALUE 'RUBRIC_GRADING';

ALTER TABLE "AssignmentSubmission"
  ADD COLUMN "aiGradingStatus" "AIGenerationStatus",
  ADD COLUMN "aiRubricSuggestions" JSONB,
  ADD COLUMN "aiGradingError" TEXT,
  ADD COLUMN "aiGradingModel" TEXT,
  ADD COLUMN "aiGradingStartedAt" TIMESTAMPTZ(3),
  ADD COLUMN "aiGradingCompletedAt" TIMESTAMPTZ(3);

CREATE INDEX "AssignmentSubmission_aiGradingStatus_aiGradingStartedAt_idx"
  ON "AssignmentSubmission"("aiGradingStatus", "aiGradingStartedAt");
