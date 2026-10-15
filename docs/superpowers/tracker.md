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
- [x] `create-superadmin.js` refuses default credentials in production
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
