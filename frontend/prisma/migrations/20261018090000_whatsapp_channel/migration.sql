-- WhatsApp as a per-organisation notification channel.
-- Idempotent: safe to re-run against a database that already has any part of it.

-- Notifications sent on WhatsApp.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'NotificationChannel' AND e.enumlabel = 'WHATSAPP'
    ) THEN
        ALTER TYPE "NotificationChannel" ADD VALUE 'WHATSAPP';
    END IF;
END $$;

-- Delivery tracking reported by the provider's status webhook.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "deliveryError" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "statusUpdatedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Notification_providerMessageId_idx" ON "Notification"("providerMessageId");

-- Each organisation's own WhatsApp sender.
CREATE TABLE IF NOT EXISTS "WhatsAppConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "verifyToken" TEXT NOT NULL,
    "templates" JSONB NOT NULL DEFAULT '{}',
    "fallbackToSms" BOOLEAN NOT NULL DEFAULT true,
    "consentMode" TEXT NOT NULL DEFAULT 'EXPLICIT',
    "defaultCountryCode" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsAppConfig_organizationId_key" ON "WhatsAppConfig"("organizationId");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WhatsAppConfig_organizationId_fkey') THEN
        ALTER TABLE "WhatsAppConfig" ADD CONSTRAINT "WhatsAppConfig_organizationId_fkey"
            FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Consent and the 24-hour conversation window, per number and organisation.
CREATE TABLE IF NOT EXISTS "WhatsAppContact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "optedIn" BOOLEAN NOT NULL DEFAULT false,
    "optedInAt" TIMESTAMP(3),
    "optedOutAt" TIMESTAMP(3),
    "source" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppContact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsAppContact_organizationId_phone_key" ON "WhatsAppContact"("organizationId", "phone");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WhatsAppContact_organizationId_fkey') THEN
        ALTER TABLE "WhatsAppContact" ADD CONSTRAINT "WhatsAppContact_organizationId_fkey"
            FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
