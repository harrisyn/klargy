/** The contract this package implements (docs/connect/v1.md). Sent by
 * `GET /me` and by the desk's `klargy:ready` message. */
export const CONTRACT = 'klargy-connect/v1' as const;

/** Scopes a Klargy Connect API key can carry. Every new key gets all of them. */
export const CONNECT_SCOPES = [
  'integration:write',
  'catalog:read',
  'catalog:write',
  'patients:write',
  'entries:read',
  'entries:write',
  'desk:launch',
  'appointments:write',
  'analytics:read',
] as const;
export type ConnectScope = (typeof CONNECT_SCOPES)[number];

/** Path of the Connect API on a Klargy workspace. */
export const CONNECT_BASE_PATH = '/api/v1/connect/v1';
