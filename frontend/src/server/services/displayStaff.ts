import prisma from '../lib/prisma';

/**
 * Who is seeing each called person, for the lobby screen ("Dr Owusu,
 * Consulting Room 3"): the staff member signed in at the desk, else the
 * staff member who called them (a call from the EMR through Klargy Connect
 * names its practitioner). Practitioners the EMR registered carry their EMR
 * name. Entries with nobody known are left out.
 */
type ServingEntry = {
  id: string;
  servicePointInstance?: { occupiedBy?: { firstName: string; lastName: string } | null } | null;
};

const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

export async function staffNamesFor(entries: ServingEntry[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const e of entries) {
    const occupant = e.servicePointInstance?.occupiedBy;
    if (occupant && fullName(occupant)) names.set(e.id, fullName(occupant));
  }
  const rest = entries.filter((e) => !names.has(e.id)).map((e) => e.id);
  if (rest.length === 0) return names;

  const calls = await prisma.auditLog.findMany({
    where: { entryId: { in: rest }, action: 'entry.called', actorUserId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { entryId: true, actorUserId: true },
  });
  const callerOf = new Map<string, string>();
  for (const c of calls) if (c.entryId && c.actorUserId && !callerOf.has(c.entryId)) callerOf.set(c.entryId, c.actorUserId);
  if (callerOf.size === 0) return names;

  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(callerOf.values())] }, role: { notIn: ['PATIENT', 'SUPER_ADMIN'] } },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(users.map((u) => [u.id, fullName(u)]));
  for (const [entryId, userId] of callerOf) {
    const name = byId.get(userId);
    if (name) names.set(entryId, name);
  }
  return names;
}
