import type { ConnectScope } from './contract';

// Request and response shapes of Klargy Connect v1 (docs/connect/v1.md,
// docs/connect/openapi.yaml). Times arrive as ISO 8601 strings.

export interface NamedRef {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// GET /me, PUT /integration
// ---------------------------------------------------------------------------

export interface ConnectMe {
  contract: string;
  organization: { id: string; name: string; slug: string | null };
  integration: {
    id: string;
    name: string;
    status: 'ACTIVE' | 'REVOKED';
    scopes: ConnectScope[];
    registered: boolean;
    catalogPublishedAt: string | null;
  };
}

export interface RegisterIntegrationInput {
  system?: { name?: string; version?: string };
  /** Public https URL Klargy posts events to (http is accepted outside production). */
  webhookUrl: string;
  /** Turns patient lookup on; leaving it out turns it off. */
  lookupUrl?: string | null;
  /** Origins that may frame the desk (at most 10). */
  embedOrigins?: string[];
}

export interface RegisterIntegrationResult {
  integrationId: string;
  /** `whsec_…`: verifies webhooks and lookup requests. Returned on every call. */
  signingSecret: string;
  webhookEvents: string[];
}

// ---------------------------------------------------------------------------
// Catalogue and mappings
// ---------------------------------------------------------------------------

/** Department kinds Klargy groups services by; any other text is kept. */
export type ServiceKind = 'clinic' | 'lab' | 'imaging' | 'pharmacy' | 'cashier' | (string & {});

export interface CatalogInput {
  locations?: { id: string; name: string }[];
  services?: { id: string; name: string; locationId?: string | null; kind?: ServiceKind | null }[];
  servicePoints?: { id: string; name: string; locationId?: string | null; kind?: string | null }[];
  practitioners?: { id: string; name: string; email?: string | null }[];
  registrationFields?: { key: string; label?: string | null; required?: boolean; type?: string | null }[];
}

export interface CatalogPublishResult {
  received: {
    locations: number;
    services: number;
    servicePoints: number;
    practitioners: number;
    registrationFields: number;
  };
}

export interface KlargyCatalog {
  locations: { id: string; name: string; externalId: string | null }[];
  services: { id: string; name: string; locationId: string; externalId: string | null }[];
  servicePoints: { id: string; name: string; type: string; externalId: string | null }[];
}

export type MappingResourceType =
  | 'location'
  | 'service'
  | 'service_point'
  | 'staff'
  | 'patient'
  | 'visit'
  | 'encounter'
  | 'appointment';

export interface Mapping {
  resourceType: MappingResourceType;
  klargyId: string;
  externalId: string;
}

// ---------------------------------------------------------------------------
// Patients and entries
// ---------------------------------------------------------------------------

export interface PatientInput {
  firstName: string;
  lastName: string;
  /** null clears the phone; leaving it out keeps it. */
  phone?: string | null;
  email?: string | null;
  /** Merged into what Klargy holds (at most 20 keys). */
  identifiers?: Record<string, string | number | null>;
}

export interface PutPatientResult {
  patientId: string;
  klargyId: string;
  created: boolean;
}

export type EntryStatus = 'WAITING' | 'SERVING' | 'SERVED' | 'CANCELLED' | 'NO_SHOW';

export interface EntryPatient {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  /** The identifiers Klargy holds (and the email the EMR sent). */
  identityData: Record<string, unknown> | null;
}

/** The EMR's own ids for the records in an entry, or null. */
export interface EntryRefs {
  patient: string | null;
  visit: string | null;
  encounter: string | null;
  service: string | null;
  location: string | null;
  servicePoint: string | null;
  staff: string | null;
  appointment?: string | null;
}

/** The entry object: webhook `data` for an entry event, without `origin`. */
export interface Entry {
  entryId: string;
  ticketNumber: string;
  status: EntryStatus;
  queueId: string;
  service: NamedRef;
  location: NamedRef;
  servicePoint: NamedRef | null;
  journeyId: string | null;
  previousEntryId: string | null;
  joinedAt: string;
  calledAt: string | null;
  servedAt: string | null;
  completedAt: string | null;
  patient: EntryPatient;
  /** The patient's live status page; safe to share with them. */
  statusUrl: string;
  /** 1 = next, while WAITING; null otherwise. */
  position: number | null;
  refs: EntryRefs;
  /** On hold: stepped out of the room, keeps its place; `status` is WAITING. */
  held: boolean;
  /** Waiting for payment in a service that requires clearance; `status` is WAITING, `position` null. */
  awaitingClearance: boolean;
  /** For an entry made by a transfer: who sent it. null for a first ticket or an automatic flow. */
  sentBy: EntrySentBy | null;
  /** The visit's entries, oldest first, this one included. */
  journey: JourneyStep[];
}

export type EntrySentBy = 'staff' | 'patient' | 'integration';

/** One stop of the visit. `service.ref` is the EMR's id for the service, else null. */
export interface JourneyStep {
  entryId: string;
  ticketNumber: string;
  service: { id: string; ref: string | null; name: string };
  status: EntryStatus;
  joinedAt: string;
  endedAt: string | null;
}

export interface CreateEntryInput {
  refs: {
    patient: string;
    visit: string;
    appointment?: string | null;
    encounter?: string | null;
  };
  /** Required the first time Klargy sees refs.patient. */
  patient?: PatientInput | null;
  /** EMR (or Klargy) service id. */
  service: string;
  /** 0 to 100, higher is called first. */
  priority?: number;
  notes?: string | null;
  /** Payment already settled: skips the service's payment gate (and clears an open entry on a 200). */
  cleared?: boolean;
}

export type EntryRefType = 'visit' | 'encounter' | 'entry';
export type EntryStatusAction = 'call' | 'complete' | 'cancel' | 'no-show' | 'hold' | 'resume' | 'clear';
export type EntryAction = EntryStatusAction | 'transfer' | 'priority';

export interface EntryActionInput {
  /** For `visit`: choose the visit's entry among this service's (EMR or Klargy id). */
  service?: string;
  /** Links the entry to this EMR encounter. */
  encounter?: string;
  /** `call` and `resume`: EMR or Klargy service point id. */
  servicePoint?: string;
  /**
   * EMR practitioner id of whoever is acting. For `call` and `resume` with no
   * `servicePoint`, the call goes to the room this staff member is signed in to.
   */
  staff?: string;
  reason?: string;
}

export interface TransferInput {
  /** EMR or Klargy service id to send the patient to. */
  to: string;
  /** Payment already settled: skips the target service's payment gate. */
  cleared?: boolean;
  service?: string;
  priority?: number;
  encounter?: string;
  staff?: string;
  reason?: string;
}

export interface PriorityInput {
  priority: number;
  service?: string;
  encounter?: string;
  staff?: string;
  reason?: string;
}

export interface EntryResult {
  entry: Entry;
  /** Answered from the Idempotency-Key store (header `Idempotent-Replayed: true`). */
  replayed: boolean;
}

export interface CreateEntryResult extends EntryResult {
  /** true for a new ticket (201); false when the visit already had an open entry for the service (200). */
  created: boolean;
}

export interface TransferResult extends EntryResult {
  /** The completed entry; null when the visit was already in `to` (nothing changed). */
  from: Entry | null;
  /** true when a new ticket was issued (201). */
  created: boolean;
}

export interface ListEntriesQuery {
  updatedSince: string | Date;
  visit?: string;
}

export interface ListEntriesResult {
  entries: Entry[];
  nextUpdatedSince: string;
}

// ---------------------------------------------------------------------------
// Desk launch
// ---------------------------------------------------------------------------

export interface DeskLaunchInput {
  staff: { id: string; name: string; email?: string | null };
  servicePoint?: string | null;
  /** Must be one of the integration's embedOrigins. */
  returnOrigin: string;
}

export interface DeskLaunchResult {
  /** Load in an iframe straight away: the code works once, within 60 seconds. */
  url: string;
  expiresAt: string;
  staff: { klargyId: string; created: boolean };
}

/** `GET /staff/{staffRef}/desk`: the room a staff member is signed in to now. */
export interface StaffDesk {
  /** The room (Klargy service point), or null when they are signed in to none. */
  servicePoint: {
    /** Klargy's service point id. */
    id: string;
    /** The EMR's id for it (its `service_point` mapping), or null. */
    ref: string | null;
    name: string;
    /** The Klargy service the desk serves. */
    serviceId: string;
    /** The EMR's id for that service (its `service` mapping), or null. */
    serviceRef: string | null;
  } | null;
  /** The desk (one of the room's desks) they sit at, or null. */
  desk: { id: string; name: string } | null;
  /** When they signed in to it (ISO time), or null. */
  signedInAt: string | null;
}

// ---------------------------------------------------------------------------
// Phase 5: appointments, analytics, service status
// ---------------------------------------------------------------------------

export type AppointmentInputStatus = 'booked' | 'cancelled' | 'no_show' | 'completed';
export type AppointmentStatus = AppointmentInputStatus | 'checked_in' | (string & {});

export interface AppointmentInput {
  refs: { patient: string; visit?: string | null };
  patient?: PatientInput | null;
  service: string;
  startTime: string | Date;
  endTime?: string | Date | null;
  status?: AppointmentInputStatus;
  staff?: string | null;
  notes?: string | null;
}

export interface Appointment {
  id: string;
  status: AppointmentStatus;
  startTime: string;
  endTime: string | null;
  service: NamedRef;
  refs: { appointment: string | null; patient: string | null; service: string | null; location: string | null };
}

export interface AppointmentResult {
  appointment: Appointment;
  /** true on create (201). */
  created: boolean;
}

export interface AnalyticsQuery {
  from?: string | Date;
  to?: string | Date;
  /** EMR or Klargy location id. */
  location?: string;
  /** EMR or Klargy service id. */
  service?: string;
}

export interface AnalyticsCounters {
  joined: number;
  served: number;
  noShows: number;
  cancelled: number;
  noShowRatePct: number | null;
  avgWaitMinutes: number | null;
  medianWaitMinutes: number | null;
  p90WaitMinutes: number | null;
  avgServiceMinutes: number | null;
}

export interface Analytics {
  from: string;
  to: string;
  overall: AnalyticsCounters;
  live: { waiting: number; serving: number; longestWaitMinutes: number };
  services: (AnalyticsCounters & { id: string; ref: string | null; name: string })[];
}

export interface ServiceStatusInput {
  status: 'PAUSED' | 'ACTIVE';
  reason?: string | null;
  /** Up to 300 characters, sent to everyone waiting on a pause. */
  message?: string | null;
}

export interface ServiceStatusResult {
  queueId: string;
  status: 'ACTIVE' | 'PAUSED' | 'CLOSED';
  changed: boolean;
  service: NamedRef;
  location: NamedRef;
  refs: { service: string | null; location: string | null };
}

/** `POST /entries/serving/link`. */
export interface ServingLinkInput {
  /** EMR practitioner id of the receptionist serving the walk-in. */
  staff: string;
  refs: { patient: string; visit: string; encounter?: string | null };
  /** Updates the Klargy patient's details. */
  patient?: PatientInput | null;
}
