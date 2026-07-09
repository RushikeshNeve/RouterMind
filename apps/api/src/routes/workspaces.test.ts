import { afterEach, describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@routemind/providers";
import { buildApp } from "../app.js";
import type { ApiConfig } from "../config.js";
import { InMemoryAnalyticsService } from "../infrastructure/analytics-service.js";
import { InMemoryExecutionPlanLogStore } from "../infrastructure/execution-plan-log-store.js";
import { InMemoryProviderAttemptLogStore } from "../infrastructure/provider-attempt-log-store.js";
import { InMemoryRateLimiter } from "../infrastructure/rate-limiter.js";
import { InMemoryRequestLogStore } from "../infrastructure/request-log-store.js";
import { RetryPolicyService } from "../infrastructure/retry-policy-service.js";
import { InMemoryRouterDecisionLogStore } from "../infrastructure/router-decision-log-store.js";
import type { UserAvailabilityStore } from "../infrastructure/user-availability.js";
import { InMemoryWorkspaceService } from "../infrastructure/workspace-service.js";

const testConfig: ApiConfig = {
  DATABASE_URL: "postgresql://routemind:routemind@localhost:5432/routemind?schema=public",
  DEV_API_KEY: "dev-key",
  CREDENTIAL_ENCRYPTION_KEY: "development-credential-key-change-me",
  LOG_LEVEL: "silent",
  NODE_ENV: "test",
  PORT: 3000,
  PROVIDER_MODE: "mock",
  PROVIDER_TIMEOUT_MS: 30_000,
  ROUTER_LLM_ENABLED: false,
  ROUTER_LLM_MAX_TOKENS: 300,
  ROUTER_LLM_MODEL: "gpt-4o-mini",
  REDIS_URL: "redis://localhost:6379",
};

function parse<T>(response: { payload: string }): T {
  return JSON.parse(response.payload) as T;
}

describe("workspace routes", () => {
  const apps: Awaited<ReturnType<typeof createWorkspaceTestApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
  });

  it("creates a workspace and adds a member", async () => {
    const context = await createWorkspaceTestApp();
    apps.push(context);

    const created = await context.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name: "Acme AI", ownerUserId: "owner-user" },
    });
    const workspace = parse<{ workspace: { id: string; slug: string } }>(created).workspace;
    const member = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/members`,
      payload: { userId: "dev-user-2", role: "developer", actorUserId: "owner-user" },
    });

    expect(created.statusCode).toBe(201);
    expect(workspace.slug).toBe("acme-ai");
    expect(member.statusCode).toBe(201);
    expect(parse<{ member: { role: string } }>(member).member.role).toBe("developer");
  });

  it("enforces role permissions for API key management", async () => {
    const context = await createWorkspaceTestApp();
    apps.push(context);
    const workspace = await context.workspaceService.createWorkspace({
      name: "Security Team",
      ownerUserId: "owner-user",
    });
    await context.workspaceService.addMember({
      workspaceId: workspace.id,
      userId: "viewer-user",
      role: "viewer",
    });

    const response = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/api-keys`,
      payload: { userId: "viewer-user", name: "viewer key" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("authenticates workspace API keys and attaches workspace context", async () => {
    const context = await createWorkspaceTestApp();
    apps.push(context);
    const workspace = await context.workspaceService.createWorkspace({
      name: "Platform",
      ownerUserId: "owner-user",
    });
    const keyResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/api-keys`,
      payload: { userId: "owner-user", name: "gateway" },
    });
    const { apiKey } = parse<{ apiKey: string }>(keyResponse);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": apiKey },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello workspace" }],
        cache: { mode: "disabled" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(context.availabilityWorkspaceIds).toEqual([workspace.id]);
    expect(context.requestLogStore.entries[0]?.workspaceId).toBe(workspace.id);
  });

  it("blocks workspace requests with workspace-level budget checks", async () => {
    const context = await createWorkspaceTestApp({
      costGuardrailService: {
        checkBeforeRequest: (input) =>
          Promise.resolve(
            input.workspaceId
              ? {
                  allowed: false,
                  errorCode: "BUDGET_EXCEEDED",
                  message: "Workspace budget exceeded.",
                }
              : { allowed: true },
          ),
        recordUsage: () => Promise.resolve(),
      },
    });
    apps.push(context);
    const workspace = await context.workspaceService.createWorkspace({
      name: "Finance",
      ownerUserId: "owner-user",
    });
    const { apiKey } = await context.workspaceService.createApiKey({
      workspaceId: workspace.id,
      userId: "owner-user",
      name: "budget key",
      nodeEnv: "test",
    });

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": apiKey },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(parse<{ error: { message: string } }>(response).error.message).toContain(
      "Workspace budget",
    );
  });

  it("filters analytics by workspaceId", async () => {
    const context = await createWorkspaceTestApp();
    apps.push(context);
    await context.requestLogStore.create({
      workspaceId: "workspace-a",
      apiKey: "a",
      requestedModel: "auto",
      selectedModel: "gpt-4o",
      provider: "openai",
      latencyMs: 10,
      status: "success",
    });
    await context.requestLogStore.create({
      workspaceId: "workspace-b",
      apiKey: "b",
      requestedModel: "auto",
      selectedModel: "gpt-4o",
      provider: "openai",
      latencyMs: 10,
      status: "success",
    });

    const response = await context.app.inject({
      method: "GET",
      url: "/v1/analytics/summary?workspaceId=workspace-a",
    });

    expect(response.statusCode).toBe(200);
    expect(parse<{ requests: { total: number } }>(response).requests.total).toBe(1);
  });
});

async function createWorkspaceTestApp(
  options: {
    readonly costGuardrailService?: {
      checkBeforeRequest(input: {
        userId: string;
        workspaceId?: string;
        estimatedCostUsd: number;
        estimatedTokens: number;
        maxEstimatedCostUsd?: number;
      }): Promise<{ allowed: boolean; errorCode?: "BUDGET_EXCEEDED"; message?: string }>;
      recordUsage(input: {
        userId: string;
        workspaceId?: string;
        actualCostUsd: number;
        totalTokens: number;
      }): Promise<void>;
    };
  } = {},
) {
  const workspaceService = new InMemoryWorkspaceService();
  const requestLogStore = new InMemoryRequestLogStore();
  const routerDecisionLogStore = new InMemoryRouterDecisionLogStore();
  const providerAttemptLogStore = new InMemoryProviderAttemptLogStore();
  const executionPlanLogStore = new InMemoryExecutionPlanLogStore();
  const availabilityWorkspaceIds: Array<string | undefined> = [];
  const availabilityStore: UserAvailabilityStore = {
    getAvailability: (user) => {
      availabilityWorkspaceIds.push(user.workspaceId);
      return Promise.resolve({
        enabledProviders: ["openai"],
        enabledModels: ["gpt-4o"],
        providerApiKeys: {},
      });
    },
  };
  const provider: ProviderAdapter = {
    providerName: "openai",
    supportedModels: ["gpt-4o"],
    chatCompletion: (request) =>
      Promise.resolve({
        id: "workspace-chat",
        object: "chat.completion",
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
  };
  const analyticsService = new InMemoryAnalyticsService(
    requestLogStore,
    routerDecisionLogStore,
    providerAttemptLogStore,
    executionPlanLogStore,
  );
  const app = await buildApp({
    config: testConfig,
    workspaceService,
    requestLogStore,
    routerDecisionLogStore,
    providerAttemptLogStore,
    executionPlanLogStore,
    analyticsService,
    availabilityStore,
    rateLimiter: new InMemoryRateLimiter(),
    retryPolicyService: new RetryPolicyService(undefined, undefined, () => Promise.resolve()),
    providers: new Map([["openai", provider]]),
    costGuardrailService: options.costGuardrailService ?? {
      checkBeforeRequest: () => Promise.resolve({ allowed: true }),
      recordUsage: () => Promise.resolve(),
    },
  });

  return {
    app,
    workspaceService,
    requestLogStore,
    availabilityWorkspaceIds,
  };
}
