-- Optional zero-cost built-in AI Study Coach for students in a class.
-- Teachers opt in per class; students only see summaries, flashcards, and ungraded
-- self-check questions generated strictly from published lessons using the built-in engine.
ALTER TABLE "Class"
  ADD COLUMN "aiStudyCoachEnabled" BOOLEAN NOT NULL DEFAULT false;
