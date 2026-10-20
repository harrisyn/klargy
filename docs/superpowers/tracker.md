# Work Tracker

Living checklist, updated in place as work lands. `[x]` done, `[ ]` open, `[~]` in progress.
Branch: `arch-review-fixes`. Origin: architecture review of 2026-09-25.

## Batch 1: Security and build fixes

- [x] Tenant isolation: every resource route checks the caller's org (queues, locations, services, service points, instances, flows, analytics, data sources, field mappings, appointments, notifications, users, invites) via `middleware/tenantScope.middleware.ts`; verified live by `tests/tenant-isolation-smoke.js`
- [x] `GET /users` scoped to the caller's org (was returning every tenant's users)
- [x] Role escalation: `createUser`/`updateUser` cannot grant a role above the caller's; org is forced to the caller's org
- [x] Invite registration crash + public invite preview (`/public/invites/:code`) + accept-invite UI on `/register?invite=` (verified in browser: invite → account → tenant login → dashboard)
- [x] Stripe v22: renewal/failure webhooks read the subscription ID from `invoice.parent.subscription_details`
- [x] Backend `tsc --noEmit` clean (13 errors)
- [x] Frontend `tsc --noEmit` clean (3 errors fixed)
- [x] JWT secret: no hardcoded fallback in production; one source of truth
- [x] One-time codes stored in the DB instead of process memory
- [x] Rate limiting on login, OTP, public join (DB-backed so it works serverless)
- [x] Data-source credentials encrypted at rest and masked on read
- [x] Single shared Prisma client (auth controller had its own)
- [x] Encryption tests pass without a manually set `MASTER_ENCRYPTION_KEY`

- [x] Org signup trusted a client-sent `emailVerified` flag; now verified + consumed server-side
- [x] Three different JWT fallback secrets unified in `lib/jwt.ts`; production refuses weak/default secrets
- [x] Deactivated users could still log in
- [x] CORS allowed every origin; now root domain, subdomains, `ALLOWED_ORIGINS`, verified custom domains
- [x] `updateService` mass assignment (could repoint `locationId` to another org)
- [x] Error handler leaked internal error messages in production
- [x] `REGISTRATION_MODE=open` removed (let anyone self-assign any role); registration is invite-only
- [x] Invites: 128-bit codes, 7-day default expiry, atomic claim, role capped by inviter's role
- [x] Failed sign-in reloaded the page (global 401 redirect) so the error never showed

## Batch 2: PRD gaps

- [x] Appointments: backend fixed (future-date slots, atomic booking, double-cancel guard, check-in via real ticket sequence, patient search) + `/appointments` page (book with patient search or new patient, reschedule, cancel, check in); verified in browser
- [x] "Send to next service": `POST /queues/:id/entry/:entryId/transfer` + Complete-modal buttons wired (auto-transfer alert replaced with inline notice)
- [x] Turn-approaching / now-serving / joined notifications fired from the queue flow (once per entry+type; threshold per org)
- [x] Email + SMS channels (Twilio via env; console in dev), metered with EMAIL/SMS credits
- [x] Notification settings UI: Settings → Notifications tab
- [x] Forgot-password / reset-password flow (`/forgot-password`, `/reset-password`; single-use 1h tokens, link goes to the user's own subdomain; verified via Mailpit)
- [x] `/privacy` and `/terms` pages (describe what the product actually does; operator must add legal entity + `LEGAL_CONTACT_EMAIL`)
- [x] Audit log backend (`AuditLog`, `GET /orgs/:id/audit-logs`) for join/call/serve/cancel/no-show/transfer/reorder/status + appointments
- [x] Audit log page (`/admin/audit-log`, org admins)
- [x] Outbound webhooks backend: signed (HMAC-SHA256), retried with backoff via `/cron/frequent`, SSRF-guarded; verified by `tests/queue-flow-smoke.js`
- [x] Webhooks UI (`/admin/integrations`): add/edit/enable/test/rotate secret/delivery log
- [x] Display board: "Display not found" state for an invalid code/ID, polling stops

- [x] Customer journeys were never created (Journeys analytics always empty); now start on join, extend on transfer, close when done
- [x] Transfers never set `previousEntryId` ("total transfers" always 0); auto-transfer in markServed dropped session/sortOrder
- [x] `callNext` ignored manual reordering (`sortOrder`); one shared waiting order everywhere
- [x] Three different queue-position formulas unified (`computePosition`)
- [x] `waitDuration` / `serviceDuration` now recorded (analytics + AI need them)
- [x] Data-source fetches and webhooks blocked from private network addresses (SSRF)

## Batch 3: Single deployment (Next.js + Vercel)

- [x] Backend moved into the Next app (`frontend/src/server`); Express served from `src/pages/api/v1/[...path].ts`; `backend/` removed
- [x] Socket.IO replaced with Pusher-protocol real-time (Soketi locally, Pusher/Ably in prod). Payloads reduced to IDs/statuses (no PII), so channels can stay public; events flushed before the response ends; polling fallback when unconfigured. Verified by `tests/realtime-smoke.js`
- [x] API client uses same-origin `/api/v1` (`lib/apiBase.ts`); obsolete `NEXT_PUBLIC_API_URL` lines in local `.env` files commented out
- [x] Middleware runs on the Node runtime and resolves tenants from the DB (60s cache); `/api` and static files excluded
- [x] Custom domains attach to the Vercel project via the Domains API when `VERCEL_TOKEN`/`VERCEL_PROJECT_ID` are set; verify uses Vercel's DNS/cert check
- [x] `vercel.json` (build runs migrations, crons, function duration), Prisma `rhel-openssl-3.0.x` target, `.env.example` rewritten, `docs/DEPLOYMENT.md`
- [x] docker-compose: one `app` service + Soketi + Mailpit
- [x] Production Dockerfile (Debian slim, standalone, migrations on start) built and booted
- [x] Redis removed

- [x] `next build` passes (fixed nullable navigation hooks once a `pages/` dir exists)
- [x] Checkout success/cancel URLs pointed at the root domain (users came back signed out); now return to the tenant origin
- [x] Data-source router's router-level auth turned every unknown API path into a 401
- [x] No default superadmin credentials: first-run `/setup` page creates it, gated by a setup token (replaced create-superadmin.js)
- [x] README rewritten for the single-app layout

## Batch 4: AI layer

- [x] LLM-agnostic provider layer (`server/services/ai`): Anthropic (default `claude-opus-5`, adaptive thinking, server-side refusal fallback), OpenAI, Gemini, any OpenAI-compatible endpoint; superadmin **AI Providers** page (key encrypted, one active, test button); env fallback (`AI_PROVIDER` + key)
- [x] Gating: plan `ai` feature + org toggle (Analytics page) + 1 AI credit per question/digest; rate limited
- [x] "Ask your data" panel on Analytics: 8 org-scoped aggregate tools, answers stored with their source numbers ("Show the numbers"). Verified end to end through the UI with a scripted OpenAI-compatible mock
- [x] Daily AI digest (`/cron/daily`), stored + emailed to org admins; shown on the Analytics panel
- [x] Statistical wait forecast (`/ai/forecast/:serviceId`, also an AI tool): median service time × people waiting ÷ active desks, arrivals by weekday/hour
- [x] Live wait-spike alerts on the Queues page (statistical; no provider needed)

- [x] Appointment reminders for tomorrow (`/cron/daily`, email/SMS per org settings, once per appointment)
- [ ] Live AI call not verified with a real vendor key in this session (no key available) — run **Test connection** on AI Providers after adding one
- [x] Ticket wait estimates use the median real service time across the desks open now (`services/waitEstimate.ts`), not the configured slot length

## UI pass (as pages are touched)

- [x] Headed-browser pass: every tenant admin page, superadmin dashboard/orgs/plans/payment/AI providers, auth pages, and the public join → status → display flow (live updates confirmed on the status page and display board)
- [x] Services/Locations flashed "No services / No locations" and a wrong usage count before data loaded
- [x] Join page: fields now First/Last name → contact → custom (was Phone, Last, MR, First); labels linked to inputs (screen readers); friendly "Please enter your name" instead of "Service ID and name are required"
- [x] Kiosk mode hid optional name fields, so kiosk joins always failed for orgs whose name fields aren't marked required
- [x] A transient API/DB error on `/users/me` signed the user out; now only a real 401 does
- [x] New shared `AuthShell` (dark bg, single card) for invite / forgot / reset pages
- [x] Emails: shared flat-teal layout replaces purple-gradient + emoji header
- [x] Login page: solid hero heading; layout collapses to one column under 900px
- [x] Login page `/join` dead link → `/locations`
- [x] Receptionist dashboard showed a "Generate QR" button for a page they can't open (dashboard replaced by Today)
- [x] Tenant app main column had no `min-width: 0` → wide tables pushed the whole page sideways
- [x] Settings tabs wrapped onto two lines at laptop widths
- [x] Settings save failed for every org without the customBranding feature (always sent branding fields)
- [x] Analytics: removed a hardcoded "+12%" trend badge (fabricated number)
- [x] Sidebar: Services and Settings share the same gear icon (new shell uses distinct Lucide icons)
- [x] Sidebar grouped into Today / Insights / Setup / Organization / Platform
- [x] Route wrappers use the shared `RequireRole` guard

## UI revamp

- [x] Landing page: animated lobby scene (door → kiosk → queue → desk), journey, audience rows, TV section, closing CTA
- [x] Login redesign on a split `AuthLayout` (tenant logo/colour applied); workspace finder kept
- [x] Sign-up cut to one step + emailed code (auto-submits), live address check, lands signed in on the new subdomain
- [x] `/welcome` quick setup: location + service chips + hours → location, queues, a desk per service, "You're live" with QR. Respects plan service limits
- [x] App shell: ink sidebar in groups, mobile drawer, quiet page headers, new tokens (teal/amber/ink/paper), visible focus ring
- [x] Settings rebuilt: section nav, reorderable patient fields with required switches, screen-privacy picked from previews, sticky save bar with unsaved-changes warning
- [x] Settings showed "No organization" while the signed-in user was still loading
- [x] Join page follows the field order chosen in Settings
- [x] **Public display endpoints sent every patient's full name** even in "ticket number only" mode (hidden only in the browser). Now redacted server-side (`lib/screenName.ts`): none / "Kofi B." / full name
- [x] Lobby screen rebuilt: services view (one service gets the whole screen), desks view, full-screen call flash (+ spoken call when sound is on), "scan to join" QR, auto-hiding controls, light/dark
- [x] Display media: `DisplayMedia` playlist (image/video, upload ≤4MB or link, per-location or all, order, pause, date window) + per-location `displayConfig` (ticker messages/speed, media on/off, full-screen-when-quiet vs beside-the-queue, quiet interval, call flash). Admin at `/admin/displays`; screens refresh live on change. A new call always interrupts media
- [x] Files over 4MB upload straight from the browser to Uploadcare (with progress); the server confirms and stores them with the secret key
- [x] Adverts are plan-gated: free-plan trial (14 days, 3 items), paid plans include a capped playlist (5 items, files ≤4MB), lobby media pack add-on for large uploads, streams and +25 items per pack. Numbers editable per plan
- [x] QR codes generated locally (`qrcode`); the ticket page was sending each private ticket URL to api.qrserver.com
- [x] Setup checklist on Today (desk, QR poster, test join, invite team) until done or dismissed
- [x] Dev server served a stale route table (Express app cached on `globalThis`); no longer cached

## Desks, widgets and terminology

- [x] Staff desk console at `/queues`: sign in to a desk, call next / done / call again / not here, call someone out of order, drag to reorder, finish people left with no desk, details with data-source lookup
- [x] Keyboard shortcuts (N, D, A); waiting count in the tab title; browser alert when someone joins while the tab is hidden
- [x] Pop out: always-on-top Document Picture-in-Picture window sharing live state (Chrome/Edge); small popup window elsewhere
- [x] `/widget/desk` standalone (own sign-in), installable as an app (manifest + icons)
- [x] `/embed/desk.js`: floating desk button for other web apps (records systems, help desks) with a live waiting count; snippet under "Use this desk inside another app"
- [x] Call-next claims atomically (two desks could get the same person); recall endpoint; re-entering your own desk after a refresh works; occupied desks can be taken over
- [x] "Not here" recorded NO_SHOW (it was cancelling)
- [x] Organization type + own word for the people it serves (patient, guest, client…), asked in quick setup and Settings; `termsFor()` used across UI, public pages and the AI prompt. Existing orgs default to healthcare
- [ ] **Desktop app (to consider/build):** a small Tauri tray app wrapping `/widget/desk` for always-on-top without a browser, a global hotkey for "call next" from any app, start at login, native notifications. Browsers can't do global hotkeys
- [x] Scheduled playlists: days of the week, time windows (overnight OK), date ranges, per location or all, priority (takes over / normal / filler); one playlist can run on any set of days
- [x] Streams on lobby screens: YouTube, Vimeo, HLS live (.m3u8)
- [ ] Lint: 508 warnings to work down (mostly React Compiler advisories: setState in effects, effects calling later-declared functions)
- [ ] A desk that serves several services at once (sign in once, call from whichever queue is due). Today one desk sign-in = one service
- [ ] `/my-queue` (PATIENT accounts) is unlinked legacy; decide whether to keep it

## Page review (this pass)

- [x] Today replaces the template dashboard: live numbers, services table, desks, today's appointments
- [x] Analytics: today / 7 / 30 days, services table, busy-times chart, journeys
- [x] QR codes: print-ready A4 poster
- [x] Staff: team list with roles and access, email invites, cancel invites
- [x] Public join page rebuilt (live waits, one tap for single-service locations, straight to the live ticket); status page restyled; kiosk/multi-ticket are staff link modes (multi-ticket called missing endpoints)
- [x] `/public/locations` listed every organization's locations to anyone; now only the workspace whose address it is
- [x] Removed the legacy `/[orgId]` catch-all; real 404 page; workspace-not-found restyled
- [x] Platform admin pages share the app shell; titles and copy sentence case and plain language throughout; header buttons were forced white by a leftover rule
- [ ] AI analytics tools (`ai/metrics.ts`) still bucket hours in the server's timezone (org-wide, can span locations)
- [x] Upgraded to Next 16.3 (Turbopack builds, `middleware.ts` → `proxy.ts`, ESLint 9 flat config replaces `next lint`); `npm audit` clean
- [ ] Direct Uploadcare uploads not tried with real keys (dev has only the public demo key)
- [ ] Dev DB clean-up: smoke-test orgs and the Ridgeway test org (plus its sample media) can be deleted

## Improvements noticed (not yet scheduled)

- [x] Plan user limit counted walk-in patients and deactivated users as seats (Nyaho showed 12/10 with 2 staff); now active staff only
- [x] Optional Postgres in docker-compose (`--profile localdb`); host DB stays the default. See docs/DEPLOYMENT.md
- [x] Billing add-on select truncated at laptop widths (shorter labels)

- [x] Plan editor uses the enforced feature keys; legacy keys on saved plans are read as their equivalents (`normalizePlanFeatures`)
- [x] Deleted `INIT_SYSTEM_NOW.js`
- [x] `npm audit`: fixed all but one (nodemailer → 10, verified sending). Remaining: postcss bundled inside Next 15, build-time only; fixed by the Next 16 upgrade (below)

- [x] AI tools return aggregates + service/location names only (enforced in `ai/metrics.ts`)

- [x] Days, opening hours, slots, check-in, reminders, analytics ranges and the forecaster use the location's timezone (`utils/date.ts`, tested incl. DST)
- [x] Platform → Text messages: Twilio or Africa's Talking, encrypted keys, send-a-test; env Twilio stays the fallback

- [x] Data-source header values encrypted at rest and redacted in responses
- [x] README no longer documents `REGISTRATION_MODE`
- [x] Daily cron seals any data-source secrets still in plain text (idempotent)

- [x] Slug change in Settings silently locks the admin out — now warns, then redirects to the new address
- [x] Shared `NoOrganization` state
- [x] `alert()` replaced with toasts (`lib/toast.ts`) that show the server's message
- [ ] Delete temp `superadmin@qms.local` dev account before any non-dev use
- [ ] Real-money Stripe/Paystack checkout verification with test-mode keys

## Platform services (2026-10-19)

- [x] One superadmin page (**Platform services**) replaces Add-on pricing, Payment providers, Text messages, File storage and AI providers: tile grid + settings panel, driven by definitions in `components/platform/registry.ts`; old URLs redirect
- [x] Superadmin pages are denser (`.sa-compact`, 80% scale)
- [x] S3-compatible file storage (AWS S3, MinIO, R2, Spaces...) with hand-rolled SigV4; verified against a real S3 server (accepts the right secret, rejects a wrong one)
- [x] Shared WhatsApp number: platform sender (WhatsApp Web, Cloud API or Twilio); organizations choose "Klargy shared number" in Settings → WhatsApp
- [x] `seed_base_plans` migration: Starter, Pro, Sandbox and credit allowances reach production; Pro gets `whatsappNotifications`
- [ ] Shared number is send-only: replies and STOP sent to it aren't routed to an organization yet
- [ ] Shared number messages aren't metered; decide whether they use credits
- [ ] Price AI/SMS/storage as add-ons (add-on tiles still cover locations, seats and display media only)


## Wallet billing (2026-10-19)

- [x] Per-organization money wallet (`WalletLedgerEntry`, append-only); superadmin credits/debits it from the organization page; tenants see balance, next charge and ledger on Billing
- [x] A credit renews/re-enrols a lapsed, provider-less subscription from the wallet (`applyWalletToSubscription`); wallet-managed subscriptions also renew on read and in the daily cron (`settleDueSubscriptions`)
- [x] Superadmin "give a plan at no cost until a date": afterwards revert to the original plan, or stay on the plan at a custom price billed from the wallet (`walletSettlement.ts`, tested)
- [x] Tenants can pay for a plan from their wallet (`/tenant/wallet/checkout`)
- [ ] Wallet is one currency per organization (its plan's currency); no top-up by card yet
- [ ] A wallet-managed subscription that can't pay goes PAST_DUE (locks to free-tier features); no grace period or reminder email yet
- [x] Provider payments credit the wallet first: Stripe/Paystack checkouts and Stripe renewals add a `PAYMENT` ledger entry (idempotent on the provider event), then the wallet buys/renews the plan. Provider-billed subscriptions get a 3-day grace before `PAST_DUE`
- [ ] Paystack plan renewals still aren't matched to an organization (no metadata on renewal `charge.success`), so they don't credit the wallet yet
- [ ] Changing plan while a provider subscription is live leaves the provider charging its old amount; the difference accumulates in (or drains) the wallet. Consider cancelling/re-creating the provider subscription on plan change

## Beyond healthcare: templates, online booking, wording (2026-10-20)

- [x] Flow templates for every industry (restaurant, salon, bank, government office, shop/service centre, school office, single counter) beside the outpatient clinic; `services/flowTemplates.data.ts`
- [x] Flow designer "Start from a template": industry filter (the organisation's own first) and a left-to-right preview of the steps, who can book, and what waits for payment, before applying (`components/flow/FlowTemplatePicker.tsx`)
- [x] Per-service booking mode (`Service.bookingMode`: WALK_IN, APPOINTMENT, BOTH), set in the add-service wizard and the edit form; templates carry sensible defaults
- [x] Public join page: "Join the line now" / "Book a time" when a location offers both; kiosks only issue tickets; appointment-only services refuse walk-in joins (`APPOINTMENT_ONLY`)
- [x] Online booking without an account: day and time picker, name + phone/email, confirmation email, private manage link `/booking/<token>` to change, cancel and check in on arrival (booked-arrival ordering applies); `publicBooking.controller.ts`, shared rules in `booking.service.ts`
- [x] Staff Appointments page marks "Booked online"; reminders already cover online bookings
- [x] Customer-facing wording made neutral: settings, placeholders, privacy and terms, landing page, service point type labels
- [ ] Online booking has no OTP/verification (open booking, rate limited); consider code verification per location if abuse appears
- [ ] No SMS/WhatsApp confirmation at booking time (email only; the daily reminder covers both)
- [ ] Booking page times use the visitor's calendar day; the location's timezone is used for display only
- [ ] Landing page demo screens (lobby scene) are still clinic-themed
- [ ] Connect/EMR API field names (`patient`) stay as the integration contract

## Neutral integrations and table/seat/payment review (2026-10-20)

- [x] Integration wording is system-neutral (CRM, point-of-sale, reservations, records system, EMR): connections panel, plan feature labels, settings, desk card, server messages, README and Connect docs. API field names (`patient`, `encounter`) stay for compatibility and are explained in the docs
- [x] Review written: `specs/2026-10-20-table-seat-booking-and-payments-review.md`
- [x] Party size / seats: `Service.bookingUnit` PERSON, slot capacity counted in people, party stepper on the booking page, staff can book any size
- [x] One-off sessions (events, tickets, classes) with name, seats and price; `Service.recurringSlots` off = sessions only
- [x] Customers pay when booking (deposit / full / at venue): price per booking or person, 10-minute hold (`PENDING_PAYMENT`), Stripe + Paystack hosted checkout, webhook confirmation (idempotent, forged ids ignored, late payment revives or is refunded), cron expiry, refunds by cutoff (staff cancel = full)
- [x] Two ways to get paid: the organization's own keys (paid plans, feature `ownPaymentKeys`) or collected by the platform into a per-organization payout wallet (hold days, fee %, minimum payout; request, review, mark paid / reject). Pages: Payments (org), Payouts (superadmin)
- [x] Connect: `partySize` and `payment` on `PUT /appointments`, appointment responses and `appointment.*` events (additive within v1); public-page bookings announce `appointment.created` once confirmed/paid
- [x] Booking payments: provider code tested for real signatures (Stripe's own library signs and verifies; Paystack HMAC), exact request bodies, and the whole paid-booking lifecycle against a real Postgres. Still to do by hand: one test-mode payment with live keys
- [x] An abandoned checkout can be resumed from the booking page while the hold lasts ("Continue to payment"), and a booking awaiting payment can be cancelled
- [ ] Payout wallet is one currency per organization; changing it is blocked once there is activity
- [x] Paystack payments require a real email (checked on the server and in the form)
- [ ] Table assignment (named tables) and per-service refund tiers

## Currencies (2026-10-22)

- [x] Organization currency (`Organization.currency`, was `bookingCurrency`): chosen at sign-up (time-zone guess preselected) and on the Welcome setup; used for plan prices, wallet, add-ons and booking payments
- [x] Superadmin **Currencies** page: supported list with rates against the base (USD); in-use currencies can't be removed; warns about in-use currencies without a rate
- [x] Plans priced by currency: hand-set `PlanCurrencyPrice` per currency, otherwise converted at the platform rate; checkout, wallet settlement, `/plans` and add-on pricing use the organization's currency
- [x] Changing an organization's currency is blocked once wallet/payout activity or a card subscription exists
- [x] "Refresh from market rates" on the Currencies page (open.er-api.com, checked live); manual edits still work
- [x] Superadmin can change an organization's currency from its page once the wallet and payout wallet are at zero, no payout is open, no booking awaits payment and no card subscription runs
- [x] Dashboard revenue is converted to the base currency (and counts quarterly plans)
- [x] Existing organizations take their plan's currency in the migration, so running subscriptions stay in the currency they bill in

## Rooms, tables, seat maps (2026-10-23)

- [x] Rooms within locations (`Room`): own rules (online-bookable or staff-only, party limits, hours/days, combining tables) and rates (inherit / surcharge / override, per booking or person, own payment and refund terms). Services and desks (service point instances) can sit in a room
- [x] Named tables/seats (`DiningTable`) in rooms; a booking holds one or more (`BookingTable`); auto-assignment picks the smallest free fit, combines the nearest tables for big parties, respects room rules; concurrency-safe (advisory lock), verified with two simultaneous bookings on a real database
- [x] Visual floor-plan designer: drag tables on a canvas, shape/size/rotation/seats, row generator, snap to grid, keyboard nudging, background picture of the real room (uploaded to the platform's file storage)
- [x] Seat map for customers (tap tables/seats, or be assigned), staff "Change table" on Appointments, and a host "Tonight" view per room
- [x] Industry gating (`industryFeatures`): rooms for every industry, tables and floor plans only for restaurants, salons, education and "other"; UI hides them and the API refuses them elsewhere
- [x] Refund tiers by notice (service and room level) replace the single cutoff when set; the manage page shows what would come back now
- [x] Daily automatic exchange-rate refresh (optional, Currencies page; daily cron)
- [x] Staff moving a booking into a room with another rate reprice it: the host confirms the new price first (409 with the figures), a dearer room leaves a balance to settle at the venue, a cheaper one refunds the difference (retry-safe if the refund fails); prices reported by a connected system are never touched
- [x] Designer: resize handles (work on turned tables), rotate handle, drag-box and Shift-click multi-select, group move, align/space evenly, undo/redo, zoom, Ctrl+A/D, clicked through in a browser
- [x] Templates lay out rooms and floor plans (restaurant, salon, new "Class, workshop or event" hall) with a preview in the picker; tables are skipped for industries without them; applying again changes nothing
- [x] Connect: `GET /rooms`, `GET /rooms/{room}/availability`, and `tables` / `room` on `PUT /appointments` (auto or named tables, 409 `TABLE_UNAVAILABLE`, 422 `TABLES_NOT_AVAILABLE`); verified on a real database including two simultaneous requests for one table
- [x] Fixed an import cycle (booking.service / tables.service) that would crash when booking.service loaded first: `BookingError` now lives in `bookingError.ts`
- [x] Fixed invalid YAML in `openapi.yaml` (a test now parses it and checks every `$ref`)
- [ ] Not exercised: live Stripe/Paystack test-mode payments (no keys here); picture upload needs a configured file-storage provider
- [ ] Moving a booking between rooms in Klargy's UI with a priced booking was covered by tests and a real database, not clicked in a browser
