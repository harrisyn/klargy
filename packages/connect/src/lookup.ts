import { LOOKUP_EVENT, WebhookVerificationError, verifySignedRequest, type VerifyOptions } from './webhooks';

// Patient lookup (docs/connect/v1.md section 7): Klargy asks the EMR who a
// patient is, signed like a webhook with X-Webhook-Event: patient.lookup.

export const LOOKUP_IDENTIFIER_TYPES = ['mrNumber', 'memberNumber', 'phone', 'nationalId', 'passport', 'patientRef'] as const;
export type LookupIdentifierType = (typeof LOOKUP_IDENTIFIER_TYPES)[number];
export type LookupContext = 'staff' | 'public';

/** Klargy waits this long for an answer, and never retries inside someone's request. */
export const LOOKUP_TIMEOUT_MS = 5000;
/** At most this many candidates are shown. */
export const MAX_LOOKUP_CANDIDATES = 5;

export interface LookupRequest {
  /** X-Webhook-Id: a new uuid per request. */
  id: string;
  timestamp: number;
  identifierType: LookupIdentifierType;
  identifier: string;
  /** staff (someone in Klargy) or public (kiosk or the join page). */
  context: LookupContext;
  /** The EMR's id for the Klargy location, when mapped. */
  locationRef: string | null;
}

export interface LookupCover {
  payer: string;
  plan?: string | null;
  memberNumber?: string | null;
  status: 'active' | 'expired' | 'inactive' | 'unknown';
  /** YYYY-MM-DD */
  expiresOn?: string | null;
  /** payer (asked the payer) or records (the EMR's own policy dates). */
  checkedVia?: 'payer' | 'records' | null;
  /** Why a check failed (status unknown). */
  message?: string | null;
}

export interface LookupPatient {
  ref: string;
  displayName: string;
  firstName?: string | null;
  mrNumber?: string | null;
  /** YYYY-MM-DD */
  birthDate?: string | null;
  gender?: string | null;
  /** e.g. "024••••19": never send a full number. */
  phoneMasked?: string | null;
  photoUrl?: string | null;
  identifiers?: { nationalId?: string | null; passport?: string | null; memberNumber?: string | null };
  /** null when there is no cover on file. */
  cover?: LookupCover | null;
  flags?: string[];
}

export interface LookupCandidate {
  ref: string;
  displayName: string;
  mrNumber?: string | null;
  birthDate?: string | null;
  phoneMasked?: string | null;
}

/** The staff-context answer. */
export interface StaffLookupResponse {
  matched: boolean;
  patient: LookupPatient | null;
  candidates: LookupCandidate[];
}

/** The public-context answer: only whether it matched and the first name. */
export interface PublicLookupResponse {
  matched: boolean;
  patient: { firstName?: string } | null;
  candidates: [];
}

export type LookupResponse = StaffLookupResponse | PublicLookupResponse;

/**
 * Verifies a lookup call from Klargy and returns what it asks for. Throws
 * WebhookVerificationError: answer `error.status` (401 for a bad, missing or
 * stale signature, 400 for a bad body).
 */
export function verifyLookupRequest(options: VerifyOptions): LookupRequest {
  const verified = verifySignedRequest(options);
  if (verified.event !== LOOKUP_EVENT) {
    throw new WebhookVerificationError('unexpected_event', `Expected X-Webhook-Event ${LOOKUP_EVENT}, got ${verified.event}`);
  }
  let body: Record<string, unknown>;
  try {
    const text = typeof options.rawBody === 'string' ? options.rawBody : new TextDecoder().decode(options.rawBody);
    body = JSON.parse(text);
  } catch {
    throw new WebhookVerificationError('invalid_body', 'The body is not JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WebhookVerificationError('invalid_body', 'The body is not a JSON object');
  }
  const { identifierType, identifier, context, locationRef } = body;
  if (!LOOKUP_IDENTIFIER_TYPES.includes(identifierType as LookupIdentifierType)) {
    throw new WebhookVerificationError('invalid_body', `identifierType must be one of: ${LOOKUP_IDENTIFIER_TYPES.join(', ')}`);
  }
  if (typeof identifier !== 'string' || !identifier.trim()) {
    throw new WebhookVerificationError('invalid_body', 'identifier is required');
  }
  if (context !== 'staff' && context !== 'public') {
    throw new WebhookVerificationError('invalid_body', 'context must be staff or public');
  }
  if (context === 'public' && identifierType === 'patientRef') {
    throw new WebhookVerificationError('invalid_body', 'patientRef lookups are staff only');
  }
  if (locationRef !== undefined && locationRef !== null && typeof locationRef !== 'string') {
    throw new WebhookVerificationError('invalid_body', 'locationRef must be a string or null');
  }
  return {
    id: verified.id,
    timestamp: verified.timestamp,
    identifierType: identifierType as LookupIdentifierType,
    identifier: identifier.trim(),
    context,
    locationRef: (locationRef as string | null | undefined) ?? null,
  };
}

/** One patient found. */
export function lookupMatch(patient: LookupPatient): StaffLookupResponse {
  return { matched: true, patient, candidates: [] };
}

/** Nobody found (or, with candidates, a staff phone lookup that matched several). */
export function lookupNoMatch(candidates: LookupCandidate[] = []): StaffLookupResponse {
  return { matched: false, patient: null, candidates: candidates.slice(0, MAX_LOOKUP_CANDIDATES) };
}

/**
 * The answer to send for a request's context. In public context only
 * `matched` and the first name are kept (Klargy drops anything else), and
 * candidates are never sent.
 */
export function lookupResponseFor(
  request: Pick<LookupRequest, 'context'> | LookupContext,
  answer: StaffLookupResponse
): LookupResponse {
  const context = typeof request === 'string' ? request : request.context;
  if (context === 'public') {
    if (!answer.matched || !answer.patient) return { matched: false, patient: null, candidates: [] };
    const firstName = answer.patient.firstName;
    return { matched: true, patient: firstName ? { firstName } : {}, candidates: [] };
  }
  if (answer.matched) return { matched: true, patient: answer.patient, candidates: [] };
  return { matched: false, patient: null, candidates: answer.candidates.slice(0, MAX_LOOKUP_CANDIDATES) };
}
