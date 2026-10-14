-- Klargy Connect v1, phase 2: queue entries by reference.
-- Idempotent: safe to re-run against a database that already has any part of it.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConnectIdempotencyKey" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 0,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConnectIdempotencyKey_createdAt_idx" ON "ConnectIdempotencyKey"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ConnectIdempotencyKey_integrationId_key_key" ON "ConnectIdempotencyKey"("integrationId", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QueueEntry_updatedAt_idx" ON "QueueEntry"("updatedAt");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ConnectIdempotencyKey_integrationId_fkey') THEN
        ALTER TABLE "ConnectIdempotencyKey" ADD CONSTRAINT "ConnectIdempotencyKey_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Existing API keys get the phase 2 scopes (new keys get every scope).
UPDATE "Integration"
SET "scopes" = COALESCE("scopes", ARRAY[]::TEXT[]) || ARRAY(
    SELECT s FROM unnest(ARRAY['patients:write', 'entries:read', 'entries:write']::TEXT[]) AS s
    WHERE NOT (s = ANY(COALESCE("scopes", ARRAY[]::TEXT[])))
)
WHERE NOT (COALESCE("scopes", ARRAY[]::TEXT[]) @> ARRAY['patients:write', 'entries:read', 'entries:write']::TEXT[]);
