-- Platform services: S3-compatible file storage settings and the platform's
-- shared WhatsApp sender.
ALTER TABLE "FileStorageProviderConfig" ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "PlatformWhatsAppConfig" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "provider" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformWhatsAppConfig_pkey" PRIMARY KEY ("id")
);

-- WhatsApp messages are part of Pro (the seeded plans predate the feature).
UPDATE "SubscriptionPlan"
SET "features" = "features" || '{"whatsappNotifications": true}'::jsonb
WHERE "code" = 'pro' AND NOT ("features" ? 'whatsappNotifications');
