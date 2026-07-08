# RouteMind

RouteMind is a production-grade AI Gateway foundation for routing requests across multiple LLM providers based on cost, latency, model capabilities, availability, and enterprise routing policies.

This repository includes a backend AI Gateway and a developer dashboard for monitoring routing, provider health, resilience, cost, and request analytics.

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
- Next.js, React, Tailwind CSS, Recharts
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

Run the dashboard in another terminal:

```bash
npm run dev -w @routemind/dashboard
```

The dashboard reads the API base URL from:

```env
NEXT_PUBLIC_ROUTEMIND_API_URL=http://localhost:3000
```

If the variable is not set, it defaults to `http://localhost:3000`.

RouteMind can be used in two modes:

- Server mode: run the Fastify gateway and call its HTTP API.
- SDK mode: install/use `@routemind/sdk` and call `client.chat.completions.create()`.
- CLI mode: install/use `@routemind/cli` and run `routemind chat "..."`.

Health endpoint:

```bash
curl http://localhost:3000/health
```

Docker:

```bash
docker compose up --build
```

## OpenAI SDK Compatibility

RouteMind can be used as an OpenAI-compatible base URL for existing apps. Point the official OpenAI SDK at RouteMind and keep using `chat.completions.create`.

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.ROUTEMIND_API_KEY,
  baseURL: "http://localhost:3000/v1",
});

const response = await openai.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Help me debug this code" }],
});
```

Authentication supports both headers:

```http
Authorization: Bearer rm_live_xxx
x-api-key: rm_live_xxx
```

`POST /v1/chat/completions` accepts common OpenAI request fields including `model`, `messages`, `temperature`, `max_tokens`, `top_p`, `presence_penalty`, `frequency_penalty`, `stop`, and `stream: false`. Unsupported optional fields are safely ignored for now when their types are valid.

Responses keep the standard OpenAI shape and add RouteMind metadata under `routemind`:

```json
{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  },
  "routemind": {
    "routing": {},
    "resilience": {},
    "costGuardrails": {},
    "executionPlan": {}
  }
}
```

List models with:

```bash
curl http://localhost:3000/v1/models
curl http://localhost:3000/v1/models -H "Authorization: Bearer rm_test_your_key"
```

Unauthenticated requests return the public registry plus `auto`. Authenticated requests return `auto` and the user's enabled models.

Streaming is supported over Server-Sent Events:

```ts
const stream = await openai.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Help me debug this code" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

Raw SSE responses use OpenAI-compatible chunks and finish with RouteMind metadata before `[DONE]`:

```text
data: {"id":"chatcmpl_...","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"routemind":{"routing":{},"resilience":{},"costGuardrails":{},"executionPlan":{}}}

data: [DONE]
```

## Semantic Response Cache

RouteMind can cache successful non-streaming chat completions before provider execution. This reduces repeated LLM calls, latency, and spend while preserving the normal auth, validation, routing, resilience, budget, and logging flow on cache misses.

Cache modes:

- `disabled`: never read or write cache.
- `exact`: cache normalized prompt matches. This is the MVP default.
- `semantic`: accepted today, but falls back to exact matching while embedding/vector search providers are added.

Request example:

```json
{
  "model": "auto",
  "messages": [{ "role": "user", "content": "Summarize this incident report" }],
  "cache": {
    "mode": "exact",
    "ttlSeconds": 3600,
    "similarityThreshold": 0.92,
    "bypass": false
  }
}
```

Exact cache keys include the user, normalized messages, requested model, routing strategy, and temperature. RouteMind normalizes whitespace and casing outside code blocks while preserving fenced code blocks. Cache hits return immediately with metadata:

```json
{
  "routemind": {
    "cache": {
      "hit": true,
      "mode": "exact",
      "costSavedUsd": 0.0021,
      "originalModel": "gpt-4o",
      "originalProvider": "openai"
    }
  }
}
```

RouteMind does not cache streaming requests, errors, requests with `cache.bypass: true`, requests above `temperature: 0.7`, or unsupported tool-call style responses.

Cache APIs:

```bash
curl http://localhost:3000/v1/cache/stats
curl http://localhost:3000/v1/cache/entries
curl -X DELETE http://localhost:3000/v1/cache
```

Stats are also included in `/v1/analytics/summary` under `cache`:

```json
{
  "cache": {
    "cacheHits": 42,
    "cacheMisses": 108,
    "estimatedCostSavedUsd": 1.84,
    "cacheHitRate": 0.28
  }
}
```

## Developer Dashboard

The dashboard lives in `apps/dashboard` and is available at `http://localhost:3001/dashboard` during local development.

Pages:

- `/dashboard`: overview KPIs, spend/request charts, provider/model distribution, health and recent requests
- `/dashboard/analytics`: detailed model, provider, error, cost, and latency analytics
- `/dashboard/models`: model usage and routing performance
- `/dashboard/providers`: provider/model health, reliability, latency, and sample counts
- `/dashboard/costs`: spend trend, top models/providers by spend, budget and quota signals
- `/dashboard/resilience`: circuit breakers, provider attempts, fallback and retry signals
- `/dashboard/evaluations`: datasets, recent runs, and model quality scores
- `/dashboard/requests`: recent request logs

The UI uses existing backend APIs:

- `/v1/analytics/summary`
- `/v1/analytics/models`
- `/v1/analytics/providers`
- `/v1/analytics/errors`
- `/v1/analytics/costs`
- `/v1/analytics/latency`
- `/v1/analytics/requests?limit=50`
- `/v1/evaluations/datasets`
- `/v1/evaluations/runs`
- `/v1/evaluations/scores`
- `/v1/health/providers`
- `/v1/resilience/circuit-breakers`
- `/v1/resilience/provider-attempts`

When the API is unavailable, the dashboard shows a clear demo-data banner so the frontend can still be reviewed locally.

Build the full workspace, including the dashboard:

```bash
npm run build
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
    "routingReason": "matched code/debug prompt",
    "resilience": {
      "primaryProvider": "anthropic",
      "primaryModel": "claude-3-5-sonnet",
      "finalProvider": "anthropic",
      "finalModel": "claude-3-5-sonnet",
      "fallbackUsed": false,
      "circuitBreakerTriggered": false,
      "attempts": [
        {
          "provider": "anthropic",
          "model": "claude-3-5-sonnet",
          "attemptNumber": 1,
          "status": "success",
          "latencyMs": 12
        }
      ]
    }
  },
  "resilience": {
    "primaryProvider": "anthropic",
    "primaryModel": "claude-3-5-sonnet",
    "finalProvider": "anthropic",
    "finalModel": "claude-3-5-sonnet",
    "fallbackUsed": false,
    "circuitBreakerTriggered": false,
    "attempts": [
      {
        "provider": "anthropic",
        "model": "claude-3-5-sonnet",
        "attemptNumber": 1,
        "status": "success",
        "latencyMs": 12
      }
    ]
  },
  "executionPlan": {
    "planType": "single_model",
    "steps": [
      {
        "step": 1,
        "purpose": "answer_user_request",
        "provider": "anthropic",
        "model": "claude-3-5-sonnet",
        "reason": "Best fit for medium-complexity debugging task."
      }
    ],
    "estimatedCostUsd": 0.004518,
    "actualCostUsd": 0.004518,
    "confidence": 0.86,
    "reason": "Use the normal routed model as a single-step execution plan.",
    "executed": true
  },
  "routingMetadata": {
    "mode": "llm_assisted",
    "routingStrategy": "balanced",
    "fallbackUsed": false
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

The SDK package lives at `packages/sdk` and is prepared for the public npm package name `@routemind/sdk`.

```ts
import {
  BudgetExceededError,
  RateLimitError,
  RouteMind,
  RouteMindError,
} from "@routemind/sdk";

const client = new RouteMind({
  apiKey: process.env.ROUTEMIND_API_KEY,
  baseUrl: "http://localhost:3000",
  timeoutMs: 30000,
  maxRetries: 2,
  requestId: () => crypto.randomUUID(),
  headers: {
    "x-workspace-id": "workspace_123",
  },
});

try {
  const response = await client.chat.completions.create({
    model: "auto",
    messages: [{ role: "user", content: "Help me debug this code" }],
    temperature: 0.7,
    routing: {
      mode: "llm_assisted",
      strategy: "balanced",
      executionPlan: "auto",
    },
  });

  console.log(response.choices[0]?.message.content);
  console.log(response.routingMetadata, response.executionPlan);
} catch (error) {
  if (error instanceof BudgetExceededError) {
    console.error("RouteMind budget guardrail blocked this request.");
  } else if (error instanceof RateLimitError) {
    console.error("RouteMind rate limit hit; retry later.");
  } else if (error instanceof RouteMindError) {
    console.error(error.code, error.statusCode, error.message);
  }
}
```

Streaming with the RouteMind SDK:

```ts
const stream = client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Stream this answer" }],
  stream: true,
});

for await (const chunk of stream) {
  if ("choices" in chunk) {
    process.stdout.write(chunk.choices[0]?.delta.content ?? "");
  }
}
```

The SDK includes TypeScript request/response types, mapped error classes, timeout handling, retry handling for transient failures, request ID support, custom headers, configurable `baseUrl`, and browser-safe fetch support where the runtime provides `fetch`.

Additional methods:

```ts
await client.health.providers.list();
await client.analytics.summary({ from: "2026-07-07T00:00:00.000Z" });
await client.resilience.circuitBreakers.list();
await client.users.create({ name: "Rushikesh", email: "rushikesh@example.com" });
await client.apiKeys.create({ userId: "user_id", name: "Local Dev Key" });
await client.providerCredentials.create({
  userId: "user_id",
  provider: "openai",
  apiKey: "sk-...",
});
await client.modelAccess.create({
  userId: "user_id",
  provider: "openai",
  model: "gpt-4o-mini",
  isEnabled: true,
});
```

See `packages/sdk/README.md` for installation, TypeScript, routing, analytics, provider health, and error-handling examples.

## CLI Usage

The CLI package lives at `packages/cli` and is prepared for the npm package name `@routemind/cli`.

```bash
npm run build -w @routemind/cli
node packages/cli/dist/index.js --help
```

After publishing, the binary name is `routemind`:

```bash
routemind login
routemind chat "Help me debug this code"
routemind health
routemind analytics
routemind models
routemind costs
routemind circuit-breakers
routemind config
```

Global options:

```bash
routemind --api-key rm_test_... --base-url http://localhost:3000 health
routemind --json analytics
```

Chat options:

```bash
routemind chat "debug this code" \
  --strategy quality_first \
  --routing-mode llm_assisted \
  --max-cost-tier medium \
  --max-estimated-cost-usd 0.02
```

`routemind login` stores local config at `~/.routemind/config.json` with `apiKey` and `baseUrl`. Human-readable output masks API keys.

Streaming from the CLI:

```bash
routemind chat "Explain this stack trace" --stream
```

See `packages/cli/README.md` for command examples and JSON mode details.

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

## AI Planner

RouteMind planning is a layer above routing. Routing answers: "which model/provider should be eligible and preferred?" Planning answers: "how should this request be executed?"

The request can opt into planner behavior:

```json
{
  "model": "auto",
  "messages": [{ "role": "user", "content": "Analyze this architecture tradeoff" }],
  "routing": {
    "mode": "llm_assisted",
    "strategy": "balanced",
    "executionPlan": "auto"
  }
}
```

Supported `routing.executionPlan` values:

- `auto`: RouteMind chooses an executable plan. In the MVP this resolves to `single_model`.
- `single_model`: Normal routing, then execute one best model.
- `quality_first`: Execute the strongest valid available model.
- `cheap_first`: Planned interface for trying a cheap/fast draft before escalation. Not executable yet.
- `summarize_then_reason`: Planned interface for compressing large context before reasoning. Not executable yet.

Planner recommendations are validated before execution. RouteMind still enforces enabled providers, enabled models, blocked providers/models, max cost tier, health status, circuit breaker state, budgets, and quotas. If an executable planner recommendation is invalid, RouteMind falls back to normal routing.

Every planned request includes response metadata and writes an `ExecutionPlanLog`:

```json
{
  "executionPlan": {
    "planType": "quality_first",
    "steps": [
      {
        "step": 1,
        "purpose": "answer_user_request",
        "provider": "openai",
        "model": "gpt-4o",
        "reason": "Highest quality available model after routing constraints."
      }
    ],
    "estimatedCostUsd": 0.01,
    "actualCostUsd": 0.008,
    "confidence": 0.9,
    "reason": "Prioritize answer quality over cost and latency.",
    "executed": true
  }
}
```

Future planner work will make `cheap_first` and `summarize_then_reason` executable with model-to-model intermediate outputs and quality checks.

## Analytics APIs

RouteMind exposes backend-only analytics APIs for a future dashboard. They read from existing gateway logs: `RequestLog`, `ProviderAttemptLog`, `RouterDecisionLog`, `ExecutionPlanLog`, and provider health snapshots.

All analytics endpoints accept optional filters:

- `userId`
- `from`: ISO datetime
- `to`: ISO datetime

Endpoints:

```bash
curl "http://localhost:3000/v1/analytics/summary?from=2026-07-07T00:00:00.000Z"
curl http://localhost:3000/v1/analytics/models
curl http://localhost:3000/v1/analytics/providers
curl http://localhost:3000/v1/analytics/errors
curl http://localhost:3000/v1/analytics/costs
curl http://localhost:3000/v1/analytics/latency
```

Summary response:

```json
{
  "range": {
    "from": "2026-07-07T00:00:00.000Z",
    "to": "2026-07-07T23:59:59.999Z"
  },
  "requests": {
    "total": 1000,
    "success": 940,
    "failed": 60,
    "successRate": 0.94
  },
  "cost": {
    "totalSpendUsd": 12.48,
    "averageCostPerRequest": 0.01248
  },
  "tokens": {
    "input": 120000,
    "output": 45000,
    "total": 165000
  },
  "latency": {
    "averageMs": 1850,
    "p95Ms": 5200
  },
  "routing": {
    "fallbackUsed": 74,
    "llmAssisted": 800,
    "scoreBased": 120,
    "ruleBased": 80
  },
  "guardrails": {
    "budgetBlocked": 12,
    "quotaBlocked": 8
  }
}
```

Grouped model analytics:

```json
{
  "models": [
    {
      "model": "gpt-4o",
      "provider": "openai",
      "requests": 120,
      "successRate": 0.98,
      "totalSpendUsd": 3.5,
      "averageLatencyMs": 2100
    }
  ]
}
```

Cost analytics groups spend by day:

```json
{
  "costs": [
    {
      "date": "2026-07-07",
      "spendUsd": 1.42,
      "requests": 130
    }
  ]
}
```

Latency analytics groups by day and provider:

```json
{
  "latency": [
    {
      "date": "2026-07-07",
      "provider": "openai",
      "averageLatencyMs": 1850,
      "p95LatencyMs": 5200,
      "requests": 80
    }
  ]
}
```

## Evaluation Engine

RouteMind includes an evaluation and benchmarking layer so routing can learn from model quality, not only cost, latency, and health. Evaluations let teams define datasets, run provider/model benchmarks, store per-case results, and expose model scores that RouteMind passes into the routing engine.

Scoring modes:

- `exact_match`: model output must exactly equal `expectedOutput`.
- `contains`: model output must contain `expectedOutput`.
- `llm_judge`: interface is present for rubric-based judging; the MVP uses a mock judge.

Create a dataset:

```bash
curl -X POST http://localhost:3000/v1/evaluations/datasets \
  -H "content-type: application/json" \
  -d '{
    "name": "Code debugging",
    "description": "Checks debugging answer quality",
    "taskType": "debugging"
  }'
```

Add a case:

```bash
curl -X POST http://localhost:3000/v1/evaluations/datasets/eval_dataset_1/cases \
  -H "content-type: application/json" \
  -d '{
    "inputMessagesJson": [
      { "role": "user", "content": "Bug: undefined is not a function" }
    ],
    "expectedOutput": "undefined",
    "gradingRubric": "contains",
    "metadataJson": { "difficulty": "easy" }
  }'
```

Create and start a run:

```bash
curl -X POST http://localhost:3000/v1/evaluations/runs \
  -H "content-type: application/json" \
  -d '{
    "datasetId": "eval_dataset_1",
    "provider": "openai",
    "model": "gpt-4o"
  }'

curl -X POST http://localhost:3000/v1/evaluations/runs/eval_run_1/start
```

Run response:

```json
{
  "run": {
    "id": "eval_run_1",
    "datasetId": "eval_dataset_1",
    "model": "gpt-4o",
    "provider": "openai",
    "status": "completed",
    "totalCases": 10,
    "passedCases": 8,
    "averageScore": 0.82
  },
  "results": []
}
```

List dashboard-friendly score aggregates:

```bash
curl http://localhost:3000/v1/evaluations/scores
```

Completed evaluation scores are passed into `decideLLMRoute` through `evaluationScores`, allowing the router or Router LLM to prefer models that benchmark well for real tasks.

The developer seed command creates sample datasets for summarization, code debugging, JSON extraction, and simple chat:

```bash
npm run seed:dev
```

## Resilience Layer

RouteMind wraps provider execution in a production resilience layer after routing selects candidates.

Retry behavior:

- Retries transient provider failures only: timeout, HTTP 429, HTTP 500, HTTP 502, HTTP 503, HTTP 504, and network/provider unavailable errors.
- Does not retry auth errors, invalid provider keys, bad requests, unsupported models, validation errors, budget failures, or quota failures.
- Defaults to `maxRetries: 2`, `baseDelayMs: 300`, `maxDelayMs: 3000`, exponential backoff, and jitter.

Fallback behavior:

- The primary routed candidate is attempted first.
- If the primary still fails after allowed retries, RouteMind attempts the remaining `route.candidates` in routing order.
- Fallback candidates still respect enabled providers, enabled models, blocked providers/models, max cost tier, provider health, request cost limits, budgets, quotas, and circuit breaker state.
- Open circuits are skipped before provider execution.

Circuit breaker rules:

- Circuits are tracked per provider and model.
- Default state is `CLOSED`.
- Five failures within five minutes moves a circuit to `OPEN`.
- `OPEN` circuits stay open for two minutes.
- After two minutes they move to `HALF_OPEN`.
- A successful half-open request closes the circuit.
- A failed half-open request opens it again.

Resilience APIs:

```bash
curl http://localhost:3000/v1/resilience/circuit-breakers
curl http://localhost:3000/v1/resilience/circuit-breakers/openai
curl -X POST http://localhost:3000/v1/resilience/circuit-breakers/openai/gpt-4o-mini/reset
curl "http://localhost:3000/v1/resilience/provider-attempts?provider=openai&status=failed&limit=50"
```

Successful responses include the same metadata when retries or fallback were used:

```json
{
  "id": "chatcmpl_mock_...",
  "object": "chat.completion",
  "model": "claude-3-5-sonnet",
  "resilience": {
    "primaryProvider": "openai",
    "primaryModel": "gpt-4o-mini",
    "finalProvider": "anthropic",
    "finalModel": "claude-3-5-sonnet",
    "fallbackUsed": true,
    "circuitBreakerTriggered": false,
    "attempts": [
      {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "attemptNumber": 1,
        "status": "failed",
        "latencyMs": 301,
        "errorType": "TIMEOUT",
        "errorMessage": "OpenAI timed out."
      },
      {
        "provider": "anthropic",
        "model": "claude-3-5-sonnet",
        "attemptNumber": 1,
        "status": "success",
        "latencyMs": 642
      }
    ]
  }
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
  sdk/          Public TypeScript SDK package
  cli/          Developer CLI package
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
- AI Planner with `single_model` and `quality_first` execution strategies plus future-plan metadata.
- Backend analytics APIs for summary, model, provider, error, cost, and latency dashboards.
- Production-ready TypeScript SDK package prepared for npm publishing.
- Developer CLI for login, chat, health, analytics, models, costs, and circuit breaker inspection.
- Evaluation datasets, benchmark runs, model quality scores, and routing score integration.
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

- Native live-provider streaming beyond simulated chunks.
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
