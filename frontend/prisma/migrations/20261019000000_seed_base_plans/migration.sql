-- Seed the base plans (Starter, Pro, Sandbox) and their credit allowances.
-- Earlier migrations only created Free; these were created through the admin
-- UI locally, so a fresh deployment had no paid plans.
--
-- Idempotent and non-destructive: a plan that already exists (by code) is left
-- untouched, so edits made in the admin UI are never overwritten.

-- 1. Free: align with the intended limits, but only while it is still exactly
-- as the original seed migration created it (not edited by an admin).
UPDATE "SubscriptionPlan"
SET
  "maxServicesPerLoc" = 1,
  "maxUsersPerOrg" = 1,
  "maxQueueEntriesPerDay" = 100,
  "features" = '{"analytics": false, "apiAccess": false, "customDomain": false, "serviceFlows": false, "multiLocation": false, "servicePoints": true, "customBranding": false, "smsNotifications": false}'::jsonb
WHERE "code" = 'free'
  AND "maxLocations" = 1
  AND "maxServicesPerLoc" = 3
  AND "maxUsersPerOrg" = 5
  AND "maxQueueEntriesPerDay" IS NULL;

-- 2. Plans (fallback/upgrade links are wired by code in step 3).
INSERT INTO "SubscriptionPlan" (
  "id", "name", "code", "description",
  "priceMonthly", "priceQuarterly", "priceYearly", "currency",
  "maxLocations", "maxServicesPerLoc", "maxUsersPerOrg", "maxQueueEntriesPerDay",
  "features", "displayOrder", "tierRank", "isActive", "isDefault", "isRecommended",
  "trialDurationDays", "createdAt", "updatedAt"
) VALUES
(
  gen_random_uuid(), 'Starter', 'starter', NULL,
  100, 270, 1000, 'USD',
  2, 3, 5, 500,
  '{"analytics": true, "apiAccess": false, "displayMedia": true, "serviceFlows": false, "multiLocation": true, "servicePoints": true, "customBranding": false, "smsNotifications": true}'::jsonb,
  1, 1, true, false, true,
  14, now(), now()
),
(
  gen_random_uuid(), 'Pro', 'pro', 'For growing multi-location organizations',
  300, 870, 3000, 'USD',
  5, 10, 10, NULL,
  '{"analytics": true, "apiAccess": true, "whiteLabel": true, "customDomain": true, "displayMedia": true, "serviceFlows": true, "multiLocation": true, "servicePoints": true, "customBranding": true, "dataIntegration": true, "prioritySupport": true, "smsNotifications": true, "multipleLocations": true, "emailNotifications": true}'::jsonb,
  2, 2, true, false, false,
  7, now(), now()
),
(
  gen_random_uuid(), 'Sandbox', 'sandbox', 'For EMR teams testing Klargy Connect. Not offered to customers.',
  0, 0, 0, 'USD',
  3, 20, 25, 500,
  '{"ai": false, "analytics": true, "apiAccess": true, "customDomain": false, "serviceFlows": true, "multiLocation": true, "servicePoints": true, "customBranding": false, "emrIntegration": true, "smsNotifications": false}'::jsonb,
  999, 0, false, false, false,
  NULL, now(), now()
)
ON CONFLICT ("code") DO NOTHING;

-- 3. Tier links, set only where not already set.
UPDATE "SubscriptionPlan"
SET "expiredFallbackPlanId" = (SELECT "id" FROM "SubscriptionPlan" WHERE "code" = 'free'),
    "upgradePlanId"         = (SELECT "id" FROM "SubscriptionPlan" WHERE "code" = 'pro')
WHERE "code" = 'starter' AND "expiredFallbackPlanId" IS NULL AND "upgradePlanId" IS NULL;

UPDATE "SubscriptionPlan"
SET "expiredFallbackPlanId" = (SELECT "id" FROM "SubscriptionPlan" WHERE "code" = 'starter')
WHERE "code" = 'pro' AND "expiredFallbackPlanId" IS NULL;

UPDATE "SubscriptionPlan"
SET "upgradePlanId" = (SELECT "id" FROM "SubscriptionPlan" WHERE "code" = 'starter')
WHERE "code" = 'free' AND "upgradePlanId" IS NULL;

-- 4. Credit allowances (NULL = unlimited). Existing rows are left alone.
INSERT INTO "PlanCreditAllowance" ("id", "planId", "creditType", "monthlyAllowance", "createdAt", "updatedAt")
SELECT gen_random_uuid(), p."id", v."creditType"::"CreditType", v."allowance", now(), now()
FROM (VALUES
  ('free',    'AI',    NULL::int),
  ('free',    'EMAIL', NULL),
  ('free',    'SMS',   NULL),
  ('starter', 'AI',    NULL),
  ('starter', 'EMAIL', NULL),
  ('starter', 'SMS',   NULL),
  ('pro',     'AI',    500),
  ('pro',     'EMAIL', NULL),
  ('pro',     'SMS',   200)
) AS v("code", "creditType", "allowance")
JOIN "SubscriptionPlan" p ON p."code" = v."code"
ON CONFLICT ("planId", "creditType") DO NOTHING;
