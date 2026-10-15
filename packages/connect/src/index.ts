// @klargy/connect: Klargy Connect v1 for Node 18+ (docs/connect/v1.md).
// The desk embed is browser code and lives in '@klargy/connect/desk'.

export { CONTRACT, CONNECT_SCOPES, CONNECT_BASE_PATH } from './contract';
export type { ConnectScope } from './contract';
export { KlargyConnect } from './client';
export type { KlargyConnectOptions, IdempotentCallOptions, FetchLike } from './client';
export { ConnectError, ConnectNetworkError, CONNECT_ERROR_CODES, isConnectError } from './errors';
export type { ConnectErrorCode, ConnectErrorBody } from './errors';
export {
  WEBHOOK_HEADERS,
  WEBHOOK_EVENTS,
  PING_EVENT,
  LOOKUP_EVENT,
  DEFAULT_TOLERANCE_SECONDS,
  WebhookVerificationError,
  signPayload,
  signedHeaders,
  verifySignedRequest,
  verifyWebhook,
  isOwnEcho,
} from './webhooks';
export type {
  WebhookEventName,
  WebhookEvent,
  WebhookDataMap,
  EventOrigin,
  EntryEventData,
  EntryTransferredData,
  EntryPriorityChangedData,
  AppointmentCheckedInData,
  AppointmentEventData,
  JourneyCompletedData,
  ServicePointEventData,
  QueueStatusEventData,
  RawBody,
  HeaderBag,
  VerifyOptions,
  VerifiedRequest,
  VerificationFailure,
} from './webhooks';
export {
  LOOKUP_IDENTIFIER_TYPES,
  LOOKUP_TIMEOUT_MS,
  MAX_LOOKUP_CANDIDATES,
  verifyLookupRequest,
  lookupMatch,
  lookupNoMatch,
  lookupResponseFor,
} from './lookup';
export type {
  LookupIdentifierType,
  LookupContext,
  LookupRequest,
  LookupCover,
  LookupPatient,
  LookupCandidate,
  StaffLookupResponse,
  PublicLookupResponse,
  LookupResponse,
} from './lookup';
export type * from './types';
