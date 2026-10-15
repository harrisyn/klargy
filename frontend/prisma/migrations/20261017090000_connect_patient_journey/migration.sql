-- Klargy Connect v1, phase 6: the patient journey (hold, payment gate,
-- patients moving themselves on, first point of contact).
-- Idempotent: safe to re-run against a database that already has any part of it.

ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "heldAt" TIMESTAMP(3);
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "deskInstanceId" TEXT;
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "awaitingClearance" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "sentBy" TEXT;

CREATE INDEX IF NOT EXISTS "QueueEntry_previousEntryId_idx" ON "QueueEntry"("previousEntryId");

ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "requiresClearance" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "defaultServiceId" TEXT;
