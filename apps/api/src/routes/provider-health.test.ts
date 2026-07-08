import { afterEach, describe, expect, it } from "vitest";
import type { ChatCompletionRequest, ProviderResponse } from "@routemind/core";
import { ProviderError, type ProviderAdapter } from "@routemind/providers";
import type { RouterLLMDecision, RouterLLMRequest, RouterLLMService } from "@routemind/routing";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import type { ApiConfig } from "../config.js";
import { StaticApiKeyAuthenticator } from "../infrastructure/authenticator.js";
import { InMemoryProviderHealthService } from "../infrastructure/provider-health-service.js";
import { InMemoryRateLimiter } from "../infrastructure/rate-limiter.js";
import { InMemoryRequestLogStore } from "../infrastructure/request-log-store.js";
import { RetryPolicyService } from "../infrastructure/retry-policy-service.js";
import { InMemoryRouterDecisionLogStore } from "../infrastructure/router-decision-log-store.js";
import { StaticUserAvailabilityStore } from "../infrastructure/user-availability.js";

const testConfig: ApiConfig = {
  DATABASE_URL: "postgresql://routemind:routemind@localhost:5432/routemind?schema=public",
  DEV_API_KEY: "dev-key",
  CREDENTIAL_ENCRYPTION_KEY: "development-credential-key-change-me",
  LOG_LEVEL: "silent",
  NODE_ENV: "test",
  PORT: 3000,
  PROVIDER_MODE: "mock",
  PROVIDER_TIMEOUT_MS: 30_000,
  ROUTER_LLM_ENABLED: true,
  ROUTER_LLM_MAX_TOKENS: 300,
  ROUTER_LLM_MODEL: "gpt-4o-mini",
  REDIS_URL: "redis://localhost:6379",
};

const baseBody = {
  model: "auto",
  messages: [{ role: "user", content: "Help me debug this code" }],
  stream: false,
  routing: { mode: "score_based", strategy: "balanced" },
};

class TestProvider implements ProviderAdapter {
  constructor(
    readonly providerName: string,
    readonly supportedModels: readonly string[],
    private readonly behavior: "success" | "timeout" | "rate_limit" = "success",
  ) {}

  chatCompletion(request: ChatCompletionRequest): Promise<ProviderResponse> {
    if (this.behavior === "timeout") {
      throw new ProviderError("timeout", "Provider timed out.", 504);
    }

    if (this.behavior === "rate_limit") {
      throw new ProviderError("rate_limit", "Provider rate limited.", 429);
    }

    return Promise.resolve({
      id: "chatcmpl_test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: request.estimatedUsage.inputTokens,
        completion_tokens: request.estimatedUsage.outputTokens,
        total_tokens: request.estimatedUsage.inputTokens + request.estimatedUsage.outputTokens,
      },
    });
  }
}

interface ChatResponse {
  readonly routingMetadata: {
    readonly selectedModel?: string;
    readonly availableModels: readonly string[];
    readonly hardConstraintsApplied: readonly string[];
  };
}

interface HealthResponse {
  readonly provider: string;
  readonly models: readonly {
    readonly model: string;
    readonly status: string;
    readonly avgLatencyMs: number;
    readonly p95LatencyMs: number;
    readonly successRate: number;
    readonly errorRate: number;
    readonly timeoutRate: number;
    readonly rateLimitRate: number;
    readonly sampleSize: number;
    readonly lastCheckedAt: string;
  }[];
}

function parseResponse<TResponse>(response: { payload: string }): TResponse {
  return JSON.parse(response.payload) as TResponse;
}

async function createHealthTestApp(
  options: {
    readonly providerHealthService?: InMemoryProviderHealthService;
    readonly providers?: Map<string, ProviderAdapter>;
    readonly routerLLMService?: RouterLLMService;
    readonly routerLLMEnabled?: boolean;
    readonly enabledProviders?: readonly string[];
    readonly enabledModels?: readonly string[];
  } = {},
) {
  const providerHealthService =
    options.providerHealthService ?? new InMemoryProviderHealthService();
  const app = await buildApp({
    config: {
      ...testConfig,
      ROUTER_LLM_ENABLED: options.routerLLMEnabled ?? testConfig.ROUTER_LLM_ENABLED,
    },
    authenticator: new StaticApiKeyAuthenticator("dev-key"),
    availabilityStore: new StaticUserAvailabilityStore({
      enabledProviders: options.enabledProviders ?? ["openai", "anthropic"],
      enabledModels: options.enabledModels ?? ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet"],
      providerApiKeys: {},
    }),
    rateLimiter: new InMemoryRateLimiter(),
    requestLogStore: new InMemoryRequestLogStore(),
    routerDecisionLogStore: new InMemoryRouterDecisionLogStore(),
    providerHealthService,
    retryPolicyService: new RetryPolicyService(undefined, undefined, async () => undefined),
    providers:
      options.providers ??
      new Map([
        ["openai", new TestProvider("openai", ["gpt-4o", "gpt-4o-mini"])],
        ["anthropic", new TestProvider("anthropic", ["claude-3-5-sonnet"])],
      ]),
    ...(options.routerLLMService
      ? { routerLLMServiceFactory: () => options.routerLLMService! }
      : {}),
  });

  return { app, providerHealthService };
}

describe("provider health monitoring", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("successful provider request updates health metrics", async () => {
    const { app, providerHealthService } = await createHealthTestApp({
      enabledProviders: ["openai"],
      enabledModels: ["gpt-4o-mini"],
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: baseBody,
    });
    const metric = await providerHealthService.get("openai", "gpt-4o-mini");

    expect(response.statusCode).toBe(200);
    expect(metric).toMatchObject({
      status: "healthy",
      successRate: 1,
      errorRate: 0,
      sampleSize: 1,
    });
  });

  it("failed provider request updates error rate", async () => {
    const { app, providerHealthService } = await createHealthTestApp({
      enabledProviders: ["openai"],
      enabledModels: ["gpt-4o-mini"],
      providers: new Map([["openai", new TestProvider("openai", ["gpt-4o-mini"], "rate_limit")]]),
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: baseBody,
    });
    const metric = await providerHealthService.get("openai", "gpt-4o-mini");

    expect(response.statusCode).toBe(502);
    expect(metric).toMatchObject({
      status: "down",
      successRate: 0,
      errorRate: 1,
      rateLimitRate: 1,
    });
  });

  it("timeout updates timeout rate", async () => {
    const { app, providerHealthService } = await createHealthTestApp({
      enabledProviders: ["openai"],
      enabledModels: ["gpt-4o-mini"],
      providers: new Map([["openai", new TestProvider("openai", ["gpt-4o-mini"], "timeout")]]),
    });
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: baseBody,
    });
    const metric = await providerHealthService.get("openai", "gpt-4o-mini");

    expect(metric?.timeoutRate).toBe(1);
    expect(metric?.status).toBe("down");
  });

  it("down provider model is excluded from candidates", async () => {
    const providerHealthService = new InMemoryProviderHealthService();
    await providerHealthService.record({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      latencyMs: 100,
      success: false,
      errorCode: "timeout",
      timestamp: new Date(),
    });
    const { app } = await createHealthTestApp({ providerHealthService });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: baseBody,
    });
    const body = parseResponse<ChatResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.routingMetadata.selectedModel).toBe("gpt-4o");
    expect(body.routingMetadata.availableModels).not.toContain("claude-3-5-sonnet");
    expect(body.routingMetadata.hardConstraintsApplied).toContain("model down:claude-3-5-sonnet");
  });

  it("degraded provider is penalized but not fully excluded", async () => {
    const providerHealthService = new InMemoryProviderHealthService();
    await providerHealthService.record({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      latencyMs: 9_500,
      success: true,
      timestamp: new Date(),
    });
    const { app } = await createHealthTestApp({ providerHealthService });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: baseBody,
    });
    const body = parseResponse<ChatResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.routingMetadata.availableModels).toContain("claude-3-5-sonnet");
    expect(body.routingMetadata.selectedModel).toBe("gpt-4o");
  });

  it("health API returns dashboard-ready data", async () => {
    const providerHealthService = new InMemoryProviderHealthService();
    await providerHealthService.record({
      provider: "openai",
      model: "gpt-4o",
      latencyMs: 2200,
      success: true,
      timestamp: new Date(),
    });
    const { app } = await createHealthTestApp({ providerHealthService });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/health/providers/openai",
    });
    const body = parseResponse<HealthResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      provider: "openai",
      models: [
        expect.objectContaining({
          model: "gpt-4o",
          status: "healthy",
          avgLatencyMs: 2200,
          p95LatencyMs: 2200,
          successRate: 1,
          errorRate: 0,
          sampleSize: 1,
        }),
      ],
    });
    expect(body.models[0]?.lastCheckedAt).toEqual(expect.any(String));
  });

  it("Router LLM receives live metrics", async () => {
    const providerHealthService = new InMemoryProviderHealthService();
    await providerHealthService.record({
      provider: "openai",
      model: "gpt-4o",
      latencyMs: 2200,
      success: true,
      timestamp: new Date(),
    });
    let routerRequest: RouterLLMRequest | undefined;
    const routerLLMService: RouterLLMService = {
      decide: (request) => {
        routerRequest = request;
        const selected = request.candidates.find((candidate) => candidate.model === "gpt-4o")!;
        const decision: RouterLLMDecision = {
          detectedTask: "debugging",
          complexity: "medium",
          selectedProvider: selected.provider,
          selectedModel: selected.model,
          fallbackModels: [],
          reason: "Use healthy OpenAI.",
          confidence: 0.8,
        };
        return Promise.resolve(decision);
      },
    };
    const { app } = await createHealthTestApp({
      providerHealthService,
      routerLLMService,
      enabledProviders: ["openai"],
      enabledModels: ["gpt-4o"],
    });
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        routing: { mode: "llm_assisted", strategy: "balanced" },
      },
    });

    expect(routerRequest?.candidates[0]?.metrics).toMatchObject({
      status: "healthy",
      avgLatencyMs: 2200,
      successRate: 1,
    });
  });

  it("score_based routing uses live reliability and latency", async () => {
    const providerHealthService = new InMemoryProviderHealthService();
    await providerHealthService.record({
      provider: "openai",
      model: "gpt-4o",
      latencyMs: 300,
      success: true,
      timestamp: new Date(),
    });
    await providerHealthService.record({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      latencyMs: 9000,
      success: true,
      timestamp: new Date(),
    });
    const { app } = await createHealthTestApp({ providerHealthService });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: baseBody,
    });
    const body = parseResponse<ChatResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.routingMetadata.selectedModel).toBe("gpt-4o");
  });
});
