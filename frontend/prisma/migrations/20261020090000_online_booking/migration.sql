-- Public online booking: per-service booking mode, and a private manage link
-- on appointments booked by the customer.
-- Idempotent: safe to re-run against a database that already has any part of it.

ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "bookingMode" TEXT NOT NULL DEFAULT 'WALK_IN';
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'STAFF';
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "manageToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Appointment_manageToken_key" ON "Appointment"("manageToken");
