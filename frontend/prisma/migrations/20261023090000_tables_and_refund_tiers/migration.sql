-- Named tables (rooms, chairs, courts...) bookings are assigned to, and refund
-- tiers by notice. Idempotent: safe to re-run against a database that already has any part of it.

ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "refundTiers" JSONB;
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "tableMode" TEXT NOT NULL DEFAULT 'NONE';

CREATE TABLE IF NOT EXISTS "Room" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "onlineBookable" BOOLEAN NOT NULL DEFAULT true,
    "minPartySize" INTEGER,
    "maxPartySize" INTEGER,
    "openTime" TEXT,
    "closeTime" TEXT,
    "activeDays" TEXT,
    "allowCombine" BOOLEAN NOT NULL DEFAULT true,
    "layoutWidth" INTEGER NOT NULL DEFAULT 1000,
    "layoutHeight" INTEGER NOT NULL DEFAULT 700,
    "layoutImageUrl" TEXT,
    "layoutImageFileId" TEXT,
    "priceMode" TEXT NOT NULL DEFAULT 'INHERIT',
    "price" DECIMAL(12,2),
    "priceBasis" TEXT NOT NULL DEFAULT 'BOOKING',
    "paymentMode" TEXT,
    "depositPercent" INTEGER,
    "refundCutoffHours" INTEGER,
    "refundTiers" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Room_locationId_name_key" ON "Room"("locationId", "name");

CREATE TABLE IF NOT EXISTS "DiningTable" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "roomId" TEXT,
    "name" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "area" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "width" DOUBLE PRECISION NOT NULL DEFAULT 90,
    "height" DOUBLE PRECISION NOT NULL DEFAULT 90,
    "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "shape" TEXT NOT NULL DEFAULT 'RECT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiningTable_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DiningTable_locationId_name_key" ON "DiningTable"("locationId", "name");

ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "roomId" TEXT;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "roomId" TEXT;
ALTER TABLE "ServicePointInstance" ADD COLUMN IF NOT EXISTS "roomId" TEXT;

CREATE TABLE IF NOT EXISTS "BookingTable" (
    "appointmentId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    CONSTRAINT "BookingTable_pkey" PRIMARY KEY ("appointmentId", "tableId")
);
CREATE INDEX IF NOT EXISTS "BookingTable_tableId_idx" ON "BookingTable"("tableId");

DO $$ BEGIN
  ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BookingTable" ADD CONSTRAINT "BookingTable_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BookingTable" ADD CONSTRAINT "BookingTable_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Room" ADD CONSTRAINT "Room_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Service" ADD CONSTRAINT "Service_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ServicePointInstance" ADD CONSTRAINT "ServicePointInstance_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
