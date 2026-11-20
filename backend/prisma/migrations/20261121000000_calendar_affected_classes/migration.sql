-- Multi-class calendar events & teacher leave/absence notifications.
-- Lets teachers create an event (leave, sick, conference, etc.) spanning any date/time range,
-- match all scheduled class meetings that overlap it, and notify enrolled students.

ALTER TYPE "CalendarScope" ADD VALUE 'CLASSES';
ALTER TYPE "CalendarEventType" ADD VALUE 'TEACHER_LEAVE';

CREATE TABLE "CalendarEventClass" (
  "eventId" TEXT NOT NULL,
  "classId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CalendarEventClass_pkey" PRIMARY KEY ("eventId", "classId")
);

CREATE INDEX "CalendarEventClass_classId_idx" ON "CalendarEventClass"("classId");

ALTER TABLE "CalendarEventClass"
  ADD CONSTRAINT "CalendarEventClass_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CalendarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CalendarEventClass"
  ADD CONSTRAINT "CalendarEventClass_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;
