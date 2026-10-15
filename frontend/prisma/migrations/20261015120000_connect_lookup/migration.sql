-- Klargy Connect v1, phase 4: patient lookup through the EMR.
-- Idempotent: safe to re-run against a database that already has any part of it.

-- A data source that asks a connected system (Klargy Connect lookupUrl).
ALTER TYPE "DataSourceType" ADD VALUE IF NOT EXISTS 'INTEGRATION';

-- Kiosk and public join: ask for an MR or member number and check it with
-- the connected system before issuing a ticket. Null = off.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "joinIdentifierType" TEXT;
