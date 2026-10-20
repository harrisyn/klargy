-- AlterTable
ALTER TABLE "OrganizationSubscription"
  ADD COLUMN "walletManaged" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "customPrice" DECIMAL(65,30),
  ADD COLUMN "planOverrideUntil" TIMESTAMP(3),
  ADD COLUMN "planOverrideRevertPlanId" TEXT,
  ADD COLUMN "planOverrideRevertPeriodEnd" TIMESTAMP(3),
  ADD COLUMN "planOverrideEndBehavior" TEXT;

-- CreateTable
CREATE TABLE "WalletLedgerEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorUserId" TEXT,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletLedgerEntry_externalRef_key" ON "WalletLedgerEntry"("externalRef");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_organizationId_currency_createdAt_idx" ON "WalletLedgerEntry"("organizationId", "currency", "createdAt");

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
