# @klargy/connect

TypeScript client for **Klargy Connect v1**, the API a CRM, point-of-sale, reservations system, EMR (or any system that sends people into a queue) uses to work with Klargy.

- `KlargyConnect`: a typed client with one method per endpoint. It retries calls that are safe to repeat, sends `Idempotency-Key`s, and throws typed `ConnectError`s.
- `verifyWebhook` and `verifyLookupRequest`: check Klargy's signed webhooks and patient lookup calls. Lookup response helpers are included.
- `@klargy/connect/desk`: `embedDesk` frames the Klargy desk in your page and handles the postMessage protocol (browser).

It has no runtime dependencies. The main entry needs Node 18 or later (it uses `fetch` and `node:crypto`). The `desk` entry runs in browsers.

The contract is [docs/connect/v1.md](https://github.com/harrisyn/queue-management/blob/main/docs/connect/v1.md), with an OpenAPI description in [docs/connect/openapi.yaml](https://github.com/harrisyn/queue-management/blob/main/docs/connect/openapi.yaml). For a step-by-step integration see the [integration guide](https://github.com/harrisyn/queue-management/blob/main/docs/connect/guide.md).

```sh
npm install @klargy/connect
```

## Quick start

```ts
import { KlargyConnect, isConnectError } from '@klargy/connect';

const klargy = new KlargyConnect({
  baseUrl: 'https://acme.klargy.com', // the organisation's Klargy address
  apiKey: process.env.KLARGY_API_KEY!, // klg_live_…, shown once in Klargy
});

// "Test connection"
const me = await klargy.me();

// On every save of your settings: where to send events, who may frame the desk.
const { signingSecret } = await klargy.registerIntegration({
  system: { name: 'Acme EMR', version: '4.2' },
  webhookUrl: 'https://emr.example.com/klargy/webhooks',
  lookupUrl: 'https://emr.example.com/klargy/patient-lookup',
  embedOrigins: ['https://emr.example.com'],
});

// Publish the records Klargy's admin maps to.
await klargy.publishCatalog({
  locations: [{ id: 'LOC-1', name: 'Airport Clinic' }],
  services: [{ id: 'CLIN-GP', name: 'GP Consultation', locationId: 'LOC-1', kind: 'clinic' }],
  practitioners: [{ id: 'PR-7', name: 'Ama Owusu', email: 'ama@example.com' }],
});

// Issue a ticket for a visit.
try {
  const { entry, created } = await klargy.createEntry({
    refs: { patient: 'PAT-123', visit: 'VIS-456' },
    patient: { firstName: 'Ama', lastName: 'Mensah', phone: '+233200000000' },
    service: 'CLIN-GP',
  });
  console.log(entry.ticketNumber, entry.position, entry.statusUrl, created);
} catch (error) {
  if (isConnectError(error, 'QUEUE_CLOSED')) {
    // today's queue is paused or closed
  } else throw error;
}

// Move it from the EMR side.
await klargy.callEntry('visit', 'VIS-456', { servicePoint: 'ROOM-3', staff: 'PR-7' });
await klargy.transferEntry('visit', 'VIS-456', { to: 'LOC-1:lab', reason: 'Lab orders' });
```

## The client

`new KlargyConnect({ baseUrl, apiKey, fetch?, timeoutMs?, retries?, retryDelayMs?, maxRetryDelayMs? })`

| Option | Default | |
|---|---|---|
| `baseUrl` | | Workspace URL. `/api/v1/connect/v1` is appended unless it is already there. |
| `apiKey` | | `klg_live_…` |
| `fetch` | global `fetch` | Inject your own (tests, proxies). |
| `timeoutMs` | 10000 | Per attempt. |
| `retries` | 2 | Extra attempts, only for calls that are safe to repeat. |
| `retryDelayMs` | 500 | First backoff, doubled each retry. `Retry-After` is honoured. |
| `maxRetryDelayMs` | 30000 | A longer wait is not attempted; the error is thrown. |

| Method | Endpoint | Retried |
|---|---|---|
| `me()` | `GET /me` | yes |
| `registerIntegration(input)` | `PUT /integration` | yes |
| `publishCatalog(catalog)` | `PUT /catalog` | yes |
| `getCatalog()` | `GET /catalog` | yes |
| `getMappings({ resourceType? })` | `GET /mappings` | yes |
| `putPatient(patientId, patient)` | `PUT /patients/{patientId}` | yes |
| `createEntry(input, { idempotencyKey? })` | `POST /entries` | with a key |
| `callEntry` / `completeEntry` / `cancelEntry` / `noShowEntry(type, id, input?, opts?)` | `POST /entries/by-ref/{type}/{id}/{action}` | with a key |
| `holdEntry` / `resumeEntry` / `clearEntry(type, id, input?, opts?)` | `POST …/hold`, `…/resume`, `…/clear` | with a key |
| `linkServingEntry({ staff, refs, patient? }, opts?)` | `POST /entries/serving/link` | with a key |
| `transferEntry(type, id, { to, … }, opts?)` | `POST …/transfer` | with a key |
| `setEntryPriority(type, id, { priority, … }, opts?)` | `POST …/priority` | with a key |
| `getEntryByRef(type, id, { service? })` | `GET /entries/by-ref/{type}/{id}` | yes |
| `listEntries({ updatedSince, visit? })`, `iterateEntries(…)` | `GET /entries` | yes |
| `launchDesk(input)` | `POST /desk/launch` | no |
| `getStaffDesk(staffRef)` | `GET /staff/{staffRef}/desk` | yes |
| `putAppointment(appointmentRef, input)` | `PUT /appointments/{appointmentRef}` | yes |
| `getAnalytics({ from?, to?, location?, service? })` | `GET /analytics` | yes |
| `setServiceStatus(service, { status, reason?, message? })` | `POST /services/{service}/status` | yes |

`type` is `'visit'`, `'encounter'` or `'entry'`. Dates can be passed as `Date` or ISO strings.

**Idempotency.** Calls that issue or move tickets send an `Idempotency-Key`. Each call gets a new UUID by default, so the client's own retries are safe. Pass your own key (for example derived from your visit and service ids) to make retries after a crash safe as well, or `idempotencyKey: false` to send none (the call is then never retried). Results carry `replayed: true` when Klargy answered from its idempotency store. `createEntry` and `transferEntry` also say whether a new ticket was issued (`created`).

**Errors.** A non-2xx answer throws `ConnectError` with `status`, `code` (for example `SERVICE_NOT_MAPPED`, `QUEUE_CLOSED`, `PATIENT_REQUIRED`, `LIMIT_REACHED`, `ALREADY_IN_QUEUE`, `NO_OPEN_ENTRY`, `INVALID_TRANSITION`; see `CONNECT_ERROR_CODES`) and the parsed `body`. Helpers: `error.is(code)`, `error.entry` (the open ticket for `ALREADY_IN_QUEUE`), `error.entryStatus` (for `INVALID_TRANSITION`) and `error.limitInfo` (for `LIMIT_REACHED`). No answer at all throws `ConnectNetworkError` (`timedOut` tells a timeout apart).

**Catching up.** After downtime, page through every change since your last sync:

```ts
let cursor = lastSync;
for await (const entry of klargy.iterateEntries({ updatedSince: lastSync, onPage: (p) => void (cursor = p.nextUpdatedSince) })) {
  await upsertTicket(entry);
}
saveLastSync(cursor);
```

## Webhooks

Read the raw body. Don't parse JSON before verifying.

```ts
import express from 'express';
import { verifyWebhook, isOwnEcho, WebhookVerificationError } from '@klargy/connect';

app.post('/klargy/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = verifyWebhook({ secret: process.env.KLARGY_SIGNING_SECRET!, headers: req.headers, rawBody: req.body });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.status(error.status).end();
    throw error;
  }
  if (await alreadyProcessed(event.id)) return res.status(200).end(); // retries reuse the id
  if (isOwnEcho(event, myIntegrationId)) return res.status(200).end(); // our own calls echoed back

  switch (event.event) {
    case 'entry.called':
      await showCalled(event.data.refs?.visit, event.data.servicePoint?.name);
      break;
    case 'journey.completed':
      await closeVisitQueue(event.data.refs?.visit);
      break;
  }
  res.status(200).end();
});
```

`verifyWebhook` checks the `X-Webhook-*` headers, the HMAC-SHA256 of `"<timestamp>.<raw body>"` (compared in constant time) and the 5-minute window (`toleranceSeconds`, default 300). `now` can be passed for tests. It returns the body (`{ id, event, createdAt, data }`) typed by `event`. `signPayload` and `signedHeaders` sign test requests the same way Klargy does.

## Patient lookup

```ts
import { verifyLookupRequest, lookupMatch, lookupNoMatch, lookupResponseFor, WebhookVerificationError } from '@klargy/connect';

app.post('/klargy/patient-lookup', express.raw({ type: 'application/json' }), async (req, res) => {
  let request;
  try {
    request = verifyLookupRequest({ secret, headers: req.headers, rawBody: req.body });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  const patient = await findPatient(request.identifierType, request.identifier); // finish within 5 seconds
  const answer = patient ? lookupMatch(patient) : lookupNoMatch();
  res.json(lookupResponseFor(request, answer)); // public context keeps only matched + firstName
});
```

## Embedding the desk

On your server, ask for a launch URL for the signed-in practitioner. In the browser, frame it:

```ts
// server
const { url } = await klargy.launchDesk({
  staff: { id: 'PR-7', name: 'Ama Owusu', email: 'ama@example.com' },
  returnOrigin: 'https://emr.example.com',
});

// browser
import { embedDesk } from '@klargy/connect/desk';

const desk = embedDesk({
  container: document.getElementById('klargy-desk')!,
  url, // use within 60 seconds
  onReady: () => console.log('desk signed in'),
  onDeskChanged: (room) => setRoom(room?.externalId ?? null),
  onWaiting: (count) => setWaitingBadge(count),
  onEntryCalled: (entry) => openEncounter(entry.refs.visit),
  onEntryUpdated: (entry) => refreshVisit(entry.refs.visit),
});

// when the practitioner signs out of the EMR
desk.logout();
// when the page goes away
desk.destroy();
```

Messages are accepted only from the frame's own window and the launch URL's origin. `logout` is posted only to that origin. `parseDeskMessage`, `DESK_MESSAGES` and `CONTRACT` are exported for custom handling.

For a floating toolbar, load the compact one-row layout and size the frame to what it asks for (it grows while a menu is open):

```ts
const bar = embedDesk({
  container: document.getElementById('klargy-bar')!,
  url,
  layout: 'bar', // adds layout=bar to the URL; deskUrl(url, 'bar') does the same
  onResize: (height) => { bar.iframe.style!.height = `${Math.min(Math.max(height, 56), 480)}px`; },
  onWaiting: (count) => setBubbleBadge(count),
});
```

To offer only the rooms that belong where the practitioner is working, pass the kinds of room, and update them when they move to another part of your app:

```ts
const desk = embedDesk({ container, url, layout: 'bar', roomTypes: ['consultation'] });
// later, at the front desk
desk.setRoomTypes(['reception']);
```

The kinds are `ROOM_TYPES`: `reception`, `triage`, `consultation`, `cashier`, `pharmacy`, `lab`, `imaging` and `other`. An empty list offers every room.

## Development

```sh
npm install
npm test          # vitest
npm run typecheck
npm run build     # dist/: ESM, CJS and .d.ts
```
