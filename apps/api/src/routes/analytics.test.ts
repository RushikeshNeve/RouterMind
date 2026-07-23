import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { ApiConfig } from "../config.js";
import { InMemoryExecutionPlanLogStore } from "../infrastructure/execution-plan-log-store.js";
import { InMemoryProviderAttemptLogStore } from "../infrastructure/provider-attempt-log-store.js";
import { InMemoryRequestLogStore } from "../infrastructure/request-log-store.js";
import { InMemoryRouterDecisionLogStore } from "../infrastructure/router-decision-log-store.js";

const testConfig: ApiConfig = {
  DATABASE_URL: "postgresql://routemind:routemind@localhost:5432/routemind?schema=public",
  DEV_API_KEY: "dev-key",
  CREDENTIAL_ENCRYPTION_KEY: "development-credential-key-change-me",
  SESSION_SECRET: "development-session-secret-change-me",
  LOG_LEVEL: "silent",
  NODE_ENV: "test",
  PORT: 3000,
  PADDLE_ENVIRONMENT: "sandbox",
  PROVIDER_MODE: "mock",
  PROVIDER_TIMEOUT_MS: 30_000,
  ROUTER_LLM_ENABLED: true,
  ROUTER_LLM_MAX_TOKENS: 300,
  ROUTER_LLM_MODEL: "gpt-4o-mini",
  REDIS_URL: "redis://localhost:6379",
};

interface AnalyticsSummaryResponse {
  readonly requests: {
    readonly total: number;
    readonly success: number;
    readonly failed: number;
    readonly successRate: number;
  };
  readonly cost: {
    readonly totalSpendUsd: number;
    readonly averageCostPerRequest: number;
  };
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly latency: {
    readonly averageMs: number;
    readonly p95Ms: number;
  };
  readonly routing: {
    readonly fallbackUsed: number;
    readonly llmAssisted: number;
    readonly scoreBased: number;
    readonly ruleBased: number;
  };
  readonly guardrails: {
    readonly budgetBlocked: number;
    readonly quotaBlocked: number;
  };
}

interface ModelsResponse {
  readonly models: readonly {
    readonly model: string;
    readonly provider?: string;
    readonly requests: number;
    readonly successRate: number;
    readonly totalSpendUsd: number;
    readonly averageLatencyMs: number;
  }[];
}

interface ProvidersResponse {
  readonly providers: readonly {
    readonly provider: string;
    readonly requests: number;
    readonly successRate: number;
    readonly totalSpendUsd: number;
    readonly averageLatencyMs: number;
  }[];
}

interface ErrorsResponse {
  readonly errors: readonly {
    readonly errorMessage: string;
    readonly provider?: string;
    readonly model?: string;
    readonly errorType?: string;
    readonly count: number;
  }[];
}

function parseResponse<TResponse>(response: { payload: string }): TResponse {
  return JSON.parse(response.payload) as TResponse;
}

async function createAnalyticsTestApp(seed = true) {
  const requestLogStore = new InMemoryRequestLogStore();
  const routerDecisionLogStore = new InMemoryRouterDecisionLogStore();
  const providerAttemptLogStore = new InMemoryProviderAttemptLogStore();
  const executionPlanLogStore = new InMemoryExecutionPlanLogStore();

  if (seed) {
    await seedAnalyticsData({
      requestLogStore,
      routerDecisionLogStore,
      providerAttemptLogStore,
      executionPlanLogStore,
    });
  }

  const app = await buildApp({
    config: testConfig,
    requestLogStore,
    routerDecisionLogStore,
    providerAttemptLogStore,
    executionPlanLogStore,
  });

  return { app, requestLogStore, routerDecisionLogStore };
}

async function seedAnalyticsData(stores: {
  readonly requestLogStore: InMemoryRequestLogStore;
  readonly routerDecisionLogStore: InMemoryRouterDecisionLogStore;
  readonly providerAttemptLogStore: InMemoryProviderAttemptLogStore;
  readonly executionPlanLogStore: InMemoryExecutionPlanLogStore;
}) {
  const first = await stores.requestLogStore.create({
    apiKey: "key-a",
    requestedModel: "auto",
    selectedModel: "gpt-4o",
    provider: "openai",
    inputTokens: 100,
    outputTokens: 50,
    estimatedCost: 1,
    latencyMs: 100,
    status: "success",
    routingMode: "llm_assisted",
    routingStrategy: "balanced",
    createdAt: new Date("2026-07-07T10:00:00.000Z"),
  });
  await stores.routerDecisionLogStore.create({
    requestLogId: first,
    userId: "user-a",
    mode: "llm_assisted",
    candidateModelsJson: [],
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
    fallbackUsed: true,
    createdAt: new Date("2026-07-07T10:00:01.000Z"),
  });
  await stores.executionPlanLogStore.create({
    requestLogId: first,
    userId: "user-a",
    planType: "single_model",
    stepsJson: [],
    estimatedCostUsd: 1,
    actualCostUsd: 1,
    confidence: 0.8,
    reason: "normal route",
    executed: true,
    createdAt: new Date("2026-07-07T10:00:01.000Z"),
  });

  const second = await stores.requestLogStore.create({
    apiKey: "key-a",
    requestedModel: "auto",
    selectedModel: "gpt-4o",
    provider: "openai",
    estimatedCost: 0,
    latencyMs: 300,
    status: "failed",
    errorMessage: "User budget exceeded.",
    routingMode: "score_based",
    routingStrategy: "balanced",
    createdAt: new Date("2026-07-07T11:00:00.000Z"),
  });
  await stores.routerDecisionLogStore.create({
    requestLogId: second,
    userId: "user-a",
    mode: "score_based",
    candidateModelsJson: [],
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
    fallbackUsed: false,
    createdAt: new Date("2026-07-07T11:00:01.000Z"),
  });
  await stores.providerAttemptLogStore.create({
    requestLogId: second,
    userId: "user-a",
    provider: "openai",
    model: "gpt-4o",
    attemptNumber: 1,
    status: "failed",
    latencyMs: 300,
    errorType: "RATE_LIMIT",
    errorMessage: "Provider rate limited.",
    createdAt: new Date("2026-07-07T11:00:01.000Z"),
  });

  const third = await stores.requestLogStore.create({
    apiKey: "key-b",
    requestedModel: "auto",
    selectedModel: "claude-3-5-sonnet",
    provider: "anthropic",
    inputTokens: 200,
    outputTokens: 100,
    estimatedCost: 2,
    latencyMs: 500,
    status: "success",
    routingMode: "rule_based",
    routingStrategy: "quality_first",
    createdAt: new Date("2026-07-08T10:00:00.000Z"),
  });
  await stores.routerDecisionLogStore.create({
    requestLogId: third,
    userId: "user-b",
    mode: "rule_based",
    candidateModelsJson: [],
    selectedModel: "claude-3-5-sonnet",
    selectedProvider: "anthropic",
    fallbackUsed: false,
    createdAt: new Date("2026-07-08T10:00:01.000Z"),
  });
}

describe("analytics routes", () => {
  const apps: Awaited<ReturnType<typeof createAnalyticsTestApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
  });

  it("returns analytics summary", async () => {
    const context = await createAnalyticsTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "GET",
      url: "/v1/analytics/summary",
    });
    const body = parseResponse<AnalyticsSummaryResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.requests).toEqual({
      total: 3,
      success: 2,
      failed: 1,
      successRate: 0.6667,
    });
    expect(body.cost.totalSpendUsd).toBe(3);
    expect(body.tokens).toEqual({ input: 300, output: 150, total: 450 });
    expect(body.latency).toEqual({ averageMs: 300, p95Ms: 500 });
    expect(body.routing).toEqual({
      fallbackUsed: 1,
      llmAssisted: 1,
      scoreBased: 1,
      ruleBased: 1,
    });
    expect(body.guardrails.budgetBlocked).toBe(1);
  });

  it("returns model analytics", async () => {
    const context = await createAnalyticsTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "GET",
      url: "/v1/analytics/models",
    });
    const body = parseResponse<ModelsResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.models[0]).toMatchObject({
      model: "gpt-4o",
      provider: "openai",
      requests: 2,
      successRate: 0.5,
      totalSpendUsd: 1,
      averageLatencyMs: 200,
    });
  });

  it("returns provider analytics", async () => {
    const context = await createAnalyticsTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "GET",
      url: "/v1/analytics/providers",
    });
    const body = parseResponse<ProvidersResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.providers[0]).toMatchObject({
      provider: "openai",
      requests: 2,
      successRate: 0.5,
      totalSpendUsd: 1,
      averageLatencyMs: 200,
    });
  });

  it("returns grouped error analytics", async () => {
    const context = await createAnalyticsTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "GET",
      url: "/v1/analytics/errors",
    });
    const body = parseResponse<ErrorsResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorMessage: "User budget exceeded.",
          provider: "openai",
          model: "gpt-4o",
          count: 1,
        }),
        expect.objectContaining({
          errorMessage: "Provider rate limited.",
          errorType: "RATE_LIMIT",
          count: 1,
        }),
      ]),
    );
  });

  it("filters analytics by date", async () => {
    const context = await createAnalyticsTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "GET",
      url: "/v1/analytics/summary?from=2026-07-08T00%3A00%3A00.000Z&to=2026-07-08T23%3A59%3A59.999Z",
    });
    const body = parseResponse<AnalyticsSummaryResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.requests.total).toBe(1);
    expect(body.cost.totalSpendUsd).toBe(2);
    expect(body.routing.ruleBased).toBe(1);
  });

  it("returns zeros for an empty dataset", async () => {
    const context = await createAnalyticsTestApp(false);
    apps.push(context);

    const response = await context.app.inject({
      method: "GET",
      url: "/v1/analytics/summary",
    });
    const body = parseResponse<AnalyticsSummaryResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.requests).toEqual({ total: 0, success: 0, failed: 0, successRate: 0 });
    expect(body.cost).toEqual({ totalSpendUsd: 0, averageCostPerRequest: 0 });
    expect(body.tokens).toEqual({ input: 0, output: 0, total: 0 });
    expect(body.latency).toEqual({ averageMs: 0, p95Ms: 0 });
  });

  it("filters analytics by userId", async () => {
    const context = await createAnalyticsTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "GET",
      url: "/v1/analytics/summary?userId=user-a",
    });
    const body = parseResponse<AnalyticsSummaryResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.requests.total).toBe(2);
    expect(body.cost.totalSpendUsd).toBe(1);
    expect(body.routing.llmAssisted).toBe(1);
    expect(body.routing.scoreBased).toBe(1);
    expect(body.routing.ruleBased).toBe(0);
  });
});
