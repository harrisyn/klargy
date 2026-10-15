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
packages/connect/     @klargy/connect: TypeScript SDK for Klargy Connect (standalone package)
docs/                 Deployment guide, Klargy Connect docs, work tracker, design specs
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
npm run sandbox:create -- --name "Acme EMR sandbox"   # Klargy Connect sandbox workspace
```

## Integrating an EMR

Other systems integrate through **Klargy Connect**, an API addressed by the
EMR's own ids. It covers tickets that follow the EMR's visits, signed
webhooks, the staff desk framed in the EMR, patient lookup and journey
automation.

- [docs/connect/guide.md](docs/connect/guide.md): step-by-step integration guide for a new EMR, including the sandbox
- [docs/connect/v1.md](docs/connect/v1.md): the contract; [docs/connect/openapi.yaml](docs/connect/openapi.yaml): the same as OpenAPI 3.1
- SDKs: [`@klargy/connect`](packages/connect) (TypeScript: client, webhook and lookup verification, desk embed) and [`klargy-connect`](sdks/python/klargy-connect) (Python)

## Docs

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Vercel and Docker deployment, environment variables
- [docs/connect/guide.md](docs/connect/guide.md): integrating an EMR (Klargy Connect)
- [docs/superpowers/tracker.md](docs/superpowers/tracker.md): live checklist of done / open work
- [TECHNICAL_PRD.md](TECHNICAL_PRD.md): product requirements
- [docs/superpowers/specs/](docs/superpowers/specs/): design specs per feature
