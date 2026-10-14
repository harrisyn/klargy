-- Klargy Connect v1, phase 3: the desk inside the EMR.
-- Idempotent: safe to re-run against a database that already has any part of it.

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeskLaunchCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "servicePointId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeskLaunchCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeskLaunchCode_codeHash_key" ON "DeskLaunchCode"("codeHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeskLaunchCode_integrationId_idx" ON "DeskLaunchCode"("integrationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeskLaunchCode_createdAt_idx" ON "DeskLaunchCode"("createdAt");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeskLaunchCode_integrationId_fkey') THEN
        ALTER TABLE "DeskLaunchCode" ADD CONSTRAINT "DeskLaunchCode_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeskLaunchCode_userId_fkey') THEN
        ALTER TABLE "DeskLaunchCode" ADD CONSTRAINT "DeskLaunchCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Existing API keys get the desk:launch scope (new keys get every scope).
UPDATE "Integration"
SET "scopes" = COALESCE("scopes", ARRAY[]::TEXT[]) || ARRAY['desk:launch']::TEXT[]
WHERE NOT ('desk:launch' = ANY(COALESCE("scopes", ARRAY[]::TEXT[])));
