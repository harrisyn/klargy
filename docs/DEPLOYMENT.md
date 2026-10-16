# Deployment

The web app and the API are one Next.js project in `frontend/`. The API is the
Express app in `frontend/src/server`, served from a single route,
`frontend/src/pages/api/v1/[...path].ts`. There is no separate backend to deploy.

## URLs

Everything hangs off one root domain (`APP_DOMAIN`). Production examples use
`yourapp.com`; local Docker uses `localhost:8003`.

| What | Production | Local (Docker) |
|---|---|---|
| Marketing site, org sign-up (`/register`) | `https://yourapp.com` | `http://localhost:8003` |
| **Superadmin** panel | `https://admin.yourapp.com` | `http://admin.localhost:8003` |
| First-run setup (only until a superadmin exists) | `https://yourapp.com/setup` | `http://localhost:8003/setup` |
| Superadmin login | `https://admin.yourapp.com/login` | `http://admin.localhost:8003/login` |
| A tenant workspace | `https://<slug>.yourapp.com` | `http://<slug>.localhost:8003` |
| Tenant staff login | `https://<slug>.yourapp.com/login` | `http://<slug>.localhost:8003/login` |
| Public join / status / display pages | on the tenant host (`/join/...`, `/status/...`, `/display/...`) | same |
| A tenant's custom domain (optional) | `https://queue.clinic.com` | n/a |
| API | `<any host above>/api/v1` | same |
| Cron endpoints | `/api/v1/cron/frequent`, `/api/v1/cron/daily` (Bearer `CRON_SECRET`) | n/a |
| Mailpit (caught email) | n/a | `http://localhost:9025` |

The root domain redirects `/superadmin` to the admin host. DNS needs the root
domain and a wildcard record (`*.yourapp.com`) pointing at the app.

Superadmin pages (all under `admin.<domain>`): Organizations, Subscription
Plans, Add-on Pricing, Payment Providers, SMS Providers, AI Providers and
File Storage.

## Environment variables

There is **one** template: [`.env.example`](../.env.example) at the repo root.
It documents every variable and marks which are required in production.

| You run | Copy the template to | Read by |
|---|---|---|
| `docker compose up` (dev) | `.env` (repo root) | `docker-compose.yml`, which has a development default for almost everything |
| `docker compose -f docker-compose.prod.yml up -d` | `.env` (repo root) | the whole file is passed to the container |
| `cd frontend && npm run dev` | `frontend/.env` | Next.js (port 3000: `APP_URL=http://localhost:3000`, `APP_DOMAIN=localhost:3000`) |
| Vercel | Project Settings → Environment Variables | n/a |

Both `.env` files are git-ignored. Generate each secret with
`openssl rand -hex 32`.

Required in production:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (pooled URL on Neon/Supabase) |
| `JWT_SECRET` | Signs login tokens (the app refuses a short/default value) |
| `MASTER_ENCRYPTION_KEY` | Encrypts stored payment keys, integration credentials, webhook secrets. **Never change it** once data exists |
| `CRON_SECRET` | Bearer token for `/api/v1/cron/*` |
| `APP_URL`, `APP_DOMAIN` | Public root URL and the same host without the scheme. Tenant and admin URLs derive from them |
| `SMTP_HOST` (+ `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) | Outgoing email: OTP codes, invites, notifications |
| `REALTIME_*` | Live queue updates (Pusher/Ably/Soketi). Empty falls back to polling on Vercel; `docker-compose.prod.yml` requires them |

Optional: `APP_NAME` (branding, default `Klargy`), `LEGAL_CONTACT_EMAIL`,
Twilio SMS, AI keys, Vercel custom-domain automation. See the template.

## First-run setup and the superadmin account

A fresh database has no superadmin. Until one exists, **every page redirects
to `/setup`**, where you create it. Nothing is created from environment
variables or scripts.

1. Deploy the app against an empty database (migrations run on start).
2. Get the **setup token**, either:
   - the `SETUP_TOKEN` value you put in `.env` / Vercel, or
   - if you left it empty, the token the app generated and printed in the
     server log the first time anyone opens the site
     (`docker compose logs app`, or the Vercel function log). It is stored
     encrypted (with `MASTER_ENCRYPTION_KEY`) in the `SetupToken` table.
3. Open the site (`https://yourapp.com`, or `http://localhost:8003` locally).
   You land on `/setup`: enter the token, your name, email and a password
   (8+ characters).
4. You are sent to `admin.<domain>/login`. Sign in; the panel is at
   `admin.<domain>`.

How it is protected and stored:

- `/setup` and `POST /api/v1/public/setup` work **only while no superadmin
  exists**. Afterwards `/setup` redirects to the login page and the API
  answers 403.
- The setup token is compared in constant time and attempts are rate limited.
  It is deleted from the database when setup completes.
- The superadmin is a normal user row with role `SUPER_ADMIN`. The password is
  stored as a bcrypt hash (like every user's), never in plain text.
- Set `SETUP_TOKEN` (or deploy privately) before exposing a new install to the
  internet: whoever holds the token first becomes the superadmin.
- Forgot the password? Use "Forgot password" on the login page (needs SMTP).
  More superadmins are not created from the UI; to lose none, keep this
  account safe.

## What you need

| Piece | Recommended | Why |
|---|---|---|
| App hosting | Vercel | Native Next.js; Node runtime for Prisma, email, bcrypt |
| Postgres | Neon or Supabase | Serverless-friendly pooled connections |
| Real-time | Pusher Channels (or Ably's Pusher adapter) | Serverless can't hold WebSockets; these do it for us |
| Email | Any SMTP relay (Resend, Postmark, SES) | Uses the existing SMTP settings |
| SMS (optional) | Twilio | `TWILIO_*` env vars |
| AI (optional) | Any of Anthropic, OpenAI, Azure OpenAI, Gemini, or an OpenAI-compatible endpoint | AI-assisted analytics |

Nothing else is required: rate limits and one-time codes are stored in
Postgres, and background jobs run on Vercel Cron.

## Vercel, step by step

1. **Import the repo** into Vercel and set **Root Directory** to `frontend`.
   `vercel.json` sets the build command to `npm run vercel-build`, which runs
   `prisma generate`, `prisma migrate deploy`, and then `next build`.
2. **Create the database.** On Neon, use the pooled connection string (host
   contains `-pooler`) as `DATABASE_URL`.
3. **Set environment variables.** Every variable is described in
   `.env.example` at the repo root (see "Environment variables" above). At minimum set:
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
7. **Create the first superadmin.** Open the site; you are sent to `/setup`.
   See "First-run setup" above.

## AI-assisted analytics

The AI layer is provider-agnostic (`frontend/src/server/services/ai`):

1. As superadmin, open **AI Providers**, enter a key (and model / base URL
   where needed), switch it on, and use **Test connection**. Only one
   provider is active at a time. Anthropic defaults to `claude-opus-5`, with
   automatic server-side fallback if a request is declined. Alternatively set
   `AI_PROVIDER` + the matching key env var (see `.env.example`).
   **Test connection** checks the key and model in the form with one tiny
   request, so it works before saving.
2. Turn on **AI-assisted Analytics** in the plans that should include it
   (Superadmin → Subscription Plans), and give those plans AI credits.
3. Each tenant org admin switches AI on from the Analytics page.

**OpenAI and Azure OpenAI.** The `openai` provider uses OpenAI's Responses
API (recommended by OpenAI for tool-using agents): strict function schemas,
parallel tool calls, and `store: false` with encrypted reasoning items replayed
between steps, so reasoning models keep their context without OpenAI storing
the conversation. Pick a model from the suggestions or type any model name
(default `gpt-5-mini`). Set `OPENAI_API=chat` to use Chat Completions instead,
for example behind a proxy that lacks `/responses`. `azure_openai` takes the
resource endpoint as the base URL and the deployment name as the model, and
calls Chat Completions on Azure's v1 API (add `?api-version=...` to the
endpoint for the classic per-deployment route). `openai_compatible` stays on
plain Chat Completions with only the widely supported parameters. All three
use `max_completion_tokens`/`max_output_tokens` where OpenAI requires it, never
send `temperature`, take an optional `AI_REASONING_EFFORT`, retry 429 and 5xx
responses with backoff (honouring `Retry-After`, but not when the account is
out of quota), and time out after `AI_REQUEST_TIMEOUT_MS` (default 120 s).

Each question uses one AI credit; the daily digest uses one per org per day.
The model only receives aggregated statistics (counts, wait and service
times, service/location names), never patient details. Wait-time forecasts
and wait-spike alerts are statistical and work without any provider.

## Self-hosting (Docker)

CI ([docker-publish.yml](../.github/workflows/docker-publish.yml)) builds
`frontend/Dockerfile` and pushes `<DOCKERHUB_USERNAME>/queue-management` to
Docker Hub on every push to `main` (needs the repo secrets `DOCKERHUB_USERNAME`
and `DOCKERHUB_TOKEN`). The image applies migrations on start and serves the
app on port 3000. Nothing is compiled into it: app name, domain and real-time
settings are read from the environment at runtime, so one image works for any
domain.

```bash
cp .env.example .env     # fill in the values marked "REQUIRED in production"
echo "DOCKERHUB_USERNAME=youruser" >> .env     # optionally IMAGE_TAG=<tag>
docker compose -f docker-compose.prod.yml up -d
```

Then open your site to reach `/setup` and create the superadmin (see "First-run
setup" above; the generated token is in `docker compose -f docker-compose.prod.yml logs app`).

`docker-compose.prod.yml` runs the app (port 3000) and
[Soketi](https://soketi.app) for real-time (port 6001); Postgres and SMTP are
external. To use Pusher or Ably instead, drop the `soketi` service and point
the `REALTIME_*` variables at them.

In front of it, run a TLS-terminating reverse proxy (Caddy, nginx, Traefik, a
cloud load balancer) that:

- forwards `yourapp.com`, `*.yourapp.com` (tenants and `admin.`) and any
  tenant custom domains to port 3000, preserving the `Host` header (tenant
  resolution depends on it);
- serves a wildcard certificate (DNS challenge) or issues certificates on demand;
- exposes Soketi (6001) at the host you set as `REALTIME_PUBLIC_HOST`.

Schedule the two cron URLs with any scheduler, sending
`Authorization: Bearer $CRON_SECRET`:

```bash
# every 5 minutes
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://yourapp.com/api/v1/cron/frequent
# daily
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://yourapp.com/api/v1/cron/daily
```

Building the image yourself instead: `docker build -t queue-app frontend`, then
`docker run -p 3000:3000 --env-file .env queue-app`.

## Local development

```bash
docker compose up        # app on :8003, Soketi on :6001, Mailpit UI on :9025
```

Open http://localhost:8003: the first screen is `/setup` (the setup token is in
the `app` container log).

Postgres runs on the host by default (`DATABASE_URL` in the repo-root `.env`).
Tenant subdomains work on `*.localhost`, for example `http://nyaho.localhost:8003`.

For a self-contained stack, run Postgres in Docker as well:

```bash
# in .env: DATABASE_URL=postgresql://postgres:postgres@db:5432/qms_db
docker compose --profile localdb up -d
docker compose exec app npx prisma migrate deploy
```

The database is also reachable from the host on port 5433.

Settings for `docker compose` go in the repo-root `.env` (copy `.env.example`;
every value has a development default). Without Docker (`cd frontend && npm run dev`,
on :3000), copy the same template to `frontend/.env`: set `APP_URL=http://localhost:3000` and
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
