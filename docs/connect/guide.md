# Integrating an EMR with Klargy

This guide takes an EMR (or any system that sends people into a queue) from nothing to a working Klargy integration. It covers tickets that follow your visits, a desk inside your app, patient lookup and journey automation. The contract is [Klargy Connect v1](./v1.md), with a machine-readable description in [openapi.yaml](./openapi.yaml). This guide explains how to use it.

Examples are in TypeScript with [`@klargy/connect`](../../packages/connect) and in Python with [`klargy-connect`](../../sdks/python/klargy-connect). Both are thin: anything here can also be done with plain HTTP.

## Contents

1. [Concepts](#1-concepts)
2. [Setup](#2-setup)
3. [Issue a ticket](#3-issue-a-ticket)
4. [React to webhooks](#4-react-to-webhooks)
5. [Embed the desk](#5-embed-the-desk)
6. [Serve patient lookup](#6-serve-patient-lookup)
7. [Journey automation](#7-journey-automation)
8. [Appointments](#8-appointments)
9. [Analytics](#9-analytics)
10. [Testing in the sandbox](#10-testing-in-the-sandbox)
11. [Go-live checklist](#11-go-live-checklist)

## 1. Concepts

| Klargy | Your EMR | |
|---|---|---|
| Organisation (workspace) | Facility or tenant | One Klargy address, for example `https://acme.klargy.com` |
| Integration | Your connection settings | Holds an API key, your webhook URL, lookup URL and embed origins |
| Location | Location or branch | Mapped by a Klargy admin |
| Service (a queue per day) | Clinic or department | Mapped by a Klargy admin. Cashier, lab and pharmacy are services too |
| Service point (room, with desks) | Consulting room | Optional mapping. Your app doesn't need its own rooms |
| Staff member | Practitioner | Matched by mapping or email when the desk opens |
| Journey | **Visit** | Created by your calls. One visit is one journey |
| Entry (ticket) | Encounter (optional) | One per service the patient queues for during the visit |
| Patient | Patient | Created by your calls |

What to keep in mind:

- **Klargy keeps the cross-references.** You always address records by your own ids (patient, visit, encounter, clinic, practitioner). You never need to store a Klargy id.
- **The queue follows the visit, not the appointment.** A walk-in has a visit and no appointment, and still gets a ticket.
- **Calls are safe to repeat.** `PUT`s are idempotent. Ticket calls take an `Idempotency-Key`. Moving an entry to the status it already has changes nothing.
- **Events tell you what happened.** Klargy posts signed webhooks for every change, including ones you caused. Those carry `origin.integrationId` equal to yours, so you can ignore them.

## 2. Setup

### 2.1 Create the integration and key (a Klargy admin)

In Klargy, go to **Admin → Integrations → EMR connections → New connection**. Name it after your system. Klargy shows the API key **once** (`klg_live_` followed by 40 characters). Store it as a secret in your EMR's settings for that facility. The organisation's plan must include EMR connections. If it doesn't, every call answers 403.

Your settings screen needs two fields: the Klargy address and the API key. Add a **Test connection** button that calls `GET /me`:

```ts
import { KlargyConnect } from '@klargy/connect';

const klargy = new KlargyConnect({ baseUrl: settings.klargyUrl, apiKey: settings.klargyKey });
const me = await klargy.me(); // me.organization.name, me.integration.scopes
```

```python
from klargy_connect import KlargyConnect

async with KlargyConnect(settings.klargy_url, settings.klargy_key) as klargy:
    me = await klargy.me()
```

### 2.2 Register

On every save of your settings, tell Klargy where to send events, where to look patients up (optional) and which origins may frame the desk (optional). Keep the `signingSecret` it returns. It is the same on every call, so registering again recovers it.

```ts
const { integrationId, signingSecret } = await klargy.registerIntegration({
  system: { name: 'Acme EMR', version: '4.2' },
  webhookUrl: `https://api.acme-emr.com/klargy/${facilityId}/webhooks`,
  lookupUrl: `https://api.acme-emr.com/klargy/${facilityId}/patient-lookup`,
  embedOrigins: ['https://app.acme-emr.com'],
});
```

```python
reg = await klargy.register_integration({
    "system": {"name": "Acme EMR", "version": "4.2"},
    "webhookUrl": f"https://api.acme-emr.com/klargy/{facility_id}/webhooks",
    "lookupUrl": f"https://api.acme-emr.com/klargy/{facility_id}/patient-lookup",
    "embedOrigins": ["https://app.acme-emr.com"],
})
signing_secret = reg["signingSecret"]
```

URLs must be public `https` (plain `http` is accepted outside production). Leaving `lookupUrl` out turns lookup off.

### 2.3 Publish your catalogue

Send the records Klargy's admin will map to. Do it on save and whenever they change. Each call replaces the previous catalogue.

```ts
await klargy.publishCatalog({
  locations: [{ id: 'LOC-1', name: 'Airport Clinic' }],
  services: [
    { id: 'CLIN-GP', name: 'GP Consultation', locationId: 'LOC-1', kind: 'clinic' },
    { id: 'LOC-1:lab', name: 'Airport Clinic Laboratory', locationId: 'LOC-1', kind: 'lab' },
    { id: 'LOC-1:cashier', name: 'Airport Clinic Cashier', locationId: 'LOC-1', kind: 'cashier' },
  ],
  servicePoints: [{ id: 'ROOM-3', name: 'Consulting Room 3', locationId: 'LOC-1', kind: 'room' }],
  practitioners: [{ id: 'PR-7', name: 'Ama Owusu', email: 'ama@acme-emr.com' }],
});
```

If your EMR has no department records, publish one service per location and department (`"<location id>:lab"`, `kind: "lab"`), as above.

### 2.4 Mapping (a Klargy admin)

In **Admin → Integrations → (your connection) → Map**, the admin matches each Klargy location, service and service point to a record from your catalogue. Practitioners are matched automatically by email the first time they open the desk. Until a service is mapped, ticket calls naming it answer 404 `SERVICE_NOT_MAPPED`. Klargy's own service id is accepted too. `GET /catalog` and `GET /mappings` show the result, so your settings screen can display what is mapped.

## 3. Issue a ticket

When a patient checks in for a visit, issue a ticket for the first service. The patient is created or updated inline:

```ts
import { isConnectError } from '@klargy/connect';

try {
  const { entry, created } = await klargy.createEntry(
    {
      refs: { patient: patient.id, visit: visit.id, encounter: encounter?.id ?? null, appointment: visit.appointmentId ?? null },
      patient: { firstName: patient.firstName, lastName: patient.lastName, phone: patient.phone, identifiers: { mrn: patient.mrn } },
      service: visit.clinicId,
      priority: visit.urgent ? 80 : 0,
    },
    { idempotencyKey: `checkin:${visit.id}:${visit.clinicId}` },
  );
  showTicket(entry.ticketNumber, entry.position, entry.statusUrl);
} catch (error) {
  if (isConnectError(error, 'QUEUE_CLOSED')) return tell('The clinic is not taking patients right now');
  if (isConnectError(error, 'ALREADY_IN_QUEUE')) return showTicket(error.entry!.ticketNumber);
  throw error;
}
```

```python
from klargy_connect import ConnectError

try:
    res = await klargy.create_entry({
        "refs": {"patient": patient.id, "visit": visit.id},
        "patient": {"firstName": patient.first_name, "lastName": patient.last_name, "phone": patient.phone},
        "service": visit.clinic_id,
    }, idempotency_key=f"checkin:{visit.id}:{visit.clinic_id}")
    entry = res["entry"]
except ConnectError as error:
    if error.code == "QUEUE_CLOSED":
        ...
    raise
```

- A new ticket answers 201. If the visit already has an open ticket for that service, you get that one back with 200, so calling twice is harmless.
- Klargy sends the patient the "you've joined" message with a link to their live status page (`entry.statusUrl`). You can show or send that link yourself too.
- `entry.position` is their place in line when the ticket was made. `getEntryByRef('visit', id)` returns a fresh one.

Then move the ticket from your screens, addressing it by visit, encounter or Klargy entry id:

```ts
await klargy.callEntry('visit', visit.id, { servicePoint: 'ROOM-3', staff: practitioner.id });
await klargy.completeEntry('encounter', encounter.id);
await klargy.cancelEntry('visit', visit.id, { reason: 'Left before being seen' });
await klargy.noShowEntry('visit', visit.id);
```

```python
await klargy.call_entry("visit", visit.id, {"servicePoint": "ROOM-3", "staff": practitioner.id})
await klargy.complete_entry("encounter", encounter.id)
```

A `visit` call moves the visit's open entry: the one being served, else the oldest waiting. Narrow it with `service` when a patient is in two queues. The clients send an `Idempotency-Key` with every ticket call. When you retry a `visit` call after a crash, reuse your own key or address the entry by encounter: after a `complete`, the visit's open entry may be the next ticket a service flow issued.

**Catching up after downtime.** Page through `GET /entries?updatedSince=…` until a page is empty:

```ts
for await (const entry of klargy.iterateEntries({ updatedSince: lastSync, onPage: (p) => saveCursor(p.nextUpdatedSince) })) {
  await syncTicket(entry);
}
```

```python
async for entry in klargy.iter_entries(last_sync):
    await sync_ticket(entry)
```

## 4. React to webhooks

Klargy posts every change to your `webhookUrl`, signed with your signing secret:

```
X-Webhook-Id: <delivery id>        retries reuse it: de-duplicate on it
X-Webhook-Event: entry.called
X-Webhook-Timestamp: <unix seconds>
X-Webhook-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
```

Verify the signature over the **raw** body, reject timestamps more than 5 minutes off, answer 2xx quickly and do the work afterwards. Anything else is retried 6 times over about 14 hours.

```ts
import express from 'express';
import { verifyWebhook, isOwnEcho, WebhookVerificationError } from '@klargy/connect';

app.post('/klargy/:facility/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = verifyWebhook({ secret: secretFor(req.params.facility), headers: req.headers, rawBody: req.body });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.status(error.status).end();
    throw error;
  }
  res.status(200).end();
  if (!(await markDelivered(event.id))) return; // seen already
  if (isOwnEcho(event, integrationIdFor(req.params.facility))) return; // our own call, echoed

  switch (event.event) {
    case 'entry.called':
      return markCalled(event.data.refs?.visit, event.data.servicePoint?.name, event.data.refs?.staff);
    case 'entry.served':
    case 'entry.cancelled':
    case 'entry.no_show':
      return updateVisitQueueStatus(event.data.refs?.visit, event.data.status);
    case 'entry.transferred':
      return addVisitStep(event.data.refs?.visit, event.data.service.name);
    case 'journey.completed':
      return closeVisitQueue(event.data.refs?.visit);
  }
});
```

```python
from klargy_connect import construct_event, WebhookVerificationError

@app.post("/klargy/{facility}/webhooks")
async def webhooks(facility: str, request: Request):
    raw = await request.body()
    try:
        event = construct_event(secret_for(facility), request.headers, raw)
    except WebhookVerificationError:
        return Response(status_code=401)
    if event.is_own(integration_id_for(facility)):
        return Response(status_code=200)
    ...
```

Events: `entry.joined`, `entry.called`, `entry.served`, `entry.cancelled`, `entry.no_show`, `entry.transferred`, `entry.priority_changed`, `journey.completed`, `queue.paused`, `queue.resumed`, `appointment.created`, `appointment.rescheduled`, `appointment.cancelled`, `appointment.checked_in`, `servicepoint.opened`, `servicepoint.closed`, and `ping` from the admin's **Send test** button. `data.refs` holds your own ids for everything Klargy knows (`patient`, `visit`, `encounter`, `service`, `location`, `servicePoint`, `staff`). `data.origin.type` says who caused the event: `staff`, `public` (kiosk or phone), `integration` or `system`. Ignore fields you don't know: v1 only ever adds them.

## 5. Embed the desk

Your practitioners can call and move patients from Klargy's desk inside your app, without a Klargy password.

1. Register your app's origin in `embedOrigins` (section 2.2).
2. When a practitioner opens the queue screen, your **server** asks for a one-time URL:

   ```ts
   const { url } = await klargy.launchDesk({
     staff: { id: user.practitionerId, name: user.fullName, email: user.email },
     servicePoint: user.lastRoomId ?? null, // preselects a room
     returnOrigin: 'https://app.acme-emr.com',
   });
   ```

   ```python
   launch = await klargy.launch_desk({
       "staff": {"id": user.practitioner_id, "name": user.full_name, "email": user.email},
       "returnOrigin": "https://app.acme-emr.com",
   })
   ```

   Klargy finds the staff member by mapping or email, or registers them (this uses a staff seat). A new practitioner can only reach the desk through your app.
3. Your **page** frames it straight away. The code works once, within 60 seconds.

   ```ts
   import { embedDesk } from '@klargy/connect/desk';

   const desk = embedDesk({
     container: document.querySelector('#klargy-desk')!,
     url,
     onDeskChanged: (room) => setCurrentRoom(room?.externalId ?? null),
     onWaiting: (count) => setBadge(count),
     onEntryCalled: (entry) => openEncounterFor(entry.refs.visit),
     onEntryUpdated: (entry) => refreshVisit(entry.refs.visit),
   });
   onSignOut(() => desk.logout()); // leaves the room and signs the desk out
   ```

The desk posts only to your `returnOrigin` and accepts `klargy:logout` only from it. `embedDesk` likewise accepts messages only from the frame's window and Klargy's origin. Messages are fire-and-forget: webhooks remain the record. If the code expired (for example the page was opened from history), the desk asks the practitioner to open it again: call `/desk/launch` again.

Without the package, listen for `message` events where `event.origin` is the launch URL's origin. The types are `klargy:ready`, `klargy:desk-changed`, `klargy:waiting`, `klargy:entry-called`, `klargy:entry-updated` and, in the bar layout, `klargy:resize` ([v1 section 6](./v1.md#6-the-desk-inside-the-emr-phase-3)).

For a floating toolbar rather than a panel, add `layout=bar` to the URL (or pass `layout: 'bar'` to `embedDesk`): the desk becomes one row about 60px tall and posts `klargy:resize` with the height it needs when a menu opens or closes; size the frame to it with `onResize`. To sign out, post `{type: 'klargy:logout'}` to that origin.

To offer only the rooms that belong where the practitioner is working (consulting rooms in outpatients, reception desks at the front desk), add `roomTypes=consultation` to the URL (or pass `roomTypes: ['consultation']` to `embedDesk`), and when they move to another part of your app post `{type: 'klargy:room-types', roomTypes: ['reception']}` (or call `setRoomTypes`). The kinds are `reception`, `triage`, `consultation`, `cashier`, `pharmacy`, `lab`, `imaging` and `other`.

## 6. Serve patient lookup

With a `lookupUrl`, Klargy asks your EMR who a patient is: at reception, on the desk while someone is being served, and (if the organisation requires an MR or member number) on the kiosk and join page. You search your records and run any cover check. Klargy shows the answer and doesn't store it.

```ts
import { verifyLookupRequest, lookupMatch, lookupNoMatch, lookupResponseFor, WebhookVerificationError } from '@klargy/connect';

app.post('/klargy/:facility/patient-lookup', express.raw({ type: 'application/json' }), async (req, res) => {
  let request;
  try {
    request = verifyLookupRequest({ secret: secretFor(req.params.facility), headers: req.headers, rawBody: req.body });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  const found = await searchPatients(request.identifierType, request.identifier, request.locationRef);
  if (found.length > 1 && request.identifierType === 'phone') {
    return res.json(lookupResponseFor(request, lookupNoMatch(found.map(toCandidate)))); // up to 5
  }
  if (found.length !== 1) return res.json(lookupResponseFor(request, lookupNoMatch()));
  const p = found[0];
  res.json(
    lookupResponseFor(
      request,
      lookupMatch({
        ref: p.id,
        displayName: p.fullName,
        firstName: p.firstName,
        mrNumber: p.mrn,
        birthDate: p.birthDate,
        gender: p.gender,
        phoneMasked: mask(p.phone),
        cover: await coverFor(p), // { payer, plan, memberNumber, status: 'active' | 'expired' | 'inactive' | 'unknown', expiresOn, checkedVia }
        flags: p.flags,
      }),
    ),
  );
});
```

```python
from klargy_connect import verify_lookup_request, lookup_match, lookup_no_match, lookup_response

request = verify_lookup_request(secret, headers, raw_body)
answer = lookup_match({...}) if patient else lookup_no_match()
return lookup_response(request, answer)
```

Rules: answer within **5 seconds** (Klargy doesn't retry inside someone's request). A failed cover check is `status: "unknown"` with a `message`, never an error. In `public` context only `matched` and the first name are used. `lookupResponseFor` strips the rest, so a phone at the kiosk never shows anything else. Answer 401 for a bad signature, 400 for a bad body, and 404 for an unknown or switched-off connection.

## 7. Journey automation

Move patients from step to step without anyone transferring them by hand:

```ts
// The doctor orders labs: complete the consultation and queue the patient at the lab.
await klargy.transferEntry('visit', visit.id, { to: `${locationId}:lab`, reason: 'Lab orders', staff: practitioner.id });

// Labs paid and done: on to the cashier.
await klargy.transferEntry('visit', visit.id, { service: `${locationId}:lab`, to: `${locationId}:cashier` });

// Urgent result: move them up.
await klargy.setEntryPriority('visit', visit.id, { priority: 90, reason: 'Critical result' });

// The clinic stops for the afternoon.
await klargy.setServiceStatus('CLIN-GP', { status: 'PAUSED', message: "Dr Mensah's clinic is paused. Please wait at reception." });
await klargy.setServiceStatus('CLIN-GP', { status: 'ACTIVE' });
```

```python
await klargy.transfer_entry("visit", visit.id, {"to": f"{location_id}:lab", "reason": "Lab orders"})
await klargy.set_entry_priority("visit", visit.id, {"priority": 90})
await klargy.set_service_status("CLIN-GP", {"status": "PAUSED"})
```

`transfer` keeps the visit's journey and links the new ticket to the completed one. If the visit is already queued at `to`, it answers 200 and changes nothing, so you can call it on every relevant event in your EMR. Klargy's own service flows can transfer automatically when an entry is completed. Those events carry `origin.type: "system"`.

### 7.1 The outpatient journey

For a clinic that runs Reception, Cashier, Triage, Consultation, Laboratory, Imaging and Pharmacy in one waiting area, see [Running an outpatient journey](../guides/outpatient-journey.md). From the EMR side it uses:

```ts
// Consultation unpaid at check-in: the ticket waits for payment ("Awaiting payment" on the desk).
await klargy.createEntry({ service: 'CLIN-GP', refs: { patient: p.id, visit: v.id }, cleared: false });
// The bill is paid: the patient joins the line by when they arrived.
await klargy.clearEntry('visit', v.id);

// The doctor calls the patient into the room they are signed in to.
await klargy.callEntry('visit', v.id, { staff: doctor.id });
// Out for a sample and back.
await klargy.holdEntry('visit', v.id);
await klargy.resumeEntry('visit', v.id, { staff: doctor.id });

// The receptionist serving a walk-in starts their visit in the EMR.
await klargy.linkServingEntry({ staff: receptionist.id, refs: { patient: p.id, visit: v.id } });
```

```python
await klargy.clear_entry("visit", visit.id)
await klargy.call_entry("visit", visit.id, {"staff": doctor.id})
await klargy.hold_entry("visit", visit.id)
await klargy.link_serving_entry({"staff": receptionist.id, "refs": {"patient": p.id, "visit": visit.id}})
```

Every entry carries `held`, `awaitingClearance`, `sentBy` and `journey`; `entry.transferred` carries `from` (with `from.refs.encounter`, the encounter the patient just left). New events: `entry.held`, `entry.resumed`, `entry.cleared`. Handle `AWAITING_CLEARANCE`, `ENTRY_IN_OTHER_SERVICE` and `NO_SERVING_ENTRY`. Details: [v1 section 9](./v1.md#9-the-patient-journey-phase-6).

## 8. Appointments

Mirror your appointments so Klargy sends its usual reminders and checks people in when they arrive:

```ts
const { appointment, created } = await klargy.putAppointment(appt.id, {
  refs: { patient: appt.patientId },
  patient: { firstName: 'Ama', lastName: 'Mensah', phone: '+233200000000' },
  service: appt.clinicId,
  startTime: appt.start,
  endTime: appt.end,
  status: 'booked', // or cancelled, no_show, completed
});
```

```python
await klargy.upsert_appointment(appt.id, {"refs": {"patient": appt.patient_id}, "service": appt.clinic_id,
                                          "startTime": appt.start.isoformat(), "status": "booked"})
```

When the patient arrives, send `refs.appointment` with `POST /entries`. A booked appointment is then checked in (`appointment.checked_in`).

## 9. Analytics

Show queue numbers on your dashboards:

```ts
const today = await klargy.getAnalytics({ location: 'LOC-1' });
// today.overall.avgWaitMinutes, today.live.waiting, today.services[i].ref (your clinic id)
const lastWeek = await klargy.getAnalytics({ from: weekAgo, to: now, service: 'CLIN-GP' });
```

```python
today = await klargy.get_analytics(location="LOC-1")
```

Without `from` and `to`, the range is today in the location's timezone. Ranges are at most 90 days.

## 10. Testing in the sandbox

Ask the Klargy team for a sandbox workspace, or create one on your own Klargy instance:

```sh
cd frontend
npm run sandbox:create -- --name "Acme EMR sandbox"
```

It creates (or brings up to date) an organisation on the free **Sandbox** plan, which has EMR connections switched on and isn't offered to customers. The organisation gets a location, the services GP Consultation, Laboratory, Pharmacy and Cashier, service points (two consulting rooms and one desk for each department) and flows. Paying at the cashier sends the patient to the pharmacy automatically. It also creates an admin user and an EMR connection. The script prints the workspace URL, the admin login and the API key. The key and password are shown **once**. Running the script again changes nothing and shows neither. Pass `--rotate-key` for a new key or `--reset-password` for a new password. Other options: `--slug`, `--admin-email`, `--admin-password`, `--timezone`, `--location`, `--integration`. The script refuses to touch a workspace that isn't a sandbox.

```
Workspace URL:    https://acme-emr-sandbox.klargy.example
Connect base URL: https://acme-emr-sandbox.klargy.example/api/v1/connect/v1
Admin login:      acme-emr-sandbox-admin@example.com
Admin password:   ••••••••••••••••
API key:          klg_live_••••••••••••••••••••••••••••••••••••••••
```

Then:

1. Put the URL and key in your settings and press **Test connection**.
2. Save settings so you register and publish your catalogue.
3. Sign in to the workspace as the admin and map the four services (and rooms) to your catalogue.
4. Run a visit end to end: check in (`POST /entries`), call it from your app or the desk, transfer it to the lab and the cashier, and watch the pharmacy ticket appear by itself. Check that the webhooks arrive and that you ignore your own echoes.
5. Use **Send test** on the connection page to check your webhook endpoint.

#### Running both on one machine

Two Klargy addresses matter, and locally they often differ:

| Address | Used for | Example (Klargy in Docker on :8003) |
| --- | --- | --- |
| **API address** | Your server's Connect calls (`baseUrl`). Authenticated by the key; the host is ignored. | `http://host.docker.internal:8003` from an EMR in its own container, `http://localhost:8003` from the host |
| **Workspace address** | What a browser opens: the desk iframe (`launchDesk` URL), `statusUrl`, the embed script. Always `<slug>.<APP_DOMAIN>`. | `http://acme-emr-sandbox.localhost:8003` |

Klargy builds the workspace address from its `APP_URL` (in Docker, `http://localhost:8003` by default; with `npm run dev`, set `APP_URL=http://localhost:3000` or leave it empty and Klargy follows the address it is opened on). A container cannot resolve `*.localhost`, so don't use the workspace address as `baseUrl` from inside Docker, and don't hand the API address to a browser. Your `embedOrigin` is your EMR's browser origin (for example `http://localhost:3000`).

Klargy only posts to public addresses. To receive webhooks on a laptop, use a tunnel (any https tunnel works). For your own automated tests, sign requests with `signedHeaders` (TypeScript) or `signature_headers` (Python) exactly as Klargy does.

## 11. Go-live checklist

- [ ] API key and signing secret are stored as secrets, per facility, never in logs.
- [ ] **Test connection** calls `GET /me` and shows the organisation's name.
- [ ] Settings save calls `PUT /integration` (and keeps the signing secret) and `PUT /catalog`.
- [ ] All locations, clinics and departments that queue are in the catalogue and mapped in Klargy.
- [ ] Check-in calls `POST /entries` with a stable `Idempotency-Key`, and handles `QUEUE_CLOSED`, `ALREADY_IN_QUEUE`, `SERVICE_NOT_MAPPED`, `PATIENT_REQUIRED` and `LIMIT_REACHED`.
- [ ] Ticket moves use by-ref calls. Retries reuse their key or address the encounter.
- [ ] The webhook endpoint verifies signatures over the raw body, enforces the 5-minute window, de-duplicates on `X-Webhook-Id`, ignores its own echoes, answers 2xx fast and ignores unknown fields and events.
- [ ] A catch-up job pages `GET /entries` after downtime.
- [ ] The desk is framed from a registered `embedOrigin`, launched just in time, and signed out with `klargy:logout`.
- [ ] Patient lookup answers within 5 seconds, masks phone numbers and returns only `matched` and the first name in public context.
- [ ] Rate limits are respected: 120 requests a minute per key, honouring `Retry-After` on 429.
- [ ] Nothing depends on fields being absent: v1 only adds.
