-- One-time token for first-run superadmin setup (services/setup.service.ts).
-- Idempotent: safe to re-run against a database that already has it.

CREATE TABLE IF NOT EXISTS "SetupToken" (
    "id" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetupToken_pkey" PRIMARY KEY ("id")
);
