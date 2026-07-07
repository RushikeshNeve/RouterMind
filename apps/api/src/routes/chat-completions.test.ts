import { afterEach, describe, expect, it } from "vitest";
import type { RouterLLMDecision, RouterLLMService, RouterLLMRequest } from "@routemind/routing";

import { buildApp } from "../app.js";
import type { ApiConfig } from "../config.js";
import { StaticApiKeyAuthenticator } from "../infrastructure/authenticator.js";
import { InMemoryRateLimiter } from "../infrastructure/rate-limiter.js";
import { InMemoryRequestLogStore } from "../infrastructure/request-log-store.js";
import { InMemoryRouterDecisionLogStore } from "../infrastructure/router-decision-log-store.js";
import {
  StaticUserAvailabilityStore,
  type UserProviderAvailability,
} from "../infrastructure/user-availability.js";

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

async function createTestApp() {
  return createTestAppWithAvailability({
    enabledProviders: ["openai", "anthropic", "gemini", "groq"],
    enabledModels: [
      "gpt-4o",
      "gpt-4o-mini",
      "claude-3-5-sonnet",
      "gemini-1.5-flash",
      "gemini-1.5-pro",
      "llama-3.1-70b-versatile",
    ],
    providerApiKeys: {},
  });
}

async function createTestAppWithAvailability(
  availability: UserProviderAvailability,
  options: {
    readonly routerLLMService?: RouterLLMService;
    readonly routerLLMEnabled?: boolean;
  } = {},
) {
  const requestLogStore = new InMemoryRequestLogStore();
  const routerDecisionLogStore = new InMemoryRouterDecisionLogStore();
  const app = await buildApp({
    config: {
      ...testConfig,
      ROUTER_LLM_ENABLED: options.routerLLMEnabled ?? testConfig.ROUTER_LLM_ENABLED,
    },
    authenticator: new StaticApiKeyAuthenticator("dev-key"),
    availabilityStore: new StaticUserAvailabilityStore(availability),
    rateLimiter: new InMemoryRateLimiter(),
    requestLogStore,
    routerDecisionLogStore,
    ...(options.routerLLMService
      ? {
          routerLLMServiceFactory: () => options.routerLLMService!,
        }
      : {}),
  });

  return { app, requestLogStore, routerDecisionLogStore };
}

const baseBody = {
  model: "auto",
  messages: [{ role: "user", content: "Hello" }],
  temperature: 0.7,
  stream: false,
};

interface ChatCompletionTestResponse {
  readonly metadata: {
    readonly provider: string;
    readonly selectedModel: string;
    readonly routingReason: string;
  };
  readonly routingMetadata: {
    readonly mode: string;
    readonly detectedTask: string;
    readonly complexity: string;
    readonly selectedModel?: string;
    readonly selectedProvider?: string;
    readonly availableModels: readonly string[];
    readonly fallbackUsed: boolean;
    readonly routerConfidence?: number;
    readonly routerReason: string;
    readonly hardConstraintsApplied: readonly string[];
  };
}

interface ErrorTestResponse {
  readonly error: {
    readonly message: string;
  };
}

function parseResponse<TResponse>(response: { payload: string }): TResponse {
  return JSON.parse(response.payload) as TResponse;
}

function createRouterLLMDecisionService(
  decide: (request: RouterLLMRequest) => RouterLLMDecision = (request) => {
    const selected =
      request.candidates.find((candidate) => candidate.model === "claude-3-5-sonnet") ??
      request.candidates[0]!;

    return {
      detectedTask: "debugging",
      complexity: "high",
      selectedProvider: selected.provider,
      selectedModel: selected.model,
      fallbackModels: [],
      reason: "Test Router LLM selected the strongest available debugging model.",
      confidence: 0.91,
      routerModelUsed: "mock-router-llm",
    };
  },
): RouterLLMService {
  return {
    decide: (request) => Promise.resolve(decide(request)),
  };
}

describe("chat completions route", () => {
  const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
  });

  it("rejects missing API key", async () => {
    const context = await createTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: baseBody,
    });

    expect(response.statusCode).toBe(401);
    expect(context.requestLogStore.entries).toHaveLength(1);
    expect(context.requestLogStore.entries[0]?.status).toBe("failed");
  });

  it("rejects invalid API key", async () => {
    const context = await createTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "wrong-key" },
      payload: baseBody,
    });

    expect(response.statusCode).toBe(401);
  });

  it("auto routes code prompts to Anthropic Claude Sonnet", async () => {
    const context = await createTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Help me debug this code" }],
      },
    });
    const body = parseResponse<ChatCompletionTestResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.metadata.provider).toBe("anthropic");
    expect(body.metadata.selectedModel).toBe("claude-3-5-sonnet");
    expect(body.routingMetadata.fallbackUsed).toBe(false);
  });

  it("auto routes summarize prompts to Gemini Flash", async () => {
    const context = await createTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Summarize this incident report" }],
        routing: { mode: "score_based", strategy: "balanced" },
      },
    });
    const body = parseResponse<ChatCompletionTestResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.metadata.provider).toBe("gemini");
    expect(body.metadata.selectedModel).toBe("gemini-1.5-flash");
  });

  it("auto routes unmatched prompts to the Gemini fallback", async () => {
    const context = await createTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Tell me about deployment notes" }],
        routing: { mode: "score_based", strategy: "balanced" },
      },
    });
    const body = parseResponse<ChatCompletionTestResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.metadata.provider).toBe("openai");
    expect(body.metadata.selectedModel).toBe("gpt-4o-mini");
  });

  it("rejects stream=true", async () => {
    const context = await createTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        stream: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(parseResponse<ErrorTestResponse>(response).error.message).toBe(
      "Streaming is not supported in MVP yet.",
    );
  });

  it("rejects unsupported direct models", async () => {
    const context = await createTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        model: "unknown-model",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(parseResponse<ErrorTestResponse>(response).error.message).toBe(
      "Unsupported model: unknown-model",
    );
  });

  it("routes code prompts to GPT-4o when Anthropic is unavailable", async () => {
    const context = await createTestAppWithAvailability({
      enabledProviders: ["openai", "gemini", "groq"],
      enabledModels: ["gpt-4o", "gemini-1.5-pro", "gemini-1.5-flash", "llama-3.1-70b-versatile"],
      providerApiKeys: {},
    });
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Help me debug this code" }],
        routing: { mode: "score_based", strategy: "balanced" },
      },
    });
    const body = parseResponse<ChatCompletionTestResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.routingMetadata.selectedModel).toBe("gpt-4o");
    expect(body.routingMetadata.fallbackUsed).toBe(true);
  });

  it("routes code prompts to Gemini when only Gemini models are available", async () => {
    const context = await createTestAppWithAvailability({
      enabledProviders: ["gemini"],
      enabledModels: ["gemini-1.5-flash", "gemini-1.5-pro"],
      providerApiKeys: {},
    });
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Please refactor this code" }],
        routing: { mode: "score_based", strategy: "balanced" },
      },
    });
    const body = parseResponse<ChatCompletionTestResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.routingMetadata.selectedProvider).toBe("gemini");
    expect(body.routingMetadata.selectedModel).toBe("gemini-1.5-pro");
  });

  it("returns a clear error when no models are available", async () => {
    const context = await createTestAppWithAvailability({
      enabledProviders: [],
      enabledModels: [],
      providerApiKeys: {},
    });
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: baseBody,
    });

    expect(response.statusCode).toBe(400);
    expect(parseResponse<ErrorTestResponse>(response).error.message).toBe(
      "no candidate models satisfied hard constraints",
    );
  });

  it("ignores models from disabled providers", async () => {
    const context = await createTestAppWithAvailability({
      enabledProviders: ["openai"],
      enabledModels: ["gpt-4o"],
      providerApiKeys: {},
    });
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Help me debug this code" }],
        routing: { mode: "score_based", strategy: "balanced" },
      },
    });
    const body = parseResponse<ChatCompletionTestResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.routingMetadata.selectedProvider).toBe("openai");
    expect(body.routingMetadata.availableModels).toEqual(["gpt-4o"]);
  });

  it("llm_assisted mode uses RouterLLMService", async () => {
    let callCount = 0;
    const context = await createTestAppWithAvailability(
      {
        enabledProviders: ["openai", "anthropic", "gemini", "groq"],
        enabledModels: ["gpt-4o", "claude-3-5-sonnet", "gemini-1.5-flash"],
        providerApiKeys: {},
      },
      {
        routerLLMService: createRouterLLMDecisionService((request) => {
          callCount += 1;
          const selected = request.candidates.find((candidate) => candidate.model === "gpt-4o")!;
          return {
            detectedTask: "reasoning",
            complexity: "high",
            selectedProvider: selected.provider,
            selectedModel: selected.model,
            fallbackModels: [],
            reason: "LLM chose GPT-4o for reasoning.",
            confidence: 0.88,
            routerModelUsed: "gpt-4o-mini",
          };
        }),
      },
    );
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Analyze this architecture tradeoff" }],
      },
    });
    const body = parseResponse<ChatCompletionTestResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(callCount).toBe(1);
    expect(body.routingMetadata.mode).toBe("llm_assisted");
    expect(body.routingMetadata.selectedModel).toBe("gpt-4o");
  });

  it("does not pass disabled models to RouterLLMService candidates", async () => {
    let candidateModels: readonly string[] = [];
    const context = await createTestAppWithAvailability(
      {
        enabledProviders: ["openai", "gemini"],
        enabledModels: ["gpt-4o", "gemini-1.5-flash"],
        providerApiKeys: {},
      },
      {
        routerLLMService: createRouterLLMDecisionService((request) => {
          candidateModels = request.candidates.map((candidate) => candidate.model);
          const selected = request.candidates[0]!;
          return {
            detectedTask: "debugging",
            complexity: "medium",
            selectedProvider: selected.provider,
            selectedModel: selected.model,
            fallbackModels: [],
            reason: "Selected first valid candidate.",
            confidence: 0.7,
          };
        }),
      },
    );
    apps.push(context);

    await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Debug this code" }],
      },
    });

    expect(candidateModels).not.toContain("claude-3-5-sonnet");
    expect([...candidateModels].sort()).toEqual(["gemini-1.5-flash", "gpt-4o"]);
  });

  it("falls back to score_based when Router LLM selects an invalid model", async () => {
    const context = await createTestAppWithAvailability(
      {
        enabledProviders: ["openai", "anthropic"],
        enabledModels: ["gpt-4o", "claude-3-5-sonnet"],
        providerApiKeys: {},
      },
      {
        routerLLMService: createRouterLLMDecisionService(() => ({
          detectedTask: "debugging",
          complexity: "high",
          selectedProvider: "gemini",
          selectedModel: "gemini-1.5-flash",
          fallbackModels: [],
          reason: "Invalid candidate for test.",
          confidence: 0.99,
        })),
      },
    );
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Debug a distributed race condition in this code" }],
      },
    });
    const body = parseResponse<ChatCompletionTestResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.routingMetadata.mode).toBe("score_based");
    expect(body.routingMetadata.routerReason).toContain("Router LLM skipped or invalid");
  });

  it("skips Router LLM for simple cost_first prompts", async () => {
    let callCount = 0;
    const context = await createTestAppWithAvailability(
      {
        enabledProviders: ["openai", "gemini"],
        enabledModels: ["gpt-4o-mini", "gemini-1.5-flash"],
        providerApiKeys: {},
      },
      {
        routerLLMService: createRouterLLMDecisionService((request) => {
          callCount += 1;
          const selected = request.candidates[0]!;
          return {
            detectedTask: "simple_chat",
            complexity: "low",
            selectedProvider: selected.provider,
            selectedModel: selected.model,
            fallbackModels: [],
            reason: "Should not be called.",
            confidence: 0.5,
          };
        }),
      },
    );
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Hi" }],
        routing: { mode: "llm_assisted", strategy: "cost_first" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(callCount).toBe(0);
  });

  it("selects a stronger model for high-complexity debugging prompts", async () => {
    const context = await createTestAppWithAvailability({
      enabledProviders: ["openai", "anthropic", "gemini"],
      enabledModels: ["gpt-4o", "claude-3-5-sonnet", "gemini-1.5-flash"],
      providerApiKeys: {},
    });
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [
          {
            role: "user",
            content:
              "Debug this distributed system race condition and explain the architecture implications in detail.",
          },
        ],
      },
    });
    const body = parseResponse<ChatCompletionTestResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(["claude-3-5-sonnet", "gpt-4o"]).toContain(body.routingMetadata.selectedModel);
    expect(body.routingMetadata.complexity).toBe("high");
  });

  it("metadata includes router decision details", async () => {
    const context = await createTestApp();
    apps.push(context);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        ...baseBody,
        messages: [{ role: "user", content: "Help me debug this code" }],
      },
    });
    const body = parseResponse<ChatCompletionTestResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.routingMetadata.detectedTask).toBeTruthy();
    expect(body.routingMetadata.routerReason).toBeTruthy();
    expect(body.routingMetadata.hardConstraintsApplied).toEqual(expect.any(Array));
  });
});
