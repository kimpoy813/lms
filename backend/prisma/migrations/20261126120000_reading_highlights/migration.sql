-- Words a reader marked inside a lesson, kept per person and located again when the lesson is drawn.
CREATE TABLE "ReadingHighlight" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "quote" TEXT NOT NULL,
  "context" TEXT NOT NULL,
  "colour" TEXT NOT NULL DEFAULT 'yellow',
  "note" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "ReadingHighlight_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReadingHighlight_userId_lessonId_idx" ON "ReadingHighlight" ("userId", "lessonId");
CREATE INDEX "ReadingHighlight_lessonId_idx" ON "ReadingHighlight" ("lessonId");

ALTER TABLE "ReadingHighlight"
  ADD CONSTRAINT "ReadingHighlight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReadingHighlight"
  ADD CONSTRAINT "ReadingHighlight_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
