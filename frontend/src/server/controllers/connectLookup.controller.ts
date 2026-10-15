import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { loadCaller } from '../middleware/tenantScope.middleware';
import {
  LOOKUP_IDENTIFIER_TYPES,
  LookupError,
  LookupIdentifierType,
  locationRefFor,
  lookupIntegrationFor,
  lookupPatient,
} from '../services/connectLookup.service';

// Klargy Connect v1, phase 4 (docs/connect/v1.md section 7): staff asking
// the connected EMR who a patient is. The EMR runs the cover check; Klargy
// only shows the answer.

const MAX_IDENTIFIER = 100;

const notConfigured = (res: Response) =>
  res.status(409).json({ error: 'No EMR connection is set up to look patients up.', code: 'LOOKUP_NOT_CONFIGURED' });

function fail(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof LookupError) return res.status(error.status).json({ error: error.message, code: error.code });
  next(error);
}

async function callerOrg(req: Request, res: Response): Promise<string | null> {
  const caller = await loadCaller(req);
  if (!caller?.organizationId) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return caller.organizationId;
}

/** POST /connect-lookup {identifierType, identifier, locationId?}: the EMR's
 * staff answer, as it sent it (fields the contract defines only). */
export const postLookup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = await callerOrg(req, res);
    if (!organizationId) return;
    const { identifierType, identifier, locationId } = (req.body ?? {}) as Record<string, unknown>;
    if (!LOOKUP_IDENTIFIER_TYPES.includes(identifierType as LookupIdentifierType)) {
      return res.status(400).json({ error: `identifierType must be one of: ${LOOKUP_IDENTIFIER_TYPES.join(', ')}` });
    }
    const value = typeof identifier === 'string' ? identifier.trim() : '';
    if (!value) return res.status(400).json({ error: 'Type the number to look up.' });
    if (value.length > MAX_IDENTIFIER) return res.status(400).json({ error: `identifier must be at most ${MAX_IDENTIFIER} characters` });

    const integration = await lookupIntegrationFor(organizationId);
    if (!integration) return notConfigured(res);
    const result = await lookupPatient(integration, {
      identifierType: identifierType as LookupIdentifierType,
      identifier: value,
      context: 'staff',
      locationRef: await locationRefFor(integration.id, typeof locationId === 'string' ? locationId : null),
    });
    res.json(result);
  } catch (error) {
    fail(error, res, next);
  }
};

/**
 * GET /connect-lookup/entries/:entryId: the EMR's record for the patient on
 * this ticket, looked up by the EMR's own patient id. 404 NO_PATIENT_REF
 * when the patient didn't come from a connected EMR (the desk then shows no
 * card).
 */
export const getEntryLookup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = await callerOrg(req, res);
    if (!organizationId) return;
    const entry = await prisma.queueEntry.findFirst({
      where: { id: req.params.entryId, queue: { service: { location: { organizationId } } } },
      select: { userId: true, queue: { select: { service: { select: { locationId: true } } } } },
    });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const refs = await prisma.externalReference.findMany({
      where: { organizationId, resourceType: 'patient', resourceId: entry.userId },
      select: { integrationId: true, externalId: true },
    });
    let found: { integration: NonNullable<Awaited<ReturnType<typeof lookupIntegrationFor>>>; patientRef: string } | null = null;
    for (const ref of refs) {
      const integration = await lookupIntegrationFor(organizationId, ref.integrationId);
      if (integration) {
        found = { integration, patientRef: ref.externalId };
        break;
      }
    }
    if (!found) {
      if (refs.length > 0 && !(await lookupIntegrationFor(organizationId))) return notConfigured(res);
      return res.status(404).json({ error: 'This patient isn’t linked to an EMR record.', code: 'NO_PATIENT_REF' });
    }

    const result = await lookupPatient(found.integration, {
      identifierType: 'patientRef',
      identifier: found.patientRef,
      context: 'staff',
      locationRef: await locationRefFor(found.integration.id, entry.queue.service.locationId),
    });
    res.json({ system: found.integration.name, ...result });
  } catch (error) {
    fail(error, res, next);
  }
};
