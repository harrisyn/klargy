# Deployment

The web app and the API are one Next.js project in `frontend/`. The API is the
Express app in `frontend/src/server`, served from a single route,
`frontend/src/pages/api/v1/[...path].ts`. There is no separate backend to deploy.

## What you need

| Piece | Recommended | Why |
|---|---|---|
| App hosting | Vercel | Native Next.js; Node runtime for Prisma, email, bcrypt |
| Postgres | Neon or Supabase | Serverless-friendly pooled connections |
| Real-time | Pusher Channels (or Ably's Pusher adapter) | Serverless can't hold WebSockets; these do it for us |
| Email | Any SMTP relay (Resend, Postmark, SES) | Uses the existing SMTP settings |
| SMS (optional) | Twilio | `TWILIO_*` env vars |
| AI (optional) | Any of Anthropic, OpenAI, Gemini, or an OpenAI-compatible endpoint | AI-assisted analytics |

Nothing else is required: rate limits and one-time codes are stored in
Postgres, and background jobs run on Vercel Cron.

## Vercel, step by step

1. **Import the repo** into Vercel and set **Root Directory** to `frontend`.
   `vercel.json` sets the build command to `npm run vercel-build`, which runs
   `prisma generate`, `prisma migrate deploy`, and then `next build`.
2. **Create the database.** On Neon, use the pooled connection string (host
   contains `-pooler`) as `DATABASE_URL`.
3. **Set environment variables.** Every variable is described in
   `frontend/.env.example`. At minimum set:
   `DATABASE_URL`, `JWT_SECRET`, `MASTER_ENCRYPTION_KEY`, `CRON_SECRET`,
   `APP_URL`, `APP_DOMAIN`, `APP_NAME`, the SMTP settings, and the
   `REALTIME_*` / `REALTIME_PUBLIC_*` values.
   - Moving an existing database? Keep the **same** `MASTER_ENCRYPTION_KEY`,
     or saved payment keys, integration credentials and webhook secrets become
     unreadable.
4. **Add domains.** Add the root domain and a **wildcard** `*.yourapp.com` to
   the project. Vercel only issues wildcard certificates when the domain uses
   Vercel's nameservers, so point the domain's NS records at Vercel.
5. **Custom tenant domains (optional).** Create a Vercel access token and set
   `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` (and `VERCEL_TEAM_ID` for team
   projects). When a tenant adds a domain in Settings → Domain, it is attached
   to the project automatically. Tenants point a CNAME at
   `cname.vercel-dns.com`; "Verify" then asks Vercel whether DNS and the
   certificate are ready.
6. **Cron.** `vercel.json` schedules `/api/v1/cron/frequent` every 5 minutes
   (webhook retries and cleanup) and `/api/v1/cron/daily` (appointment
   reminders and AI digests). Vercel sends `Authorization: Bearer $CRON_SECRET`
   automatically. Sub-daily schedules need a Pro plan; on Hobby, change
   `frequent` to once a day.
7. **Create the first superadmin.** From `frontend/`, with `DATABASE_URL`
   pointing at production:
   `NODE_ENV=production ADMIN_EMAIL=you@yourapp.com ADMIN_PASSWORD='…' node scripts/create-superadmin.js`,
   then sign in at `admin.yourapp.com/login`.

## AI-assisted analytics

The AI layer is provider-agnostic (`frontend/src/server/services/ai`):

1. As superadmin, open **AI Providers**, enter a key (and model / base URL
   where needed), switch it on, and use **Test connection**. Only one
   provider is active at a time. Anthropic defaults to `claude-opus-5`, with
   automatic server-side fallback if a request is declined. Alternatively set
   `AI_PROVIDER` + the matching key env var (see `.env.example`).
2. Turn on **AI-assisted Analytics** in the plans that should include it
   (Superadmin → Subscription Plans), and give those plans AI credits.
3. Each tenant org admin switches AI on from the Analytics page.

Each question uses one AI credit; the daily digest uses one per org per day.
The model only receives aggregated statistics (counts, wait and service
times, service/location names), never patient details. Wait-time forecasts
and wait-spike alerts are statistical and work without any provider.

## Self-hosting (Docker)

`frontend/Dockerfile` builds a standalone image that applies migrations on
start and serves the app on port 3000:

```bash
docker build -t queue-app frontend
docker run -p 3000:3000 --env-file .env queue-app
```

Nothing is compiled into the image: app name, domain and real-time settings are
all read from the environment at runtime, so one image works anywhere (CI
publishes it to Docker Hub; see `docker-compose.prod.yml`). For real-time,
either use Pusher/Ably or run [Soketi](https://soketi.app) next to the app, as
`docker-compose.yml` does. Put a TLS-terminating proxy that supports wildcard
and on-demand certificates (Caddy works well) in front for tenant subdomains
and custom domains. Schedule the two cron URLs with any scheduler.

## Local development

```bash
docker compose up        # app on :8003, Soketi on :6001, Mailpit UI on :9025
```

Postgres runs on the host by default (`DATABASE_URL` in the repo-root `.env`).
Tenant subdomains work on `*.localhost`, for example `http://nyaho.localhost:8003`.

For a self-contained stack, run Postgres in Docker as well:

```bash
# in .env: DATABASE_URL=postgresql://postgres:postgres@db:5432/qms_db
docker compose --profile localdb up -d
docker compose exec app npx prisma migrate deploy
docker compose exec app node scripts/create-superadmin.js   # first platform admin
```

The database is also reachable from the host on port 5433.

Settings for `docker compose` go in the repo-root `.env` (see `.env.example`;
every value has a development default). Without Docker (`cd frontend && npm run dev`,
on :3000), use `frontend/.env`: set `APP_URL=http://localhost:3000` and
`APP_DOMAIN=localhost:3000`, or leave `APP_URL` empty and links follow the
address the app is opened on. `MASTER_ENCRYPTION_KEY` may stay empty in
development (the same development-only default as Docker). In production
both are required, and the app refuses to start without `APP_URL`.

An EMR running in its own containers reaches the API at
`http://host.docker.internal:8003` but opens the desk and status pages on the
workspace host (`<slug>.localhost:8003`); see "Running both on one machine" in
[docs/connect/guide.md](connect/guide.md#10-testing-in-the-sandbox).

The desk widget can be tried outside the app with `/widget/desk`, or embedded
in any page with `<script src="http://<slug>.localhost:8003/embed/desk.js" async></script>`.

## Checks

```bash
cd frontend
npm run typecheck && npm test && npm run build
# against the running docker-compose stack:
docker cp ../tests/tenant-isolation-smoke.js qms-app:/app/ && docker exec qms-app node /app/tenant-isolation-smoke.js
docker cp ../tests/queue-flow-smoke.js qms-app:/app/ && docker exec qms-app node /app/queue-flow-smoke.js
docker cp ../tests/realtime-smoke.js qms-app:/app/ && docker exec qms-app node /app/realtime-smoke.js
```
