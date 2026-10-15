-- Klargy Connect v1, phase 5: journey automation.
-- Idempotent: safe to re-run against a database that already has any part of it.

-- Patients told their queue is paused (once per pause).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'NotificationType' AND e.enumlabel = 'QUEUE_DELAYED'
    ) THEN
        ALTER TYPE "NotificationType" ADD VALUE 'QUEUE_DELAYED';
    END IF;
END $$;

-- Appointments booked in the EMR keep their own times and need no Klargy
-- slot or Klargy staff member who booked them.
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "startTime" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "endTime" TIMESTAMP(3);

UPDATE "Appointment" a
SET "startTime" = s."startTime", "endTime" = COALESCE(a."endTime", s."endTime")
FROM "Slot" s
WHERE a."slotId" = s."id" AND a."startTime" IS NULL;

UPDATE "Appointment" SET "startTime" = "createdAt" WHERE "startTime" IS NULL;

ALTER TABLE "Appointment" ALTER COLUMN "startTime" SET NOT NULL;
ALTER TABLE "Appointment" ALTER COLUMN "slotId" DROP NOT NULL;
ALTER TABLE "Appointment" ALTER COLUMN "createdBy" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "Appointment_startTime_idx" ON "Appointment"("startTime");

-- Existing API keys get the phase 5 scopes (new keys get every scope).
UPDATE "Integration"
SET "scopes" = COALESCE("scopes", ARRAY[]::TEXT[]) || ARRAY['appointments:write']::TEXT[]
WHERE "kind" = 'EMR' AND NOT ('appointments:write' = ANY(COALESCE("scopes", ARRAY[]::TEXT[])));

UPDATE "Integration"
SET "scopes" = COALESCE("scopes", ARRAY[]::TEXT[]) || ARRAY['analytics:read']::TEXT[]
WHERE "kind" = 'EMR' AND NOT ('analytics:read' = ANY(COALESCE("scopes", ARRAY[]::TEXT[])));
