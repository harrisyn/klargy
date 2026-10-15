/**
 * Staff that Klargy Connect registered when an EMR launched the desk for a
 * practitioner Klargy didn't know (docs/connect/v1.md section 6). They have
 * no usable password and must only ever reach Klargy through the EMR, so the
 * mark lives in identityData and is checked wherever a password is used.
 */

export const LAUNCH_ONLY_KEY = 'connectLaunchOnly';

/** identityData for a staff member registered by a desk launch. */
export function launchOnlyIdentity(integrationId: string, email: string | null): Record<string, unknown> {
  return { [LAUNCH_ONLY_KEY]: true, connectIntegrationId: integrationId, ...(email ? { email } : {}) };
}

/** True for staff who may only sign in through a Connect desk launch. */
export function isLaunchOnlyUser(identityData: unknown): boolean {
  return !!identityData && typeof identityData === 'object' && (identityData as Record<string, unknown>)[LAUNCH_ONLY_KEY] === true;
}
