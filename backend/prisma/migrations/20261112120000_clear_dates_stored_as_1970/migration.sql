-- Repairs dates that were stored as 1 January 1970 (UTC).
--
-- Until this version the API read a date that a form had sent as "none" (null) as the start of
-- the Unix epoch. A module created with "Available until" left empty was therefore closed to
-- students, and gradebook columns, assignments and quizzes could carry the same date. Nobody
-- sets that instant on purpose, so every such value is cleared: the date becomes "none", which
-- is what had been asked for. Only data changes, the tables stay as they are.

UPDATE "LearningModule" SET "availableUntil" = NULL WHERE "availableUntil" = TIMESTAMPTZ '1970-01-01 00:00:00+00';

UPDATE "Assignment" SET "availableFrom" = NULL WHERE "availableFrom" = TIMESTAMPTZ '1970-01-01 00:00:00+00';
UPDATE "Assignment" SET "dueAt" = NULL WHERE "dueAt" = TIMESTAMPTZ '1970-01-01 00:00:00+00';
UPDATE "Assignment" SET "closeAt" = NULL WHERE "closeAt" = TIMESTAMPTZ '1970-01-01 00:00:00+00';

UPDATE "Quiz" SET "availableFrom" = NULL WHERE "availableFrom" = TIMESTAMPTZ '1970-01-01 00:00:00+00';
UPDATE "Quiz" SET "availableUntil" = NULL WHERE "availableUntil" = TIMESTAMPTZ '1970-01-01 00:00:00+00';

UPDATE "GradeItem" SET "dueAt" = NULL WHERE "dueAt" = TIMESTAMPTZ '1970-01-01 00:00:00+00';
