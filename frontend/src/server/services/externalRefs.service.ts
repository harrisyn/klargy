import prisma from '../lib/prisma';

/**
 * Cross-references between Klargy records and another system's records
 * (Klargy Connect, docs/connect/v1.md). Phase 1 types are mapped by an admin;
 * phase 2 types are created by Connect calls.
 */

export const ADMIN_MAPPABLE_TYPES = ['location', 'service', 'service_point', 'staff'] as const;
export const CONNECT_REF_TYPES = ['patient', 'visit', 'encounter'] as const;
export type RefType = (typeof ADMIN_MAPPABLE_TYPES)[number] | (typeof CONNECT_REF_TYPES)[number];

/** The keys of an event's `refs` and the reference type each one reads. */
const REF_KEYS = {
  patient: 'patient', // Klargy User id
  visit: 'visit', // CustomerJourney id
  encounter: 'encounter', // QueueEntry id
  service: 'service',
  location: 'location',
  servicePoint: 'service_point',
  staff: 'staff', // the acting user
} as const satisfies Record<string, RefType>;

export type RefKey = keyof typeof REF_KEYS;
/** Klargy ids to translate, by refs key. */
export type RefSubject = Partial<Record<RefKey, string | null | undefined>>;
export type Refs = Partial<Record<RefKey, string | null>>;

export const ENTRY_REF_KEYS: RefKey[] = ['patient', 'visit', 'encounter', 'service', 'location', 'servicePoint', 'staff'];

/** Translates Klargy ids to one integration's ids, for many subjects in one
 * query. Every key a subject names comes back, null when there's no reference. */
export async function buildRefs(integrationId: string, subjects: RefSubject[]): Promise<Refs[]> {
  const idsByType = new Map<RefType, Set<string>>();
  for (const subject of subjects) {
    for (const [key, id] of Object.entries(subject)) {
      if (!id) continue;
      const type = REF_KEYS[key as RefKey];
      if (!idsByType.has(type)) idsByType.set(type, new Set());
      idsByType.get(type)!.add(id);
    }
  }
  const found = idsByType.size
    ? await prisma.externalReference.findMany({
        where: {
          integrationId,
          OR: [...idsByType].map(([resourceType, ids]) => ({ resourceType, resourceId: { in: [...ids] } })),
        },
        select: { resourceType: true, resourceId: true, externalId: true },
      })
    : [];
  const lookup = new Map(found.map((r) => [`${r.resourceType}:${r.resourceId}`, r.externalId]));
  return subjects.map((subject) => {
    const refs: Refs = {};
    for (const [key, id] of Object.entries(subject)) {
      refs[key as RefKey] = id ? lookup.get(`${REF_KEYS[key as RefKey]}:${id}`) ?? null : null;
    }
    return refs;
  });
}

/** The Klargy record an external id refers to, or null. */
export async function klargyIdFor(integrationId: string, resourceType: RefType, externalId: string): Promise<string | null> {
  const ref = await prisma.externalReference.findUnique({
    where: { integrationId_resourceType_externalId: { integrationId, resourceType, externalId } },
    select: { resourceId: true },
  });
  return ref?.resourceId ?? null;
}

/**
 * Points an external id at a Klargy record, one to one: the external id
 * leaves any other Klargy record, and the Klargy record drops any other
 * external id. Used for the references Connect calls create (patient, visit,
 * encounter), never for admin mappings.
 */
export async function linkRef(
  integration: { id: string; organizationId: string },
  resourceType: (typeof CONNECT_REF_TYPES)[number],
  resourceId: string,
  externalId: string
): Promise<void> {
  await prisma.externalReference.deleteMany({
    where: { integrationId: integration.id, resourceType, externalId, NOT: { resourceId } },
  });
  await prisma.externalReference.upsert({
    where: { integrationId_resourceType_resourceId: { integrationId: integration.id, resourceType, resourceId } },
    create: { integrationId: integration.id, organizationId: integration.organizationId, resourceType, resourceId, externalId },
    update: { externalId },
  });
}
