-- Party size, one-off sessions, prices, online payment for bookings, and the
-- payout wallet for money collected on an organization's behalf.
-- Idempotent: safe to re-run against a database that already has any part of it.

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "payoutDetails" TEXT;

ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "bookingUnit" TEXT NOT NULL DEFAULT 'BOOKING';
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "minPartySize" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "maxPartySize" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "recurringSlots" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "price" DECIMAL(12,2);
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "priceBasis" TEXT NOT NULL DEFAULT 'BOOKING';
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "paymentMode" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "depositPercent" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "refundCutoffHours" INTEGER NOT NULL DEFAULT 24;

ALTER TABLE "Slot" ADD COLUMN IF NOT EXISTS "isSession" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Slot" ADD COLUMN IF NOT EXISTS "label" TEXT;
ALTER TABLE "Slot" ADD COLUMN IF NOT EXISTS "price" DECIMAL(12,2);

ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "partySize" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "amount" DECIMAL(12,2);
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "amountDue" DECIMAL(12,2);
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "amountPaid" DECIMAL(12,2);
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "currency" TEXT;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "paymentStatus" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "paymentSource" TEXT;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "paymentProvider" TEXT;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "paymentRef" TEXT;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "paymentIntentRef" TEXT;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "paymentUrl" TEXT;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "paymentExpiresAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "Appointment_paymentRef_key" ON "Appointment"("paymentRef");
CREATE INDEX IF NOT EXISTS "Appointment_paymentStatus_paymentExpiresAt_idx" ON "Appointment"("paymentStatus", "paymentExpiresAt");

CREATE TABLE IF NOT EXISTS "OrgPaymentProvider" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publicKey" TEXT,
    "secretKey" TEXT NOT NULL,
    "webhookSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrgPaymentProvider_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrgPaymentProvider_organizationId_provider_key" ON "OrgPaymentProvider"("organizationId", "provider");

CREATE TABLE IF NOT EXISTS "PayoutLedgerEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "appointmentId" TEXT,
    "payoutRequestId" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayoutLedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PayoutLedgerEntry_externalRef_key" ON "PayoutLedgerEntry"("externalRef");
CREATE INDEX IF NOT EXISTS "PayoutLedgerEntry_organizationId_currency_availableAt_idx" ON "PayoutLedgerEntry"("organizationId", "currency", "availableAt");

CREATE TABLE IF NOT EXISTS "PayoutRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "details" TEXT,
    "note" TEXT,
    "requestedBy" TEXT,
    "reviewedBy" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    CONSTRAINT "PayoutRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PayoutRequest_organizationId_requestedAt_idx" ON "PayoutRequest"("organizationId", "requestedAt");
CREATE INDEX IF NOT EXISTS "PayoutRequest_status_idx" ON "PayoutRequest"("status");

CREATE TABLE IF NOT EXISTS "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

DO $$ BEGIN
  ALTER TABLE "OrgPaymentProvider" ADD CONSTRAINT "OrgPaymentProvider_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PayoutLedgerEntry" ADD CONSTRAINT "PayoutLedgerEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A plan's price in another currency (otherwise converted at the platform rate).
CREATE TABLE IF NOT EXISTS "PlanCurrencyPrice" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "priceMonthly" DECIMAL(12,2) NOT NULL,
    "priceQuarterly" DECIMAL(12,2) NOT NULL,
    "priceYearly" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlanCurrencyPrice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlanCurrencyPrice_planId_currency_key" ON "PlanCurrencyPrice"("planId", "currency");
DO $$ BEGIN
  ALTER TABLE "PlanCurrencyPrice" ADD CONSTRAINT "PlanCurrencyPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Organizations created before currencies existed take the currency of their plan,
-- so what they already pay (and any card subscription) stays in that currency.
-- Only touches organizations still on the default.
UPDATE "Organization" o SET "currency" = p."currency"
FROM "OrganizationSubscription" s
JOIN "SubscriptionPlan" p ON p."id" = s."planId"
WHERE o."subscriptionId" = s."id" AND o."currency" = 'USD' AND p."currency" <> 'USD';
