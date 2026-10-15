# Klargy

<img src="frontend/public/brand/klargy-logo.svg" alt="Klargy" height="48">

Klargy is multi-tenant queue and appointment management for clinics and other service
providers: walk-ins via QR/kiosk, booked appointments, multi-step patient
journeys (reception → doctor → lab → pharmacy), live display boards, patient
notifications, EMR webhooks, billing, and AI-assisted analytics.

One Next.js project (`frontend/`) contains both the web app and the API, and
deploys as a single unit (Vercel or one Docker image).

## Quick start (local)

Prerequisites: Docker, and PostgreSQL on the host (or point `DATABASE_URL` in
the repo-root `.env` at any Postgres).

```bash
docker compose up
```

| URL | What |
|---|---|
| http://localhost:8003 | Marketing site / org sign-up |
| http://&lt;slug&gt;.localhost:8003 | A tenant workspace, e.g. `nyaho.localhost:8003` |
| http://admin.localhost:8003 | Superadmin panel |
| http://localhost:9025 | Mailpit (catches all outgoing email) |

Migrations run automatically when the app container starts. To create a
superadmin: `docker exec qms-app node scripts/create-superadmin.js`.

Without Docker: `cd frontend && npm install && npm run dev` (needs a `.env`
based on `frontend/.env.example`).

## Layout

```
frontend/
  src/app/            Pages (App Router): tenant app, superadmin, public join/status/display
  src/components/     UI components (ui/ is the shared design-system layer)
  src/server/         The API: Express routes, controllers, services, Prisma access
  src/pages/api/v1/   Mounts the API at /api/v1 inside Next.js
  src/middleware.ts   Tenant resolution (subdomain / custom domain -> org)
  prisma/             Schema and migrations
tests/                End-to-end smoke scripts (run inside the app container)
docs/                 Deployment guide, work tracker, design specs
```

## Key concepts

- **Tenancy.** Each organization gets `<slug>.yourapp.com` (and optionally a
  custom domain). Every API route that takes a resource ID checks it belongs
  to the caller's organization (`src/server/middleware/tenantScope.middleware.ts`).
- **Real-time.** Pusher Channels protocol (Pusher/Ably in production, Soketi
  locally). Events carry IDs and statuses only; pages refetch what they show.
- **Queue events.** Joins, calls, completions, transfers and appointment
  changes all go through `src/server/services/queueEvents.service.ts`, which
  writes the audit log, fires EMR webhooks, maintains patient journeys, and
  sends notifications.
- **Background work.** `/api/v1/cron/frequent` (webhook retries, cleanup) and
  `/api/v1/cron/daily` (appointment reminders, AI digests), run by Vercel Cron.

## Commands (in `frontend/`)

```bash
npm run dev          # dev server
npm run typecheck    # tsc --noEmit
npm test             # unit tests (vitest)
npm run build        # production build
npm run db:migrate   # apply migrations
```

## Docs

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Vercel and Docker deployment, environment variables
- [docs/superpowers/tracker.md](docs/superpowers/tracker.md): live checklist of done / open work
- [TECHNICAL_PRD.md](TECHNICAL_PRD.md): product requirements
- [docs/superpowers/specs/](docs/superpowers/specs/): design specs per feature
