# RouteMind

RouteMind is a production-grade AI Gateway foundation for routing requests across multiple LLM providers based on cost, latency, model capabilities, availability, and enterprise routing policies.

This repository is at backend MVP stage. It establishes architecture, contracts, development workflow, mock providers for local development, and live provider adapters for OpenAI, Anthropic, Gemini, and Groq.

## What RouteMind Is

- An AI infrastructure platform for enterprise LLM traffic.
- A gateway layer comparable in spirit to Kong or Envoy, but specialized for AI workloads.
- A modular TypeScript monorepo designed for clean architecture, dependency injection, and extensibility.

## What RouteMind Is Not

- Not a chatbot.
- Not a simple API wrapper.
- Not a direct provider-specific SDK wrapper.

## Stack

- Node.js, TypeScript, Fastify
- PostgreSQL, Redis, Prisma
- Zod, Pino
- Vitest
- npm workspaces
- Docker Compose

## Quick Start

```bash
npm install
cp .env.example .env
docker compose up -d
npm run db:migrate
npm run seed:dev
npm run dev
```

RouteMind can be used in two modes:

- Server mode: run the Fastify gateway and call its HTTP API.
- SDK mode: install/use `@routemind/sdk` and call `client.chat.completions.create()`.

Health endpoint:

```bash
curl http://localhost:3000/health
```

Docker:

```bash
docker compose up --build
```

## MVP API

RouteMind exposes an OpenAI-compatible endpoint:

```http
POST /v1/chat/completions
```

Authentication uses the `x-api-key` header. Run `npm run seed:dev` to create a local user and print a one-time `rm_test_...` RouteMind API key.

Example request:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "content-type: application/json" \
  -H "x-api-key: rm_test_your_generated_key" \
  -d '{
    "model": "auto",
    "messages": [
      { "role": "user", "content": "Help me debug this code" }
    ],
    "temperature": 0.7,
    "stream": false
  }'
```

Sample response:

```json
{
  "id": "chatcmpl_mock_...",
  "object": "chat.completion",
  "created": 1783420000,
  "model": "claude-3-5-sonnet",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Mock anthropic response for claude-3-5-sonnet. RouteMind selected this provider during MVP routing."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 6,
    "completion_tokens": 300,
    "total_tokens": 306
  },
  "metadata": {
    "requestedModel": "auto",
    "selectedModel": "claude-3-5-sonnet",
    "provider": "anthropic",
    "inputTokens": 6,
    "outputTokens": 300,
    "estimatedCost": 0.004518,
    "latencyMs": 12,
    "routingReason": "matched code/debug prompt"
  }
}
```

Streaming is intentionally disabled in the MVP. Requests with `"stream": true` return `400` with:

```json
{
  "error": {
    "message": "Streaming is not supported in MVP yet."
  }
}
```

## Provider Modes

RouteMind defaults to mock providers for local development:

```env
PROVIDER_MODE=mock
PROVIDER_TIMEOUT_MS=30000
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
```

To use live providers, set:

```env
PROVIDER_MODE=live
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
GROQ_API_KEY=...
```

Only the provider selected for a request needs a valid key, but missing or invalid keys return clean RouteMind provider errors. API keys are never logged.

Registered chat models include:

- `gpt-4o`
- `gpt-4o-mini`
- `gpt-4.1`
- `gpt-4.1-mini`
- `gpt-4.1-nano`
- `gpt-5`
- `gpt-5-mini`
- `gpt-5-nano`
- `claude-3-5-sonnet`
- `gemini-1.5-flash`
- `gemini-1.5-pro`
- `llama-3.1-70b-versatile`

## SDK Usage

The SDK package lives at `packages/sdk` and exposes the npm package name `@routemind/sdk`.

```ts
import { RouteMind } from "@routemind/sdk";

const client = new RouteMind({
  apiKey: "rm_test_your_generated_key",
  baseUrl: "http://localhost:3000",
  timeoutMs: 30000,
  maxRetries: 2,
});

const response = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Help me debug this code" }],
  temperature: 0.7,
});
```

The SDK includes TypeScript types, timeout handling, retry handling for transient failures, and SDK error classes.

## Provider Configuration

RouteMind supports user-specific provider and model availability through these database tables:

- `User`
- `ApiKey`
- `ProviderCredential`
- `UserModelAccess`

API keys are stored as hashes. Provider credentials are stored encrypted with `CREDENTIAL_ENCRYPTION_KEY`; raw provider keys should not be stored directly.

Create a user:

```bash
curl -X POST http://localhost:3000/v1/users \
  -H "content-type: application/json" \
  -d '{"name":"Rushikesh","email":"rushikesh@example.com"}'
```

Create a RouteMind API key. The raw key is returned only once:

```bash
curl -X POST http://localhost:3000/v1/api-keys \
  -H "content-type: application/json" \
  -d '{"userId":"user_id_from_previous_step","name":"Local Dev Key"}'
```

Store a provider credential:

```bash
curl -X POST http://localhost:3000/v1/provider-credentials \
  -H "content-type: application/json" \
  -d '{"userId":"user_id","provider":"openai","apiKey":"sk-..."}'
```

Enable a model for the user:

```bash
curl -X POST http://localhost:3000/v1/model-access \
  -H "content-type: application/json" \
  -d '{"userId":"user_id","provider":"openai","model":"gpt-4o-mini","isEnabled":true}'
```

List the models currently available to a user:

```bash
curl http://localhost:3000/v1/users/user_id/available-models
```

## Provider Health Monitoring

RouteMind records operational health after every provider request and uses the latest rolling metrics during routing. For the MVP, metrics are calculated from the last 100 in-process samples per provider/model and persisted as dashboard-ready `ProviderHealthMetric` snapshots in PostgreSQL.

Tracked fields include:

- Status: `healthy`, `degraded`, or `down`
- Average latency and p95 latency
- Success rate, error rate, timeout rate, and rate-limit rate
- Sample size, last error, and last checked timestamp

Status rules:

- `healthy`: `successRate >= 0.98` and `p95LatencyMs <= 8000`
- `degraded`: `successRate >= 0.90` but `< 0.98`, or `p95LatencyMs > 8000`
- `down`: `successRate < 0.90`, or `timeoutRate > 0.20`

Routing behavior:

- `score_based` and `llm_assisted` routing receive live model health.
- Down models are excluded by default.
- Degraded models stay available but receive a routing penalty.
- Requests can opt into down/degraded candidates with `routing.allowUnhealthyProviders: true`.
- `routing.requireHealthyProviders: true` allows only healthy candidates.

Health API examples:

```bash
curl http://localhost:3000/v1/health/providers
curl http://localhost:3000/v1/health/providers/openai
curl http://localhost:3000/v1/health/providers/openai/gpt-4o
```

Example response:

```json
{
  "providers": [
    {
      "provider": "openai",
      "models": [
        {
          "model": "gpt-4o",
          "status": "healthy",
          "avgLatencyMs": 2200,
          "p95LatencyMs": 5400,
          "successRate": 0.992,
          "errorRate": 0.008,
          "timeoutRate": 0,
          "rateLimitRate": 0,
          "sampleSize": 100,
          "lastCheckedAt": "2026-07-07T09:00:00.000Z"
        }
      ]
    }
  ]
}
```

Routing now considers only models enabled for the authenticated user:

1. Identify the user from `x-api-key`.
2. Load enabled provider credentials.
3. Load enabled model access.
4. Pick the ideal model for the task.
5. Fall back to the best enabled alternative when needed.
6. Return a clear error when no suitable model is available.

Example fallback behavior:

- Code prompt with Anthropic enabled: selects `claude-3-5-sonnet`.
- Code prompt without Anthropic: falls back to `gpt-4o`.
- Code prompt with only Gemini enabled: falls back to `gemini-1.5-pro`.
- No enabled models: returns a `400` with routing metadata explaining the unavailable model set.

Auto-routing rules:

- Code/debug/refactor/unit test prompts route to `claude-3-5-sonnet`.
- Summarize/rewrite/grammar prompts route to `gemini-1.5-flash`.
- Architecture/reasoning/system design prompts route to `gpt-4o`.
- Fast/cheap/simple prompts route to `gpt-4o-mini`.
- Fallback routes to `gemini-1.5-flash`.

## Workspace Layout

```text
apps/
  api/          Fastify API gateway process
  dashboard/    Future operator dashboard placeholder
packages/
  core/         Domain contracts and gateway abstractions
  providers/    Provider adapter interfaces
  routing/      Routing strategy interfaces
  auth/         Authentication and authorization contracts
  analytics/    Usage and event analytics contracts
  cost-engine/  Pricing and cost-estimation contracts
  observability/Telemetry contracts
  policy-engine/Policy evaluation contracts
  shared/       Shared utilities, schemas, and types
  sdk/          Future public SDK contracts
docs/           Architecture, system design, and contribution docs
docker/         Container build files
```

## Current Scope

Implemented:

- Monorepo structure.
- Fastify API with health endpoint and OpenAI-compatible chat completions endpoint.
- Database-backed API key authentication using hashed RouteMind API keys.
- Request validation with Zod.
- Keyword-based routing engine for automatic provider/model selection.
- Provider factory with mock and live modes.
- Mock and live OpenAI, Anthropic, Gemini, and Groq providers.
- Basic cost estimation.
- PostgreSQL request tracking with Prisma.
- Redis-backed rate limiting at 100 requests per API key per hour.
- TypeScript, ESLint, Prettier, Vitest.
- Docker Compose for API, PostgreSQL, and Redis.
- Husky and commitlint configuration.
- GitHub Actions CI workflow.
- Package-level interfaces and MVP implementations for core routing/provider/cost concerns.

Deferred:

- Streaming provider responses.
- Production routing strategies beyond the MVP keyword router.
- Fine-grained organization/team authorization.
- Dashboard application.

## MVP Architecture Summary

The Fastify API composes infrastructure and domain packages:

- `apps/api` handles HTTP, CORS, request IDs, errors, API key checks, rate limiting, validation, and persistence.
- `packages/routing` selects a model/provider from the prompt when `model` is `auto`.
- `packages/providers` contains mock and live provider adapters normalized to OpenAI-compatible response bodies.
- `packages/cost-engine` estimates tokens and cost from prompt size, live usage, and configurable model pricing.
- PostgreSQL stores `RequestLog` entries for successful and failed chat completion requests.
- Redis stores hourly API key rate-limit counters.

## Documentation

- [Architecture](./Architecture.md)
- [Roadmap](./Roadmap.md)
- [Contributing](./Contributing.md)
- [System Design](./docs/system-design/README.md)
- [Folder Responsibilities](./docs/folder-responsibilities.md)
- [Coding Standards](./docs/coding-standards.md)
- [Future Milestones](./docs/future-milestones.md)
