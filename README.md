# RouteMind

**Enterprise AI Gateway for intelligent LLM routing, cost control, resilience, and observability.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Prisma-4169e1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-cache%20%2B%20rate%20limits-dc382d?logo=redis&logoColor=white)](https://redis.io/)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
[![npm SDK](https://img.shields.io/npm/v/@routemind/sdk?label=%40routemind%2Fsdk&logo=npm)](https://www.npmjs.com/package/@routemind/sdk)
[![npm CLI](https://img.shields.io/npm/v/@routemind/cli?label=%40routemind%2Fcli&logo=npm)](https://www.npmjs.com/package/@routemind/cli)

[Live Dashboard](https://router-mind-frlqw1ilb-rushikeshneves-projects.vercel.app) |
[Backend API](https://routermind.onrender.com) |
[GitHub](https://github.com/RushikeshNeve/RouterMind) |
[npm SDK](https://www.npmjs.com/package/@routemind/sdk) |
[npm CLI](https://www.npmjs.com/package/@routemind/cli)

RouteMind is an OpenAI-compatible AI Gateway that sits between applications and LLM providers. Instead of hard-coding one model or provider into every product, teams can route requests through RouteMind and let the gateway choose the right execution path based on cost, latency, model capability, provider health, user model access, budget and quota policies, routing strategy, and prompt complexity.

It is built as a production-oriented TypeScript monorepo with a Fastify gateway, PostgreSQL persistence, Redis-backed coordination, provider adapters, a Next.js operator dashboard, a public SDK, and a developer CLI.

## Why RouteMind

Modern AI applications quickly outgrow a single provider integration. RouteMind gives teams one gateway for:

- **Model selection:** route simple, complex, code, summarization, and reasoning prompts to the best available model.
- **Cost control:** apply budget guardrails, quota checks, cost-tier preferences, and request-level spend limits.
- **Provider failover:** retry transient failures, skip unhealthy models, and fall back across OpenAI, Gemini, Anthropic, and Groq.
- **Usage visibility:** inspect spend, latency, errors, model distribution, provider health, cache savings, and firewall events.
- **OpenAI-compatible API:** point existing OpenAI SDK clients at RouteMind with a `baseURL` change.
- **SDK and CLI developer experience:** integrate from TypeScript apps or operate the gateway from the terminal.

## Features

### AI Gateway

- OpenAI-compatible `/v1/chat/completions` and `/v1/models` endpoints.
- API key authentication with `Authorization: Bearer ...` or `x-api-key`.
- Workspace-aware request logging and analytics.
- Mock and live provider modes for local development and production use.

### Intelligent Routing

- `model: "auto"` routing across provider/model candidates.
- Rule-based, score-based, and LLM-assisted routing modes.
- Strategy support for balanced, cost-aware, latency-aware, and quality-first routing.
- Prompt complexity, task type, model capability, model access, and provider health signals.
- Execution planning metadata for single-model and quality-first flows.

### Cost Guardrails

- Estimated request cost before provider execution.
- Budget and quota enforcement.
- Max cost tier and max estimated cost controls.
- Spend analytics by day, model, provider, and request.

### Resilience

- Provider retry policy for transient failures.
- Fallback across healthy candidates.
- Circuit breakers per provider/model.
- Provider health snapshots with success rate, p95 latency, timeout rate, and sample size.

### Security / Prompt Firewall

- Prompt inspection before cache lookup, routing, budget checks, and provider execution.
- Built-in detection for secrets, PII-like data, prompt injection, dangerous commands, and oversized prompts.
- `block`, `warn`, and `redact` actions.
- Firewall events and custom policy rule APIs.

### Analytics and Observability

- Summary, model, provider, error, cost, latency, and request analytics APIs.
- Cache hit rate and estimated cost-saved metrics.
- Resilience and provider-attempt logs.
- Vendor-neutral observability package hooks.

### SDK and CLI

- `@routemind/sdk` TypeScript client with chat completions, streaming, health, analytics, resilience, onboarding helpers, retry handling, and typed errors.
- `@routemind/cli` for chat, health, analytics, models, costs, circuit breakers, JSON output, and local config.

### Dashboard

- Next.js dashboard for operators and reviewers.
- Pages for overview, analytics, requests, models, providers, costs, resilience, and evaluations.
- Demo-data fallback banner when the API is unavailable.

## Architecture

```text
Client Apps
OpenAI SDK
RouteMind SDK
RouteMind CLI
     |
     v
RouteMind API
     |
     v
Auth / Validation / Rate Limiting
     |
     v
Prompt Firewall
     |
     v
Cache
     |
     v
Routing Engine
     |
     v
Budget Guardrails
     |
     v
Resilience Layer
     |
     v
Provider Adapters
     |
     v
OpenAI / Gemini / Anthropic / Groq
     |
     v
PostgreSQL / Redis / Dashboard
```

## Live URLs

| Service      | URL                                                                |
| ------------ | ------------------------------------------------------------------ |
| Dashboard    | <https://router-mind-frlqw1ilb-rushikeshneves-projects.vercel.app> |
| Backend      | <https://routermind.onrender.com>                                  |
| Health check | <https://routermind.onrender.com/health>                           |
| Models       | <https://routermind.onrender.com/v1/models>                        |

## Quick Start

```bash
git clone https://github.com/RushikeshNeve/RouterMind.git
cd RouterMind
npm install
cp .env.example .env
docker compose up -d
npm run db:migrate
npm run seed:dev
npm run dev -w @routemind/api
```

Run the dashboard in another terminal:

```bash
npm run dev -w @routemind/dashboard
```

Local defaults:

- API: `http://localhost:3000`
- Dashboard: `http://localhost:3002/dashboard`
- Provider mode: `mock`

## Environment Variables

Backend:

```env
DATABASE_URL=postgresql://routemind:routemind@localhost:5432/routemind?schema=public
REDIS_URL=redis://localhost:6379
CREDENTIAL_ENCRYPTION_KEY=replace-with-a-strong-secret
PROVIDER_MODE=mock
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
ROUTER_LLM_ENABLED=true
ROUTER_LLM_MODEL=gpt-4o-mini
LOG_LEVEL=info
```

Dashboard:

```env
NEXT_PUBLIC_ROUTEMIND_API_URL=https://routermind.onrender.com
```

See [.env.example](./.env.example) and [.env.production.example](./.env.production.example) for the full local and production configuration surface.

## How to Use

The examples below use the hosted backend. Replace IDs returned by earlier calls before running the next command.

Create a user:

```bash
curl -X POST https://routermind.onrender.com/v1/users \
  -H "content-type: application/json" \
  -d '{
    "name": "Local Developer",
    "email": "dev@example.com"
  }'
```

Create a RouteMind API key:

```bash
curl -X POST https://routermind.onrender.com/v1/api-keys \
  -H "content-type: application/json" \
  -d '{
    "userId": "user_id_from_previous_step",
    "name": "Production App"
  }'
```

Add provider credentials:

```bash
curl -X POST https://routermind.onrender.com/v1/provider-credentials \
  -H "content-type: application/json" \
  -d '{
    "userId": "user_id",
    "provider": "openai",
    "apiKey": "sk-..."
  }'
```

Enable a model:

```bash
curl -X POST https://routermind.onrender.com/v1/model-access \
  -H "content-type: application/json" \
  -d '{
    "userId": "user_id",
    "provider": "openai",
    "model": "gpt-4o-mini",
    "isEnabled": true
  }'
```

Call chat completions:

```bash
curl -X POST https://routermind.onrender.com/v1/chat/completions \
  -H "content-type: application/json" \
  -H "Authorization: Bearer rm_live_your_key" \
  -d '{
    "model": "auto",
    "messages": [
      { "role": "user", "content": "Explain microservices in practical terms." }
    ],
    "routing": {
      "mode": "llm_assisted",
      "strategy": "balanced"
    },
    "cache": {
      "mode": "exact"
    }
  }'
```

## OpenAI SDK Compatibility

RouteMind works as an OpenAI-compatible base URL for existing applications.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.ROUTEMIND_API_KEY,
  baseURL: "https://routermind.onrender.com/v1",
});

await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Explain microservices" }],
});
```

## RouteMind SDK Usage

```bash
npm install @routemind/sdk
```

```ts
import { RouteMind } from "@routemind/sdk";

const client = new RouteMind({
  apiKey: process.env.ROUTEMIND_API_KEY,
  baseUrl: "https://routermind.onrender.com",
  timeoutMs: 30_000,
  maxRetries: 2,
});

const response = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Explain Kubernetes for a backend engineer." }],
  routing: {
    mode: "llm_assisted",
    strategy: "balanced",
    executionPlan: "auto",
  },
  cache: {
    mode: "exact",
    ttlSeconds: 3600,
  },
});

console.log(response.choices[0]?.message.content);
console.log(response.routemind ?? response.routingMetadata);
```

More examples are available in [packages/sdk/README.md](./packages/sdk/README.md).

## CLI Usage

```bash
npm install -g @routemind/cli
routemind --help
routemind --base-url https://routermind.onrender.com login
routemind chat "Explain Kubernetes"
```

Useful commands:

```bash
routemind config
routemind --api-key YOUR_KEY --base-url https://routermind.onrender.com health
routemind health
routemind analytics
routemind models
routemind costs
routemind circuit-breakers
routemind --json analytics
```

More examples are available in [packages/cli/README.md](./packages/cli/README.md).

## API Reference

| Method | Endpoint                   | Purpose                                                                |
| ------ | -------------------------- | ---------------------------------------------------------------------- |
| `GET`  | `/health`                  | Liveness check                                                         |
| `GET`  | `/ready`                   | Readiness check for runtime dependencies                               |
| `GET`  | `/v1/models`               | List public or authenticated model access                              |
| `POST` | `/v1/chat/completions`     | OpenAI-compatible chat completions                                     |
| `POST` | `/v1/users`                | Create a user                                                          |
| `POST` | `/v1/api-keys`             | Create a RouteMind API key                                             |
| `POST` | `/v1/provider-credentials` | Store encrypted provider credentials                                   |
| `POST` | `/v1/model-access`         | Enable or disable model access                                         |
| `GET`  | `/v1/health/providers`     | Provider and model health                                              |
| `GET`  | `/v1/analytics/summary`    | Usage, spend, latency, routing, guardrail, cache, and firewall summary |
| `GET`  | `/v1/cache/stats`          | Cache hit, miss, and savings stats                                     |
| `GET`  | `/v1/firewall/events`      | Prompt firewall event log                                              |

Additional implemented routes include analytics breakdowns, cache entries, firewall rules, workspaces, evaluations, resilience circuit breakers, and provider attempts.

## Example Request and Response

Request:

```json
{
  "model": "auto",
  "messages": [
    {
      "role": "system",
      "content": "You are a concise architecture assistant."
    },
    {
      "role": "user",
      "content": "Compare microservices and modular monoliths for a payments platform."
    }
  ],
  "temperature": 0.4,
  "routing": {
    "mode": "llm_assisted",
    "strategy": "balanced",
    "executionPlan": "auto",
    "maxCostTier": "medium"
  },
  "cache": {
    "mode": "exact",
    "ttlSeconds": 3600
  }
}
```

Response:

```json
{
  "id": "chatcmpl_01JZ9R7Y5C8V4Z2T8Q3QF6M2A1",
  "object": "chat.completion",
  "created": 1783420000,
  "model": "gpt-4o-mini",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "For a payments platform, start with a modular monolith when domain boundaries are still evolving..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 42,
    "completion_tokens": 286,
    "total_tokens": 328
  },
  "routemind": {
    "routing": {
      "mode": "llm_assisted",
      "strategy": "balanced",
      "requestedModel": "auto",
      "selectedProvider": "openai",
      "selectedModel": "gpt-4o-mini",
      "reason": "Balanced cost and quality for an architecture comparison prompt."
    },
    "cache": {
      "hit": false,
      "mode": "exact"
    },
    "resilience": {
      "fallbackUsed": false,
      "circuitBreakerTriggered": false,
      "attempts": [
        {
          "provider": "openai",
          "model": "gpt-4o-mini",
          "attemptNumber": 1,
          "status": "success",
          "latencyMs": 1284
        }
      ]
    },
    "costGuardrails": {
      "allowed": true,
      "estimatedCostUsd": 0.00071,
      "actualCostUsd": 0.00069
    },
    "executionPlan": {
      "planType": "single_model",
      "executed": true,
      "confidence": 0.88
    },
    "firewall": {
      "inspected": true,
      "action": "allow",
      "events": []
    }
  }
}
```

## Dashboard Screenshots

Screenshot placeholders:

- Overview dashboard: `docs/assets/dashboard-overview.png`
- Analytics dashboard: `docs/assets/dashboard-analytics.png`
- Provider health: `docs/assets/dashboard-providers.png`

No fake screenshots are included. Add real captures after the dashboard views are finalized.

## Deployment

RouteMind is designed for a split production deployment:

- Backend API deployed on Render.
- Dashboard deployed on Vercel.
- PostgreSQL and Redis are required.
- `NEXT_PUBLIC_ROUTEMIND_API_URL` must point to the backend URL.
- Run Prisma migrations before serving production traffic.
- Use a strong `CREDENTIAL_ENCRYPTION_KEY` for provider credential encryption.
- Restrict `CORS_ORIGIN` to trusted dashboard and application origins.

Production Docker is available through [docker-compose.prod.yml](./docker-compose.prod.yml). More deployment notes live in [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

## Resume

**RouteMind - Enterprise AI Gateway**

- Built a production-oriented AI gateway using Node.js, TypeScript, Fastify, PostgreSQL, Redis, Prisma, Docker, Next.js, and npm workspaces.
- Implemented an OpenAI-compatible API with intelligent LLM routing, provider adapters, user-specific model access, cost guardrails, quota checks, retries, fallback, and circuit breakers.
- Added prompt firewalling, exact response caching, provider health tracking, analytics APIs, dashboard views, a TypeScript SDK, and a developer CLI.
- Designed the system for provider portability across OpenAI, Gemini, Anthropic, and Groq with mock/live modes for reliable local development.

## Roadmap

- Vector-backed semantic cache.
- Langfuse and OpenTelemetry integration.
- Workspace management UI.
- Provider marketplace.
- Hosted control plane.
- Billing support.

## Workspace Layout

```text
apps/
  api/          Fastify API gateway
  dashboard/    Next.js operator dashboard
packages/
  auth/         Authentication contracts
  analytics/    Analytics contracts
  cli/          Public developer CLI
  core/         Domain contracts
  cost-engine/  Pricing and cost estimation
  observability/Telemetry contracts
  policy-engine/Prompt and policy evaluation
  providers/    Provider adapters and model registry
  routing/      Routing strategies
  sdk/          Public TypeScript SDK
  shared/       Shared schemas and utilities
docs/           Architecture, deployment, and engineering docs
docker/         Container build files
```

## Documentation

- [Architecture](./Architecture.md)
- [Deployment](./docs/DEPLOYMENT.md)
- [Roadmap](./Roadmap.md)
- [Contributing](./Contributing.md)
- [System Design](./docs/system-design/README.md)
- [Folder Responsibilities](./docs/folder-responsibilities.md)
- [Coding Standards](./docs/coding-standards.md)
- [Future Milestones](./docs/future-milestones.md)
- [SDK README](./packages/sdk/README.md)
- [CLI README](./packages/cli/README.md)

## Author

**Rushikesh Neve**

- GitHub: <https://github.com/RushikeshNeve>
- LinkedIn: <https://www.linkedin.com/in/rushikesh-neve-a96744212/>

## License

MIT
