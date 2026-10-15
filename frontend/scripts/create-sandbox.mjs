/*
 * Creates (or brings up to date) a Klargy Connect sandbox workspace for an
 * EMR team to integrate against (docs/connect/guide.md, "Testing in the
 * sandbox"):
 *
 *   npm run sandbox:create -- --name "Acme EMR sandbox"
 *
 * An organisation on the "sandbox" plan (free, not offered to customers,
 * with EMR connections switched on), one location, the services GP
 * Consultation, Laboratory, Pharmacy and Cashier with service points and
 * flows, an admin user, and an EMR integration with an API key. Safe to run
 * again: what exists is kept. The admin password and the API key are shown
 * only when they are created (or reset with --reset-password /
 * --rotate-key), because Klargy stores neither.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import prismaClient from '@prisma/client';

const { PrismaClient } = prismaClient;
const here = path.dirname(fileURLToPath(import.meta.url));

// The repo-root .env (as docker-compose uses), then frontend/.env, without
// overriding what the shell already set.
for (const file of [path.join(here, '../../.env'), path.join(here, '../.env')]) {
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(file);
    } catch {
      /* unreadable .env: rely on the environment */
    }
  }
}

// Same format and scopes as the admin screen (src/server/lib/apiKeys.ts,
// src/server/middleware/integrationAuth.middleware.ts).
const API_KEY_PREFIX = 'klg_live_';
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CONNECT_SCOPES = [
  'integration:write',
  'catalog:read',
  'catalog:write',
  'patients:write',
  'entries:read',
  'entries:write',
  'desk:launch',
  'appointments:write',
  'analytics:read',
];

const SANDBOX_PLAN = {
  code: 'sandbox',
  name: 'Sandbox',
  description: 'For EMR teams testing Klargy Connect. Not offered to customers.',
  priceMonthly: 0,
  priceYearly: 0,
  priceQuarterly: 0,
  maxLocations: 3,
  maxServicesPerLoc: 20,
  maxUsersPerOrg: 25,
  maxQueueEntriesPerDay: 500,
  maxQueueEntriesPerPeriod: null,
  features: {
    emrIntegration: true,
    apiAccess: true,
    analytics: true,
    serviceFlows: true,
    servicePoints: true,
    multiLocation: true,
    smsNotifications: false,
    customBranding: false,
    customDomain: false,
    ai: false,
  },
  isActive: false, // never listed on the plans page
  isDefault: false,
  displayOrder: 999,
};

const SERVICES = [
  { key: 'gp', name: 'GP Consultation', description: 'Sandbox clinic' },
  { key: 'lab', name: 'Laboratory', description: 'Sandbox laboratory' },
  { key: 'pharmacy', name: 'Pharmacy', description: 'Sandbox pharmacy' },
  { key: 'cashier', name: 'Cashier', description: 'Sandbox cashier' },
];

const SERVICE_POINTS = [
  { name: 'Consulting Room 1', type: 'CONSULTATION', serves: 'gp' },
  { name: 'Consulting Room 2', type: 'CONSULTATION', serves: 'gp' },
  { name: 'Laboratory', type: 'LAB', serves: 'lab' },
  { name: 'Pharmacy', type: 'PHARMACY', serves: 'pharmacy' },
  { name: 'Cashier', type: 'CASHIER', serves: 'cashier' },
];

// Staff send patients on by hand (or the EMR does, with transfer); paying
// at the cashier sends them on to the pharmacy by itself.
const FLOWS = [
  { from: 'gp', to: 'cashier', priority: 0, autoTransfer: false },
  { from: 'gp', to: 'lab', priority: 1, autoTransfer: false },
  { from: 'lab', to: 'cashier', priority: 0, autoTransfer: false },
  { from: 'cashier', to: 'pharmacy', priority: 0, autoTransfer: true },
];

const USAGE = `Usage: npm run sandbox:create -- --name "Acme EMR sandbox" [options]

  --name <name>              Workspace name (required). "(sandbox)" is added if it lacks the word.
  --slug <slug>              Subdomain; defaults to one made from the name.
  --admin-email <email>      Admin login; defaults to <slug>-admin@example.com.
  --admin-password <pw>      Admin password when the admin is created; defaults to a random one.
  --timezone <tz>            Location timezone (IANA), default UTC.
  --location <name>          Location name, default "Main Clinic".
  --integration <name>       EMR connection name, default "Sandbox EMR".
  --rotate-key               Issue a new API key for an existing integration.
  --reset-password           Set a new admin password for an existing admin.
`;

function parseArgs(argv) {
  const opts = {};
  const flags = new Set(['rotate-key', 'reset-password', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    if (flags.has(key)) {
      opts[key] = true;
      continue;
    }
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    opts[key] = value;
  }
  return opts;
}

function slugify(input) {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || 'sandbox';
}

function generateApiKey() {
  const bytes = crypto.randomBytes(40);
  const key = API_KEY_PREFIX + Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
  return { key, hash: crypto.createHash('sha256').update(key).digest('hex'), prefix: key.slice(0, 12) };
}

function workspaceUrl(slug) {
  const base = new URL((process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:8003').replace(/\/$/, ''));
  base.host = `${slug}.${base.host}`;
  return base.toString().replace(/\/$/, '');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!opts.name || !opts.name.trim()) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  let name = opts.name.trim().slice(0, 100);
  if (!/sandbox/i.test(name)) name = `${name} (sandbox)`;
  const slug = opts.slug ? slugify(opts.slug) : slugify(name);
  const adminEmail = (opts['admin-email'] || `${slug}-admin@example.com`).trim().toLowerCase();
  const timezone = opts.timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error(`Unknown timezone: ${timezone}`);
  }
  const locationName = opts.location || 'Main Clinic';
  const integrationName = opts.integration || 'Sandbox EMR';

  const prisma = new PrismaClient();
  try {
    const done = [];

    // 1. The plan: EMR connections on, free, never offered to customers. An
    // existing sandbox plan is left as a superadmin may have tuned it.
    let plan = await prisma.subscriptionPlan.findUnique({ where: { code: SANDBOX_PLAN.code } });
    if (!plan) {
      plan = await prisma.subscriptionPlan.create({ data: SANDBOX_PLAN });
      done.push('created the "sandbox" plan');
    }
    if (!(plan.features && plan.features.emrIntegration === true)) {
      console.warn('Warning: the "sandbox" plan has EMR connections switched off; Connect calls will be refused (403).');
    }

    // 2. The organisation, on that plan. Never touches a workspace that isn't a sandbox.
    let org = await prisma.organization.findUnique({
      where: { slug },
      include: { subscription: { include: { plan: { select: { code: true } } } } },
    });
    if (org && org.subscription?.plan.code !== SANDBOX_PLAN.code) {
      throw new Error(`The workspace "${slug}" exists and is not a sandbox. Choose another --slug.`);
    }
    if (!org) {
      const now = new Date();
      const subscription = await prisma.organizationSubscription.create({
        data: {
          planId: plan.id,
          status: 'ACTIVE',
          billingCycle: 'yearly',
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()),
        },
      });
      org = await prisma.organization.create({
        data: { name, slug, email: adminEmail, industry: 'HEALTHCARE', subscriptionId: subscription.id },
        include: { subscription: { include: { plan: { select: { code: true } } } } },
      });
      done.push(`created the workspace "${name}"`);
    }
    const organizationId = org.id;

    // 3. Location.
    let location = await prisma.location.findFirst({ where: { organizationId, name: locationName } });
    if (!location) {
      location = await prisma.location.create({ data: { organizationId, name: locationName, timezone, address: 'Sandbox' } });
      done.push(`created the location "${locationName}"`);
    }

    // 4. Services, open every day so tickets can be issued whenever the EMR team tests.
    const services = {};
    for (const s of SERVICES) {
      let service = await prisma.service.findFirst({ where: { locationId: location.id, name: s.name } });
      if (!service) {
        service = await prisma.service.create({
          data: {
            locationId: location.id,
            name: s.name,
            description: s.description,
            activeDays: '0,1,2,3,4,5,6',
            startTime: '00:00',
            endTime: '23:59',
            requiresName: true,
          },
        });
        done.push(`created the service "${s.name}"`);
      }
      services[s.key] = service;
    }

    // 5. Service points (rooms), each with one desk for its service.
    for (const sp of SERVICE_POINTS) {
      let point = await prisma.servicePoint.findFirst({ where: { organizationId, name: sp.name } });
      if (!point) {
        point = await prisma.servicePoint.create({
          data: { organizationId, name: sp.name, displayName: sp.name, type: sp.type, capacity: 1 },
        });
        done.push(`created the service point "${sp.name}"`);
      }
      const serviceId = services[sp.serves].id;
      const link = await prisma.servicePointService.upsert({
        where: { servicePointId_serviceId: { servicePointId: point.id, serviceId } },
        create: { servicePointId: point.id, serviceId, capacity: 1 },
        update: {},
      });
      const desk = await prisma.servicePointInstance.findFirst({ where: { servicePointServiceId: link.id, instanceNumber: 1 } });
      if (!desk) {
        await prisma.servicePointInstance.create({
          data: { servicePointServiceId: link.id, instanceNumber: 1, displayName: `${sp.name} 1`, isActive: true },
        });
      }
    }

    // 6. Flows between the services.
    for (const f of FLOWS) {
      const fromServiceId = services[f.from].id;
      const toServiceId = services[f.to].id;
      const existing = await prisma.serviceFlow.findUnique({ where: { fromServiceId_toServiceId: { fromServiceId, toServiceId } } });
      if (!existing) {
        await prisma.serviceFlow.create({
          data: { fromServiceId, toServiceId, priority: f.priority, autoTransfer: f.autoTransfer },
        });
        done.push(`created the flow ${services[f.from].name} → ${services[f.to].name}${f.autoTransfer ? ' (automatic)' : ''}`);
      }
    }

    // 7. Admin user.
    let password = null;
    let admin = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (admin && admin.organizationId !== organizationId) {
      throw new Error(`${adminEmail} belongs to another workspace. Pass --admin-email.`);
    }
    if (!admin) {
      password = opts['admin-password'] || crypto.randomBytes(12).toString('base64url');
      admin = await prisma.user.create({
        data: {
          email: adminEmail,
          password: await bcrypt.hash(password, 10),
          firstName: 'Sandbox',
          lastName: 'Admin',
          role: 'ORG_ADMIN',
          organizationId,
        },
      });
      done.push(`created the admin ${adminEmail}`);
    } else if (opts['reset-password']) {
      password = opts['admin-password'] || crypto.randomBytes(12).toString('base64url');
      await prisma.user.update({ where: { id: admin.id }, data: { password: await bcrypt.hash(password, 10), isActive: true } });
      done.push(`reset the password of ${adminEmail}`);
    }

    // 8. EMR integration and its key.
    let apiKey = null;
    let integration = await prisma.integration.findFirst({
      where: { organizationId, name: integrationName, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (!integration) {
      const { key, hash, prefix } = generateApiKey();
      integration = await prisma.integration.create({
        data: {
          organizationId,
          name: integrationName,
          keyHash: hash,
          keyPrefix: prefix,
          scopes: CONNECT_SCOPES,
          embedOrigins: [],
          createdById: admin.id,
        },
      });
      apiKey = key;
      done.push(`created the EMR connection "${integrationName}"`);
    } else {
      const missing = CONNECT_SCOPES.filter((s) => !integration.scopes.includes(s));
      const data = missing.length ? { scopes: [...integration.scopes, ...missing] } : {};
      if (opts['rotate-key']) {
        const { key, hash, prefix } = generateApiKey();
        Object.assign(data, { keyHash: hash, keyPrefix: prefix });
        apiKey = key;
        done.push(`issued a new API key for "${integrationName}"`);
      }
      if (Object.keys(data).length) integration = await prisma.integration.update({ where: { id: integration.id }, data });
    }

    const url = workspaceUrl(slug);
    console.log(done.length ? `Sandbox ready (${done.join('; ')}).` : 'Sandbox ready (nothing to change).');
    console.log('');
    console.log(`Workspace:        ${org.name}`);
    console.log(`Workspace URL:    ${url}`);
    console.log(`Connect base URL: ${url}/api/v1/connect/v1`);
    console.log(`Admin login:      ${adminEmail}`);
    console.log(`Admin password:   ${password ?? '(unchanged; pass --reset-password for a new one)'}`);
    console.log(`Integration:      ${integration.name} (${integration.id})`);
    console.log(`API key:          ${apiKey ?? `(unchanged, starts ${integration.keyPrefix}; pass --rotate-key for a new one)`}`);
    console.log(`Services:         ${SERVICES.map((s) => `${s.name} (${services[s.key].id})`).join(', ')}`);
    if (apiKey || password) {
      console.log('');
      console.log('Copy the API key and password now: Klargy stores only hashes and cannot show them again.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
