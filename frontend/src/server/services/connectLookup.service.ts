import crypto from 'crypto';
import prisma from '../lib/prisma';
import { decrypt } from '../lib/encryption';
import { assertPublicUrl } from '../lib/urlSafety';
import { signPayload } from './webhooks.service';

/**
 * Klargy Connect v1, phase 4 (docs/connect/v1.md section 7): asking the
 * connected system (the EMR) who a patient is. Klargy calls the
 * integration's lookupUrl, signed like a webhook; the EMR searches its own
 * records and runs any cover check. Never retried inside a user's request.
 */

export const LOOKUP_IDENTIFIER_TYPES = ['mrNumber', 'memberNumber', 'phone', 'nationalId', 'passport', 'patientRef'] as const;
export type LookupIdentifierType = (typeof LOOKUP_IDENTIFIER_TYPES)[number];
export type LookupContext = 'staff' | 'public';
/** What a kiosk or the public join page may ask for. */
export const JOIN_IDENTIFIER_TYPES = ['mrNumber', 'memberNumber'] as const;

export const LOOKUP_TIMEOUT_MS = 5000;

export interface LookupCover {
  payer: string;
  plan: string | null;
  memberNumber: string | null;
  status: 'active' | 'expired' | 'inactive' | 'unknown';
  expiresOn: string | null;
  checkedVia: 'payer' | 'records' | null;
  message: string | null;
}

export interface LookupPatient {
  ref?: string;
  displayName?: string;
  firstName?: string;
  mrNumber?: string | null;
  birthDate?: string | null;
  gender?: string | null;
  phoneMasked?: string | null;
  photoUrl?: string | null;
  identifiers?: Record<string, string | null>;
  cover?: LookupCover | null;
  flags?: string[];
}

export interface LookupResult {
  matched: boolean;
  patient: LookupPatient | null;
  candidates: { ref: string; displayName: string; mrNumber: string | null; birthDate: string | null; phoneMasked: string | null }[];
}

/** The lookup couldn't be run: nothing set up (409), or the EMR failed (502). */
export class LookupError extends Error {
  constructor(message: string, public code: 'LOOKUP_NOT_CONFIGURED' | 'LOOKUP_FAILED') {
    super(message);
  }
  get status() {
    return this.code === 'LOOKUP_NOT_CONFIGURED' ? 409 : 502;
  }
}

export interface LookupIntegration {
  id: string;
  organizationId: string;
  name: string;
  lookupUrl: string | null;
  webhookEndpoint: { encryptedSecret: string } | null;
}

const LOOKUP_INTEGRATION_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  lookupUrl: true,
  webhookEndpoint: { select: { encryptedSecret: true } },
} as const;

/** The organisation's connected system that answers lookups: an active
 * integration with a lookupUrl (the oldest, when there are several), or one
 * named integration. */
export async function lookupIntegrationFor(organizationId: string, integrationId?: string): Promise<LookupIntegration | null> {
  return prisma.integration.findFirst({
    where: {
      organizationId,
      status: 'ACTIVE',
      lookupUrl: { not: null },
      webhookEndpointId: { not: null },
      ...(integrationId ? { id: integrationId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: LOOKUP_INTEGRATION_SELECT,
  });
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);
const COVER_STATUSES = ['active', 'expired', 'inactive', 'unknown'] as const;

function readCover(raw: unknown): LookupCover | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const status = COVER_STATUSES.includes(c.status as never) ? (c.status as LookupCover['status']) : 'unknown';
  return {
    payer: str(c.payer) ?? '',
    plan: str(c.plan),
    memberNumber: str(c.memberNumber),
    status,
    expiresOn: str(c.expiresOn),
    checkedVia: c.checkedVia === 'payer' || c.checkedVia === 'records' ? c.checkedVia : null,
    message: str(c.message),
  };
}

/** Keeps only the fields the contract defines. A public lookup keeps only
 * whether it matched and the first name, whatever the EMR sent. */
export function readLookupResponse(raw: unknown, context: LookupContext): LookupResult {
  if (!raw || typeof raw !== 'object') throw new LookupError('The connected system sent an answer Klargy couldn’t read', 'LOOKUP_FAILED');
  const body = raw as Record<string, unknown>;
  const p = body.patient && typeof body.patient === 'object' ? (body.patient as Record<string, unknown>) : null;
  const matched = body.matched === true && !!p;

  if (context === 'public') {
    return { matched, patient: matched ? { firstName: str(p!.firstName) ?? undefined } : null, candidates: [] };
  }

  let patient: LookupPatient | null = null;
  if (matched && p) {
    const ids = p.identifiers && typeof p.identifiers === 'object' ? (p.identifiers as Record<string, unknown>) : {};
    patient = {
      ref: str(p.ref) ?? undefined,
      displayName: str(p.displayName) ?? undefined,
      firstName: str(p.firstName) ?? undefined,
      mrNumber: str(p.mrNumber),
      birthDate: str(p.birthDate),
      gender: str(p.gender),
      phoneMasked: str(p.phoneMasked),
      photoUrl: str(p.photoUrl),
      identifiers: Object.fromEntries(['nationalId', 'passport', 'memberNumber'].map((k) => [k, str(ids[k])])),
      cover: readCover(p.cover),
      flags: Array.isArray(p.flags) ? p.flags.filter((f): f is string => typeof f === 'string').slice(0, 20) : [],
    };
  }
  const candidates = Array.isArray(body.candidates)
    ? body.candidates
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .slice(0, 5)
        .map((c) => ({
          ref: str(c.ref) ?? '',
          displayName: str(c.displayName) ?? '',
          mrNumber: str(c.mrNumber),
          birthDate: str(c.birthDate),
          phoneMasked: str(c.phoneMasked),
        }))
    : [];
  return { matched, patient, candidates: matched ? [] : candidates };
}

/**
 * POST {lookupUrl} with the identifier, signed with the integration's
 * webhook signing secret. 5 second timeout, no redirects, no retries.
 */
export async function lookupPatient(
  integration: LookupIntegration,
  input: { identifierType: LookupIdentifierType; identifier: string; context: LookupContext; locationRef?: string | null }
): Promise<LookupResult> {
  if (!integration.lookupUrl || !integration.webhookEndpoint) {
    throw new LookupError('No connected system is set up to look patients up', 'LOOKUP_NOT_CONFIGURED');
  }
  if (input.context === 'public' && input.identifierType === 'patientRef') {
    return { matched: false, patient: null, candidates: [] };
  }

  const body = JSON.stringify({
    identifierType: input.identifierType,
    identifier: input.identifier,
    context: input.context,
    locationRef: input.locationRef ?? null,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  let status = 0;
  let json: unknown = null;
  try {
    const url = await assertPublicUrl(integration.lookupUrl);
    const secret = decrypt(integration.webhookEndpoint.encryptedSecret);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'queue-webhooks/1',
        'X-Webhook-Id': crypto.randomUUID(),
        'X-Webhook-Event': 'patient.lookup',
        'X-Webhook-Timestamp': timestamp,
        'X-Webhook-Signature': `sha256=${signPayload(secret, timestamp, body)}`,
      },
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
    status = response.status;
    if (response.ok) json = await response.json().catch(() => null);
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError';
    throw new LookupError(
      aborted ? 'The connected system took too long to answer' : 'Couldn’t reach the connected system',
      'LOOKUP_FAILED'
    );
  } finally {
    clearTimeout(timer);
  }

  if (status < 200 || status >= 300) {
    throw new LookupError(`The connected system couldn’t look this up (HTTP ${status})`, 'LOOKUP_FAILED');
  }
  return readLookupResponse(json, input.context);
}

/** The EMR's id for a Klargy location, for `locationRef`. */
export async function locationRefFor(integrationId: string, locationId: string | null | undefined): Promise<string | null> {
  if (!locationId) return null;
  const ref = await prisma.externalReference.findUnique({
    where: { integrationId_resourceType_resourceId: { integrationId, resourceType: 'location', resourceId: locationId } },
    select: { externalId: true },
  });
  return ref?.externalId ?? null;
}

// ---------------------------------------------------------------------------
// The INTEGRATION data source: one per organisation, following whichever
// active integration has a lookupUrl.
// ---------------------------------------------------------------------------

export const DEFAULT_LOOKUP_MAPPINGS = [
  { sourcePath: 'patient.mrNumber', targetField: 'mrNumber' },
  { sourcePath: 'patient.identifiers.memberNumber', targetField: 'memberNumber' },
  { sourcePath: 'patient.identifiers.nationalId', targetField: 'nationalId' },
  { sourcePath: 'patient.ref', targetField: 'emrPatientId' },
];

/**
 * Brings the organisation's INTEGRATION data source in line with its
 * integrations: created or updated for the active integration with a
 * lookupUrl (field mappings added only when it has none), deactivated when
 * there's none. Called after PUT /integration, revoke and key rotation.
 */
export async function syncLookupDataSource(organizationId: string): Promise<void> {
  const integration = await lookupIntegrationFor(organizationId);
  const existing = await prisma.dataSource.findFirst({
    where: { organizationId, type: 'INTEGRATION' },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { fieldMappings: true } } },
  });

  if (!integration) {
    if (existing?.isActive) await prisma.dataSource.update({ where: { id: existing.id }, data: { isActive: false } });
    return;
  }

  const data = {
    name: `${integration.name} lookup`,
    description: 'Looks patients up in the connected system (Klargy Connect).',
    config: { integrationId: integration.id },
    isActive: true,
  };
  const source = existing
    ? await prisma.dataSource.update({ where: { id: existing.id }, data })
    : await prisma.dataSource.create({ data: { ...data, organizationId, type: 'INTEGRATION' } });
  if (!existing || existing._count.fieldMappings === 0) {
    await prisma.fieldMapping.createMany({ data: DEFAULT_LOOKUP_MAPPINGS.map((m) => ({ ...m, dataSourceId: source.id })) });
  }
}

/** The organisation's active INTEGRATION data source's integration, if any. */
export async function activeLookupSource(organizationId: string): Promise<LookupIntegration | null> {
  const source = await prisma.dataSource.findFirst({
    where: { organizationId, type: 'INTEGRATION', isActive: true },
    select: { config: true },
  });
  if (!source) return null;
  const integrationId = (source.config as { integrationId?: unknown } | null)?.integrationId;
  return lookupIntegrationFor(organizationId, typeof integrationId === 'string' ? integrationId : undefined);
}

// ---------------------------------------------------------------------------
// Kiosk and public join: "Require an MR or member number to join".
// ---------------------------------------------------------------------------

export type JoinIdentifierType = (typeof JOIN_IDENTIFIER_TYPES)[number];
export const JOIN_IDENTIFIER_LABELS: Record<JoinIdentifierType, string> = {
  mrNumber: 'MR number',
  memberNumber: 'member number',
};

export const isJoinIdentifierType = (value: unknown): value is JoinIdentifierType =>
  JOIN_IDENTIFIER_TYPES.includes(value as JoinIdentifierType);

/** What the join page must ask for: only when the setting is on AND a
 * connected system can check it. */
export async function joinIdentifierFor(org: { id: string; joinIdentifierType: string | null }) {
  if (!isJoinIdentifierType(org.joinIdentifierType)) return null;
  const integration = await activeLookupSource(org.id);
  if (!integration) return null;
  return { type: org.joinIdentifierType, label: JOIN_IDENTIFIER_LABELS[org.joinIdentifierType], integration };
}
