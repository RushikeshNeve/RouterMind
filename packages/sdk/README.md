# @routemind/sdk

TypeScript SDK for RouteMind, an AI Gateway for routing, planning, guardrails, resilience, and analytics across multiple LLM providers.

## Installation

```bash
npm install @routemind/sdk
```

## Quick Start

```ts
import { RouteMind } from "@routemind/sdk";

const client = new RouteMind({
  apiKey: process.env.ROUTEMIND_API_KEY,
  baseUrl: "http://localhost:3000",
});

const response = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Help me debug this code" }],
});

console.log(response.choices[0]?.message.content);
```

## Chat Completions

```ts
const response = await client.chat.completions.create({
  model: "auto",
  messages: [
    { role: "system", content: "You are a concise debugging assistant." },
    { role: "user", content: "Why is this TypeScript type failing?" },
  ],
  temperature: 0.4,
});
```

## Streaming

```ts
const stream = client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Stream a concise explanation." }],
  stream: true,
});

for await (const chunk of stream) {
  if ("choices" in chunk) {
    process.stdout.write(chunk.choices[0]?.delta.content ?? "");
  }
}
```

Streaming returns OpenAI-compatible `chat.completion.chunk` events. The final event before completion contains RouteMind metadata under `routemind`, then the server sends `[DONE]`.

## Routing Options

```ts
await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Analyze this incident report." }],
  routing: {
    mode: "llm_assisted",
    strategy: "balanced",
    executionPlan: "auto",
    maxCostTier: "medium",
  },
});
```

## Error Handling

```ts
import {
  AuthenticationError,
  BudgetExceededError,
  RateLimitError,
  RouteMind,
  RouteMindError,
} from "@routemind/sdk";

try {
  await client.chat.completions.create({
    model: "auto",
    messages: [{ role: "user", content: "Hello" }],
  });
} catch (error) {
  if (error instanceof BudgetExceededError) {
    console.error("Budget guardrail blocked the request.");
  } else if (error instanceof RateLimitError) {
    console.error("Retry later.");
  } else if (error instanceof AuthenticationError) {
    console.error("Check ROUTEMIND_API_KEY.");
  } else if (error instanceof RouteMindError) {
    console.error(error.code, error.statusCode, error.message);
  }
}
```

## Analytics

```ts
const summary = await client.analytics.summary({
  from: "2026-07-07T00:00:00.000Z",
  to: "2026-07-07T23:59:59.999Z",
});

console.log(summary.requests.total, summary.cost.totalSpendUsd);
```

## Provider Health

```ts
const health = await client.health.providers.list();

for (const provider of health.providers) {
  console.log(provider.provider, provider.models.map((model) => model.status));
}
```

## Resilience

```ts
const breakers = await client.resilience.circuitBreakers.list();
console.log(breakers.circuitBreakers);
```

## Admin Setup Helpers

```ts
const user = await client.users.create({
  name: "Local Developer",
  email: "dev@example.com",
});

const key = await client.apiKeys.create({
  userId: user.id,
  name: "Local Dev Key",
});

await client.providerCredentials.create({
  userId: user.id,
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY!,
});

await client.modelAccess.create({
  userId: user.id,
  provider: "openai",
  model: "gpt-4o-mini",
  isEnabled: true,
});

console.log(key.apiKey);
```

## Configuration

```ts
const client = new RouteMind({
  apiKey: process.env.ROUTEMIND_API_KEY,
  baseUrl: "https://gateway.example.com",
  timeoutMs: 30_000,
  maxRetries: 2,
  requestId: () => crypto.randomUUID(),
  headers: {
    "x-workspace-id": "workspace_123",
  },
});
```

The SDK uses the runtime's global `fetch` by default and accepts a custom fetch implementation for tests or older runtimes.

## TypeScript

Useful exported types include:

- `RouteMindClientOptions`
- `ChatCompletionRequest`
- `ChatCompletionResponse`
- `RoutingMetadata`
- `ResilienceMetadata`
- `ExecutionPlanMetadata`
- `ProviderHealthMetric`
- `AnalyticsSummary`

```ts
import type { AnalyticsSummary, ChatCompletionRequest } from "@routemind/sdk";

const request: ChatCompletionRequest = {
  model: "auto",
  messages: [{ role: "user", content: "Summarize this incident." }],
};

const renderSpend = (summary: AnalyticsSummary) => summary.cost.totalSpendUsd.toFixed(2);
```
