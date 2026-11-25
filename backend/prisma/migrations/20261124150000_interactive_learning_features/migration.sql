-- Structured learning aids are rendered as safe native UI, not executable lesson HTML.
ALTER TABLE "Lesson"
  ADD COLUMN "visual" JSONB,
  ADD COLUMN "selfCheck" JSONB;
