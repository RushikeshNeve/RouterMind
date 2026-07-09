# RouteMind Deployment Guide

This guide covers local Docker, production Docker Compose, and common hosted deployment paths.

## Local Docker

```bash
cp .env.example .env
docker compose up --build
npm run db:migrate
npm run seed:dev
```

API health:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

Dashboard:

```bash
open http://localhost:3002/dashboard
```

## Production Docker Compose

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.prod.yml up --build -d
```

The API container runs Prisma migrations on startup with:

```bash
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

For stricter release workflows, run migrations as a separate job before starting the API.

## Required Environment Variables

- `DATABASE_URL`: PostgreSQL connection string.
- `REDIS_URL`: Redis connection string for rate limiting and production dependencies.
- `CREDENTIAL_ENCRYPTION_KEY`: Random secret used for provider credential encryption.
- `DEV_API_KEY`: Bootstrap API key. Replace this after provisioning workspace API keys.
- `ROUTEMIND_API_URL`: Public API origin.
- `NEXT_PUBLIC_ROUTEMIND_API_URL`: Dashboard-to-API URL.
- `PROVIDER_MODE`: `mock` for demos, `live` for real provider calls.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`: Provider keys.
- `CORS_ORIGIN`: Comma-separated allowed dashboard origins.
- `REQUEST_BODY_LIMIT_BYTES`: Fastify request body limit.
- `RATE_LIMIT_MAX_REQUESTS`: Requests per rate limit window.
- `RATE_LIMIT_WINDOW_SECONDS`: Rate limit window size.

## Render

1. Create a PostgreSQL service and a Redis service.
2. Create a Web Service for the API using `apps/api/Dockerfile`.
3. Set production environment variables from `.env.production.example`.
4. Set the API health check path to `/ready`.
5. Create a second Web Service for the dashboard using `apps/dashboard/Dockerfile`.
6. Set `NEXT_PUBLIC_ROUTEMIND_API_URL` to the API service URL.

## Railway

1. Provision PostgreSQL and Redis plugins.
2. Deploy the API with `apps/api/Dockerfile`.
3. Configure `DATABASE_URL`, `REDIS_URL`, and provider keys.
4. Deploy the dashboard with `apps/dashboard/Dockerfile`.
5. Point `NEXT_PUBLIC_ROUTEMIND_API_URL` at the API domain.

## Vercel Dashboard Deployment

The dashboard is a standard Next.js app and can be deployed independently:

```bash
vercel --cwd apps/dashboard
```

Set:

```env
NEXT_PUBLIC_ROUTEMIND_API_URL=https://your-api.example.com
```

Keep the Fastify API on a Node host such as Render, Railway, Fly.io, or a Kubernetes deployment.

## Migrations

For local development:

```bash
npm run db:migrate
```

For production:

```bash
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

Run migrations before starting new API replicas.

## Observability

RouteMind currently includes vendor-neutral interfaces for traces, spans, metrics, and structured logs. The default tracer is no-op. The integration point is ready for:

- OpenTelemetry Collector
- Grafana Tempo
- Datadog
- Langfuse

Structured logs include request id, workspace id, provider, model, latency, status, and error code where available. API keys and authorization headers are redacted.

## Troubleshooting

- `/health` returns 200 but `/ready` returns 503: verify `DATABASE_URL`, `REDIS_URL`, and provider registry configuration.
- API exits on startup in production: replace development `DEV_API_KEY` and `CREDENTIAL_ENCRYPTION_KEY`.
- Dashboard cannot reach API: verify `NEXT_PUBLIC_ROUTEMIND_API_URL` and `CORS_ORIGIN`.
- Live providers fail: verify provider keys and `PROVIDER_MODE=live`.
- Prisma client errors after schema changes: run `npm run prisma:generate`.
