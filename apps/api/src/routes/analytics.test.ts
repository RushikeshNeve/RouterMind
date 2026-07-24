import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryExecutionPlanLogStore } from "../infrastructure/execution-plan-log-store.js";
import { InMemoryProviderAttemptLogStore } from "../infrastructure/provider-attempt-log-store.js";
import { InMemoryRequestLogStore } from "../infrastructure/request-log-store.js";
import { InMemoryRouterDecisionLogStore } from "../infrastructure/router-decision-log-store.js";
import {
  cleanupFixture,
  createPrismaWorkspaceTestApp,
  seedWorkspaceWithRole,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

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

describe("analytics routes (workspace-scoped)", () => {
  const prisma = new PrismaClient({
    datasourceUrl: "postgresql://routemind:routemind@localhost:5432/routemind?schema=public",
  });
  const apps: FastifyInstance[] = [];
  const fixtures: WorkspaceRoleFixture[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(prisma, fixture)));
  });

  async function seedAnalyticsData(
    stores: {
      readonly requestLogStore: InMemoryRequestLogStore;
      readonly routerDecisionLogStore: InMemoryRouterDecisionLogStore;
      readonly providerAttemptLogStore: InMemoryProviderAttemptLogStore;
      readonly executionPlanLogStore: InMemoryExecutionPlanLogStore;
    },
    workspaceId: string,
  ) {
    const first = await stores.requestLogStore.create({
      workspaceId,
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
      workspaceId,
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
      workspaceId,
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
      workspaceId,
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
      workspaceId,
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
      workspaceId,
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
      workspaceId,
      userId: "user-b",
      mode: "rule_based",
      candidateModelsJson: [],
      selectedModel: "claude-3-5-sonnet",
      selectedProvider: "anthropic",
      fallbackUsed: false,
      createdAt: new Date("2026-07-08T10:00:01.000Z"),
    });
  }

  async function setup(roleName: string) {
    const fixture = await seedWorkspaceWithRole(prisma, roleName);
    fixtures.push(fixture);
    const requestLogStore = new InMemoryRequestLogStore();
    const routerDecisionLogStore = new InMemoryRouterDecisionLogStore();
    const providerAttemptLogStore = new InMemoryProviderAttemptLogStore();
    const executionPlanLogStore = new InMemoryExecutionPlanLogStore();
    await seedAnalyticsData(
      { requestLogStore, routerDecisionLogStore, providerAttemptLogStore, executionPlanLogStore },
      fixture.workspaceId,
    );
    const { app } = await createPrismaWorkspaceTestApp(prisma, {
      requestLogStore,
      routerDecisionLogStore,
      providerAttemptLogStore,
      executionPlanLogStore,
    });
    apps.push(app);
    return { app, fixture };
  }

  it("returns analytics summary for the caller's own workspace", async () => {
    const { app, fixture } = await setup("Owner");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/analytics/summary`,
      headers: { "x-api-key": fixture.apiKey },
    });
    const body = parseResponse<AnalyticsSummaryResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.requests).toEqual({ total: 3, success: 2, failed: 1, successRate: 0.6667 });
    expect(body.cost.totalSpendUsd).toBe(3);
    expect(body.routing).toEqual({
      fallbackUsed: 1,
      llmAssisted: 1,
      scoreBased: 1,
      ruleBased: 1,
    });
    expect(body.guardrails.budgetBlocked).toBe(1);
  });

  it("returns model analytics for the caller's own workspace", async () => {
    const { app, fixture } = await setup("Owner");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/analytics/models`,
      headers: { "x-api-key": fixture.apiKey },
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

  it("returns provider analytics for the caller's own workspace", async () => {
    const { app, fixture } = await setup("Owner");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/analytics/providers`,
      headers: { "x-api-key": fixture.apiKey },
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

  it("returns grouped error analytics for the caller's own workspace", async () => {
    const { app, fixture } = await setup("Owner");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/analytics/errors`,
      headers: { "x-api-key": fixture.apiKey },
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

  it("filters analytics by date within the caller's own workspace", async () => {
    const { app, fixture } = await setup("Owner");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/analytics/summary?from=2026-07-08T00%3A00%3A00.000Z&to=2026-07-08T23%3A59%3A59.999Z`,
      headers: { "x-api-key": fixture.apiKey },
    });
    const body = parseResponse<AnalyticsSummaryResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.requests.total).toBe(1);
    expect(body.cost.totalSpendUsd).toBe(2);
    expect(body.routing.ruleBased).toBe(1);
  });

  it("returns zeros for a workspace with no data", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(fixture);
    const { app } = await createPrismaWorkspaceTestApp(prisma, {
      requestLogStore: new InMemoryRequestLogStore(),
      routerDecisionLogStore: new InMemoryRouterDecisionLogStore(),
      providerAttemptLogStore: new InMemoryProviderAttemptLogStore(),
      executionPlanLogStore: new InMemoryExecutionPlanLogStore(),
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/analytics/summary`,
      headers: { "x-api-key": fixture.apiKey },
    });
    const body = parseResponse<AnalyticsSummaryResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.requests).toEqual({ total: 0, success: 0, failed: 0, successRate: 0 });
    expect(body.cost).toEqual({ totalSpendUsd: 0, averageCostPerRequest: 0 });
  });

  it("filters analytics by userId within the caller's own workspace", async () => {
    const { app, fixture } = await setup("Owner");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/analytics/summary?userId=user-a`,
      headers: { "x-api-key": fixture.apiKey },
    });
    const body = parseResponse<AnalyticsSummaryResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.requests.total).toBe(2);
    expect(body.cost.totalSpendUsd).toBe(1);
  });

  it("rejects an unauthenticated request", async () => {
    const { app, fixture } = await setup("Owner");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/analytics/summary`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a caller whose key belongs to a different workspace (cross-tenant isolation)", async () => {
    const { fixture: fixtureA } = await setup("Owner");
    const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(fixtureB);

    // fixtureA's app only has fixtureA's data seeded into its in-memory
    // stores -- reusing fixtureA's app (not fixtureB's) to prove fixtureB's
    // *key* cannot read fixtureA's workspace data, purely via RBAC, before
    // any data-shape question even comes into play.
    const { app: appA } = await createPrismaWorkspaceTestApp(prisma);
    apps.push(appA);

    const response = await appA.inject({
      method: "GET",
      url: `/v1/workspaces/${fixtureA.workspaceId}/analytics/summary`,
      headers: { "x-api-key": fixtureB.apiKey },
    });

    expect(response.statusCode).toBe(403);
  });

  it("isolates data between two workspaces -- one workspace's requests never appear in another's summary", async () => {
    const requestLogStoreA = new InMemoryRequestLogStore();
    const routerDecisionLogStoreA = new InMemoryRouterDecisionLogStore();
    const providerAttemptLogStoreA = new InMemoryProviderAttemptLogStore();
    const executionPlanLogStoreA = new InMemoryExecutionPlanLogStore();

    const fixtureA = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(fixtureA);
    const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(fixtureB);

    // Both workspaces' rows share one set of in-memory stores (as the real
    // PrismaAnalyticsService would share one Postgres table) -- the only
    // thing keeping them apart is the workspaceId filter the route now
    // always injects from the validated path param.
    await seedAnalyticsData(
      {
        requestLogStore: requestLogStoreA,
        routerDecisionLogStore: routerDecisionLogStoreA,
        providerAttemptLogStore: providerAttemptLogStoreA,
        executionPlanLogStore: executionPlanLogStoreA,
      },
      fixtureA.workspaceId,
    );
    // A single extra request for workspace B, distinguishable by cost.
    await requestLogStoreA.create({
      workspaceId: fixtureB.workspaceId,
      apiKey: "key-b-only",
      requestedModel: "auto",
      selectedModel: "gpt-4o",
      provider: "openai",
      estimatedCost: 999,
      latencyMs: 50,
      status: "success",
      routingMode: "rule_based",
      routingStrategy: "balanced",
      createdAt: new Date("2026-07-09T10:00:00.000Z"),
    });

    const { app } = await createPrismaWorkspaceTestApp(prisma, {
      requestLogStore: requestLogStoreA,
      routerDecisionLogStore: routerDecisionLogStoreA,
      providerAttemptLogStore: providerAttemptLogStoreA,
      executionPlanLogStore: executionPlanLogStoreA,
    });
    apps.push(app);

    const responseA = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixtureA.workspaceId}/analytics/summary`,
      headers: { "x-api-key": fixtureA.apiKey },
    });
    const bodyA = parseResponse<AnalyticsSummaryResponse>(responseA);
    expect(responseA.statusCode).toBe(200);
    expect(bodyA.requests.total).toBe(3);
    expect(bodyA.cost.totalSpendUsd).toBe(3);

    const responseB = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixtureB.workspaceId}/analytics/summary`,
      headers: { "x-api-key": fixtureB.apiKey },
    });
    const bodyB = parseResponse<AnalyticsSummaryResponse>(responseB);
    expect(responseB.statusCode).toBe(200);
    expect(bodyB.requests.total).toBe(1);
    expect(bodyB.cost.totalSpendUsd).toBe(999);
  });

  it("Viewer role can read analytics (analytics.read is granted to every role)", async () => {
    const { app, fixture } = await setup("Viewer");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/analytics/summary`,
      headers: { "x-api-key": fixture.apiKey },
    });

    expect(response.statusCode).toBe(200);
  });
});
