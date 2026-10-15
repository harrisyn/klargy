-- Booked patients placed in line by their booked time when they arrive on
-- time (docs/guides/outpatient-journey.md).
-- Idempotent: safe to re-run against a database that already has any part of it.

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "bookedArrivalSettings" JSONB;

ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "appointmentId" TEXT;
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "bookedFor" TIMESTAMP(3);
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "bookedPlaceAt" TIMESTAMP(3);
