# Serenity ↔ Klargy Connect: end-to-end findings

Run on 2026-10-15 against a local Klargy dev server (`http://serenity-emr-sandbox.localhost:3000`, sandbox
workspace made with `npm run sandbox:create`) and Serenity's local stack (frontend `nyaho.localhost:8084`,
backend `localhost:9001/v2`, Celery worker, Redis). Serenity code: `core-api-v2` branch `clinic-fixes`
(plugin migrations up to `20261020_queue_mgmt_phase5_methods`), `emr-nuxt-main` branch `staging-v3`.

Contract: [`docs/connect/v1.md`](v1.md). Section numbers below refer to it.

## 1. What was exercised

| Phase | Flow | Result |
|---|---|---|
| 1 | Subscribe the Klargy plugin; Test connection; Register; Publish catalogue; match records in Klargy | Works. Catalogue received: 7 locations, 60 clinics, 0 rooms, 96 practitioners, 7 registration fields. Klargy's match screen grouped department services by kind. |
| 2 | Serenity visit checked in (walk-in wizard) → ticket in Klargy | Works once the worker runs the task: ticket `G002`, stored on the visit, patient notified. |
| 3 | Queue desk in the OPD header: launch → room picker → pick room | Works. `klargy:ready`, `desk-changed` and `waiting` messages reached Serenity (header shows the room and a waiting count). `servicepoint.opened` webhook processed. |
| 3 | Call next from the embedded desk | Works. `entry.called` webhook processed for the right visit. |
| 4 | Desk asks Serenity for the patient's record (signed lookup, `patientRef`) | Works. Response matches §7: ref, displayName, firstName, mrNumber, birthDate, gender, phoneMasked, photoUrl, identifiers, cover, flags. |
| 5 | "Send to…" (transfer to laboratory) | Works once the job runs: `G002` → SERVED, new `L001` in Laboratory, same journey. |
| 5 | Priority, analytics, pause/resume a clinic queue, appointment upsert, `getVisitEntry`, `getMappedServices` | All succeeded. Klargy delivered `entry.priority_changed`, `queue.paused`, `queue.resumed`, `appointment.created`, `appointment.rescheduled`, `journey.completed`, `entry.transferred`, `entry.cancelled`, `entry.joined`; every delivery got a 200. |
| 2 | Serenity calls and completes a ticket (`updateTicket` call, complete) | Works. |

Not exercised: the automatic journey switches (lab/imaging on orders, cashier first, pharmacy call, urgent
priority, clinic-closure pause, no-show follow-up) beyond the manual "send"; the desk's Done / Not here
buttons and the settings that react to them (`sync_no_show`, `start_encounter_on_call`,
`cancel_on_ticket_cancel`); kiosk and join-page "require an MR or member number"; a phone lookup that
matches several patients; `GET /entries` catch-up.

## 2. Findings in Serenity (to fix)

Severity: **High** = breaks the flow or loses data silently, **Medium** = wrong or misleading behaviour,
**Low** = polish or documentation.

### S1 (High): queue tasks are dropped silently when the worker is stale or backed up
- The running Celery worker did not have `app.tasks.sync_queue_ticket` or `app.tasks.queue_journey_job`
  registered (it had started before they existed). The visit's ticket task was published and discarded; no
  ticket was issued, and nothing in Serenity said so. After a restart the tasks registered.
- `main-queue` held **49,829** messages (periodic tasks piled up while the worker was down). Queue-sync and
  "Send to…" jobs sit behind that backlog, so tickets and transfers are delayed indefinitely.
- `notify_queue` / `notify_journey` swallow every error by design ("the request must never notice"), and
  `POST /v2/queue-management/visits/{id}/send` answers `202 {queued: true}` with no way to see the outcome.
- Fix: put queue tasks on their own queue (and a worker for it) so bulk or periodic work can't starve them;
  assert at worker start-up that the queue tasks are registered; record each sync attempt and outcome on the
  visit (or an admin "queue sync log") with an alert after repeated failure; give "Send to…" a job id and a
  status the UI can show, instead of a bare 202.

### S2 (High): no catch-up after downtime
- §5 describes `GET /entries?updatedSince=…` for catching up after downtime. Serenity's vendored client has
  `list_entries` / `iter_entries`, but nothing in `plugins`, `services`, `tasks` or `api` calls them.
- Combined with S1, an outage leaves Serenity visits and Klargy tickets out of step with no way back.
- Fix: a periodic reconciliation task that walks `iter_entries` from the last seen `nextUpdatedSince` and
  applies the same handlers as the webhooks (deduplicated by entry and status).

### S3 (Medium): desk launch is refused from any origin Serenity wasn't configured with, even though Klargy accepted it
- `registerIntegration` sends `embedOrigins` to Klargy but stores only `signing_secret` and `integration_id`
  in the subscription config. Serenity's own allow-list for the desk is the frontend origin built from the
  organisation slug (here `https://nyaho.staging.serenity.health`) plus `config.embed_origins`, which stays
  empty. From `http://nyaho.localhost:8084` the desk showed "The queue desk address is not allowed"
  (`QUEUE_DESK_ORIGIN_NOT_ALLOWED`) while Klargy's CSP already listed that origin.
- The Queue Management Setup tab has no field for embed origins; the only way to set them was the JSON field
  in the generic subscribe modal.
- Fix: add an embed-origins field to the setup tab, persist what registration sends, and show the origins
  registered with the provider. Consider adding the origin of the request that clicked "Register" by default.

### S4 (Medium): the webhook and lookup URLs Klargy stores come from server config and aren't shown
- `registerIntegration` builds both URLs from `params.apiBaseUrl`, else `settings.SERVER_HOST` (default
  `http://api.serenity.health`). The UI button passes no parameters and only says "Registered".
- A dev, preview or staging deployment can therefore register another environment's URLs without anyone
  seeing it. For this run the call had to be made from the page with `apiBaseUrl: http://localhost:9001`.
- Fix: show the registered webhook URL, lookup URL and origins after registering; allow an admin-only
  override; base the default on a dedicated public-API-URL setting rather than `SERVER_HOST`.

### S5 (Medium): the "someone was called" notice throws
- `QueueDeskDrawer.notifyCalled` calls `this.$notify(...)`. This app doesn't install Element UI's
  `$notify` (the only use of it in `emr-nuxt-main`; notifications go through the `openToast` helper in
  `plugins/element-ui.client.js`). On every `klargy:entry-called` message the console shows
  `TypeError: this.$notify is not a function`, so the "Called G002 · Name — Open visit" notice never appears.
- Fix: use the app's toast helper (or import `Notification` from `element-ui`), with a unit test that
  dispatches an `entry-called` message.

### S6 (Medium): catalogue contents are noisy and ambiguous
- Klargy's match list shows names only. It contained entries whose names suggest they should not be queue
  targets (`Inactive Clinic`, `Offline Clinic`, `Test GP parent`, `Zero-Charge Clinic`) and several
  near-duplicates for one idea (`GP clinic`, `GP Consultation`, `GP Consultation Clinic`,
  `GP consultation Tema`, `GP consultation - TK`) spread across locations. 60 clinics were sent in total.
- I did not verify which of the 96 practitioners are inactive.
- Fix: publish only active, outpatient-bookable clinics and active practitioners; include the location in the
  display name when two clinics share a name; keep sending `kind` and `locationId`.

### S7 (Low): the plugin still describes itself as phase 1
- The plugin definition reads "Klargy queue management: webhooks, catalogue publishing." and is `v1.0.0`,
  while the same record lists 14 methods covering all five phases. Update the description and version when
  a phase ships.

### S8 (Low): two meanings of "registered"
- Test connection reported "integration active, registered" (Klargy's view, from a registration made by
  another client) while the same panel said "Not registered yet" (Serenity's view: no `integration_id` in
  its config). The label also stays stale until the page is reloaded.
- Fix: show both facts separately ("Registered with Klargy" from `GET /me`, "Registered by this Serenity
  organisation" from config), and refresh the label after Register.

### S9 (Low): inbound events are acknowledged but mostly unrecorded
- All 13 deliveries returned 200, but only `servicepoint.opened` and `entry.called` produced a handler log
  line. `entry.joined`, `entry.transferred`, `entry.priority_changed`, `journey.completed`, `queue.paused`,
  `queue.resumed` and `appointment.*` are accepted and nothing is recorded about what was done.
- The `entry.called` result is `{'ticket_stored': False}` with no explanation.
- Serenity's own `upsertAppointment` produced `appointment.created` / `appointment.rescheduled` webhooks back
  to Serenity (an echo). Ignore events whose `origin.integration_id` is this integration, and record
  "processed" or "ignored (reason)" per delivery.

### S10 (Low): no visible confirmation after "Send to…"
- The dialog closed on selection and the page showed no confirmation or error. I took the screenshot about
  8 seconds later, so a short-lived toast may have gone; check that one is shown, and that it reports failure.

## 3. Conformance checks that passed (keep these)

Run with the signing secret against Serenity's public endpoints:

| Check | Expected | Observed |
|---|---|---|
| Webhook, no signature | 401 | 401 |
| Webhook, wrong signature | 401 | 401 |
| Webhook, valid signature but timestamp 1 hour old | 401 | 401 ("more than 5 minutes from the server clock") |
| Webhook, body changed after signing | 401 | 401 |
| Webhook, valid | 200 | 200 |
| Webhook, same `X-Webhook-Id` again | deduplicated | 200 `{"duplicate": true}` |
| Webhook, unknown connection id | 404 | 404 |
| Webhook, malformed JSON with a valid signature | 400 | 400 |
| Webhook, unknown event type with a valid signature | accepted | 200 |
| Lookup, unsigned | 401 | 401 |
| Lookup, staff by MR number / by phone | match | matched, correct shape |
| Lookup, public context | first name only | `{"patient": {"firstName": …}}` only |
| Lookup, unknown identifier | `matched: false` | `matched: false`, `candidates: []` |
| Lookup, bad `identifierType` or `context` | 400 | 400 with the permitted values |
| API responses to the browser | secrets not returned | API key and signing secret come back masked (8 `*`) |

Rejected deliveries are logged at WARNING with the reason, which is useful for audit.

Notes, not defects: an unknown connection id answers 404 but a known one with a bad signature answers 401,
so connection ids can be probed (the contract asks for 404 on unknown connections). Error bodies repeat the
message in `detail`, `user_message` and `technical_message`.

## 4. Findings on the Klargy side (found while running this)

- **K1: `APP_URL` decides the desk address.** `buildAppUrl` uses `APP_URL` plus the workspace slug. With no
  `APP_URL` the desk launch URL pointed at `…localhost:8003` (the Docker port) and the iframe never answered.
  Local dev needs `APP_URL=http://localhost:3000`; consider deriving the host from the request when `APP_URL`
  is unset, or failing loudly.
- **K2: `MASTER_ENCRYPTION_KEY` has no dev default outside Docker.** `PUT /integration` returned 500
  `MASTER_ENCRYPTION_KEY is not set`. The error body also carried a `stack` field; make sure production
  responses never include stack traces.
- **K3: root `.env` is missing `APP_URL` and `MASTER_ENCRYPTION_KEY`**, which `docker-compose.yml` supplies.
  Add them to `.env.example`.
- **K4: workspace host vs API host.** The Connect API authenticates by key and ignores the host, but the
  desk and status pages need the workspace host (`<slug>.<APP_DOMAIN>`). A Serenity running in Docker can
  reach Klargy at `host.docker.internal` but cannot resolve `*.localhost`; keep these two addresses separate
  in the docs for local setups.
- **K5: Next 16's dev server (re)writes `frontend/AGENTS.md` and `frontend/CLAUDE.md` on start** ("Generated
  AGENTS.md and CLAUDE.md for AI agents"). They are tracked in this repo, so a dev run can show them as
  modified; set `agentRules: false` in `next.config.ts` if that isn't wanted.

## 5. Records this run created

The Serenity backend is configured against the **shared staging database** (`emr_stag` on
`staging.serenity.health`), not a local one. Test writes landed there.

Serenity (staging data):
- Klargy plugin subscription for the Nyaho organisation (org-plugin 13), holding the sandbox base URL
  (`http://host.docker.internal:3000`), the sandbox API key, a signing secret and `embed_origins`.
- Visit `9a7169b0-7e31-496c-89ac-41d93b884ef8` for patient *Baby Yaa Test*: GP Consultation with Duke Kwaku
  Agbodeka, checked in (registration and consultation charges created), plus its appointment-slot hold and
  stored queue tickets `G002` and `L001`.
- A Klargy appointment `int-test-appt-1` (shared as a booked appointment for the same patient).
- Redis `main-queue`: one pending `sync_queue_ticket` (issue) and one `queue_journey_job` (send), which will
  run once the backlog clears; both are idempotent against the tickets that already exist.

Klargy (local database):
- Five Connect migrations applied (`20261014120000` to `20261016090000`) and the Prisma client regenerated.
- Sandbox workspace "Serenity EMR sandbox" with its admin and EMR connection; the login and key are in the
  scratchpad file `sandbox.out`, not in the repo.

Suggested clean-up: unsubscribe the plugin (or rotate the sandbox key), end the visit, cancel the test
appointment, and delete the sandbox workspace when finished.

## 6. Fixed

Klargy (branch `claude/project-thread-mj02be`):

- **K1:** links (desk launch, `statusUrl`, emails) are built by `appUrl()`. With `APP_URL` set it is used as
  before. In development without it, Klargy uses the protocol and root host of the requests it serves (so
  `npm run dev` on :3000 links to `<slug>.localhost:3000`). In production the app refuses to start without
  `APP_URL`, with a message saying what to set. `docker-compose.yml` now passes `APP_URL` through from `.env`.
- **K2:** error responses never carry a stack trace in any environment (it stays in the server log).
  `MASTER_ENCRYPTION_KEY` falls back to the docker-compose development default outside production (with a
  one-time warning); production still refuses, with a message on how to generate and keep the key.
- **K3:** new repo-root `.env.example` with `APP_URL`, `APP_DOMAIN` and `MASTER_ENCRYPTION_KEY` (and the other
  compose settings); `frontend/.env.example` explains the local values.
- **K4:** "Running both on one machine" in [guide.md section 10](./guide.md#10-testing-in-the-sandbox) and
  `docs/DEPLOYMENT.md` separate the API address (`host.docker.internal`, ignored by the key check) from the
  workspace address (`<slug>.<APP_DOMAIN>`, what browsers open).
- **K5:** `agentRules: false` in `frontend/next.config.ts` (supported by Next 16.3), so `next dev` no longer
  rewrites the tracked `AGENTS.md` and `CLAUDE.md`.

Serenity (to be filled in by the Serenity changes):

- **S1:** Queue tasks run on their own `queue-management` Celery queue with a dedicated worker; the worker checks at start-up that they are registered; every run is recorded with its outcome, and organisation admins are alerted after 5 failures in a row. "Send to…", call, hold and resume return a `job_id` with `GET /v2/queue-management/jobs/{id}`.
- **S2:** A `reconcile-queue-entries` beat task (every 5 minutes) walks `GET /entries` from a stored cursor and applies the webhook handlers, deduplicated.
- **S3:** Registration stores the embed origins it sends (including the origin that clicked Register); the setup tab has an embed-origins field and shows what is registered.
- **S4:** Webhook and lookup URLs come from a new `PUBLIC_API_URL` setting (falls back to `SERVER_HOST`), admins can override it, and the setup tab shows the registered URLs and time.
- **S5:** The called-patient notice uses the app's toast helper, with a unit test.
- **S6:** Only active clinics at live locations and active practitioners are published; clinics sharing a name get the location added.
- **S7:** Plugin description and version updated (1.6.0) by an idempotent migration.
- **S8:** Setup shows "Registered with Klargy" and "Registered by this organisation" separately and refreshes after Register.
- **S9:** Every delivery is recorded as processed or ignored with a reason; echoes of Serenity's own actions are ignored; `ticket_stored: false` now says why.
- **S10:** Send to shows a success or failure toast from the job outcome.

---

# Revalidation: 2026-10-16

Re-run after the Serenity fixes (`core-api-v2` up to `08c69c53`, `emr-nuxt-main` up to `5be76984`), same
local setup. Klargy needed three newer migrations first (`20261017090000_connect_patient_journey`,
`20261018090000_whatsapp_channel`, `20261018100000_booked_arrival`) and a Prisma client regenerate.

## 7. Status of each finding

| # | Finding | Status | Evidence |
|---|---|---|---|
| S1 | Queue tasks dropped silently / stuck behind a backlog | **Fixed, with a deployment condition** (see N2, N3) | Queue tasks now route to their own `queue-management` queue; the new `celery-queue-worker` logs `Queue Management tasks registered: [sync_queue_ticket, queue_journey_job, reconcile_queue_entries]` at start-up. A "Send to Laboratory" job ran within seconds and issued the lab ticket while `main-queue` still held 49,941 messages. |
| S2 | No catch-up after downtime | **Fixed** | `reconcile_queue_entries` walked Klargy's changes (2 pages, 1 entry) and applied the `entry.served` Serenity had missed (`sent_by: reconcile`); its cursor advanced. After restarting `celery-beat`, `redbeat:reconcile-queue-entries` is registered (every 5 minutes). |
| S3 | Desk refused from origins registered with Klargy | **Fixed** | The setup tab has "Serenity Addresses Allowed To Show The Queue Desk"; registering saves it first. The desk launched from `http://nyaho.localhost:8084` and the room picker, call and complete all worked. |
| S4 | Registered webhook/lookup URLs unseen and not overridable | **Partly fixed** | `webhook_url` and `lookup_url` are now stored in the subscription config, and the backend accepts `apiBaseUrl` and a `PUBLIC_API_URL` setting. The panel still shows only the desk addresses, and has no field for the API address. With neither set, Register sends `SERVER_HOST` (`http://api.serenity.health`); I registered with the override from the page. |
| S5 | `this.$notify` is not a function | **Fixed** | Calling a ticket shows "Called L001 · Baby Yaa Test · Open visit"; no console error. |
| S6 | Noisy catalogue | **Not fixed** | Klargy's match list still offers `Inactive Clinic`, `Offline Clinic`, `Test`, `Test GP parent`, `Test Insurance Clinic`, `Zero-Charge Clinic`, five GP variants, and a duplicate `physician specialist (airport main)`. The publish now sends 74 services (was 60 clinics) because department services were added. |
| S7 | Plugin still described as phase 1 | **Fixed** | Description now covers tickets, desk, portal ticket, journey, appointments, figures and catch-up; version 1.6.0. |
| S8 | Two meanings of "registered" | **Fixed** | After Test connection the panel shows "Registered with Klargy" and "Registered by this organization" separately. |
| S9 | Webhooks acknowledged but unrecorded | **Fixed** | Each delivery logs `processed: {…}` or `ignored (echo)` / `ignored (nothing to do for journey.completed)`. `entry.called` now says `ticket: unchanged (L001 already on the visit)`; `entry.served` says `encounter: skipped: no encounter on the ticket`. |
| S10 | No visible confirmation after "Send to…" | **Inconclusive** | The button now shows a spinner while the job runs and the ticket appeared in Klargy. I did not capture a success or failure message in the screenshots taken. |

Journey Klargy → Serenity events seen after the fixes: `servicepoint.opened/closed`, `entry.called`,
`entry.served`, `journey.completed`, plus echoes of Serenity's own `queue.resumed` and
`appointment.rescheduled` (ignored as echoes).

## 8. New findings

### N1 (High): the floating queue desk never appears for a normal session
- `QueueDeskHost` shows the desk only when `store.state.auth.loggedIn` is true. That flag is not restored on
  reload (`WorkspaceDashboardShell.vue` says so in a comment and uses the access-token cookie instead). In
  this run it was `false` right after a normal sign-in, and after a reload, even though the session worked and
  the `loggedIn` cookie was set. No desk element was rendered until the flag was set by hand
  (`dispatch('auth/setLoggedIn', true)`); after that the bar appeared and everything worked.
- Fix: use the same session check as `WorkspaceDashboardShell` (`auth/isLoggedIn`, the stored tokens, or the
  `v2token` cookie) in `QueueDeskHost.show` and wherever else the desk reads `auth.loggedIn`.

### N2 (Medium): `worker-start.sh` does not consume the queue-management queue by default
- The comments in `celery_app.py` say "worker-start.sh consumes it alongside main-queue", but the default is
  `CELERY_QUEUES=main-queue,heavy-queue,sweep-queue`. Queue tasks are only consumed by the separate
  `celery-queue-worker` service (`CELERY_QUEUES=queue-management`). A stack running only `celery-worker`
  accepts the tasks and never runs them, which is the original silent-drop problem again.
- Fix: include `queue-management` in the default list, or make the start-up check fail loudly when no worker
  in the deployment consumes it.

### N3 (Medium, deployment): running containers don't pick up the new tasks, queue or schedule
- Serenity's code is bind-mounted, but the running `celery-worker` image was 10 days old, `celery-beat` had
  been running since October 14, and `celery-queue-worker` did not exist. Until I started it and restarted
  beat, queue tasks went to a queue nobody read and the 5-minute catch-up was not scheduled
  (`reconcile_last_run` was stale, with an error from an earlier run).
- Fix: add to the deployment checklist: start `celery-queue-worker`, restart `celery-beat` (redbeat reads the
  schedule at start) and each worker, then check the start-up log line for registered tasks.
- The 49,941 messages in `main-queue` are still there; consider expiring old periodic tasks (`expires`).

### N4 (Low): an expected 404 is logged as an error with a traceback
- Before issuing or transferring, the worker asks Klargy whether the visit holds an open ticket. Klargy answers
  404 `NO_OPEN_ENTRY` when it doesn't, and the worker logs it with a full `PluginExecutionError` traceback
  before carrying on. Treat that code as a normal "no" and log it at info.

### K6 (Klargy, Medium): a database/schema mismatch reaches the user as a raw Prisma error
- With Klargy's database behind its code, the desk bar embedded in Serenity showed
  "Invalid `prisma.queue.f…`" in the page. Return a generic message to the client and keep the detail in the
  server log.

## 9. Checks re-run and unchanged

- Webhook and lookup signature checks: same results as section 3 (missing, wrong, stale and tampered
  signatures rejected; malformed JSON 400; unknown connection 404; public lookup returns only the first
  name). Delivery ids are de-duplicated across runs: reusing ids from the earlier run returned
  `{"duplicate": true}`.
- Phase 5 calls: `setTicketPriority`, `getAnalytics`, `setServiceStatus` (pause and resume),
  `upsertAppointment`, `getVisitEntry` and `getMappedServices` all succeeded.

## 10. What this revalidation added to the environment

- Serenity: started `celery-queue-worker` (new container); my `docker compose up` also recreated the `backend`
  container, whose start-up migration step found nothing to apply (the database was already at
  `20261022_queue_mgmt_staff_desk`); restarted `celery-beat`.
- Serenity (staging data): a second ticket for visit `9a7169b0-7e31-496c-89ac-41d93b884ef8` (laboratory
  `L001`, called and completed); `int-test-appt-1` re-synced with a new time.
- Klargy (local): three more migrations applied and the client regenerated; dev server restarted with
  `APP_URL=http://localhost:3000`.

---

# Follow-up fixes: 2026-10-16

Applied in the Serenity repos (uncommitted) and checked live against the running stack.

| Item | Change | Check |
|---|---|---|
| N1 desk hidden | `QueueDeskHost` now uses a shared session check (`libs/queue-desk/session.js`: store flag, either stored token, or the `v2token` cookie) instead of `auth.loggedIn` alone. | After a plain reload (flag still `false`) the desk and its frame render with no manual step. Jest: 95 queue-desk and setup tests pass. |
| N2 default worker queues | `worker-start.sh` consumes all four queues by default; `QUEUE_MANAGEMENT_QUEUE` is a real constant in `ALL_QUEUES`; the stack file has a `celery-queue` role (it had none, so production would not have consumed the queue); checklist updated. | Routing tests updated and passing. |
| Related routing bug | The "route scheduled tasks to the sweep queue" loop also re-routed `reconcile_queue_entries`. It now leaves queue-management tasks alone. The stale test that expected `sync_queue_ticket` on `main-queue` was replaced. | Three new routing tests; 82 queue and routing tests pass. |
| N4 log noise | A coded 4xx provider answer (e.g. `NO_OPEN_ENTRY`) is logged at info, without a traceback (`is_provider_refusal` in `plugins/service.py`); everything else still logs the full error. | Worker log: "…was refused by the provider…" at INFO; the same job then issued the ticket. |
| S4 API address | New optional "Serenity API address" field, saved with the settings (`api_base_url`), validated as http(s) and used when registering; a value on the call wins. | The real Register button registered `localhost:9001`; the panel lists the Webhook URL, Lookup URL and Desk addresses. |
| S6 catalogue | The publisher already excluded inactive clinics, dead locations and inactive practitioners. The odd clinics (`Inactive Clinic`, `Offline Clinic`, `Test`, `Zero-Charge Clinic`, …) are **active, undeleted records in the data**, so this needs a data clean-up. Code change: clinics that still share a name at one location are now numbered ("Physician Specialist (2)"). | Unit test added. |
| S10 confirmation | Already implemented (`toastJobResult`). The pending notice "Sending to Airport Main Pharmacy. The queue will update in a moment." showed, and the pharmacy ticket `P001` was issued. I did not catch the final success notice on screen. | |
| K6 / K2 (Klargy) | Klargy's error handler already returns a generic message in production and never returns stack traces; the raw Prisma text I saw was a development build. No change needed. | |

Restarts needed after deploying these: backend, `celery-worker`, `celery-queue-worker` (done locally).
