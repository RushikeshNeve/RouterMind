import { PrismaClient } from "@prisma/client";
import type { ProviderAdapter } from "@routemind/providers";
import { afterAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { PrismaApiKeyAuthenticator } from "../infrastructure/authenticator.js";
import { PrismaRouterConfigLookup } from "../infrastructure/router-config-lookup.js";
import {
  LiveRouterLLMService,
  type RouterCredentialProviderFactory,
} from "../infrastructure/router-llm-service.js";
import type { UserAvailabilityStore } from "../infrastructure/user-availability.js";
import { encryptCredential } from "../security/credentials.js";
import { cleanupFixture, seedWorkspaceWithRole, testConfig } from "./workspaces-rbac-fixtures.js";

function parse<T>(response: { payload: string }): T {
  return JSON.parse(response.payload) as T;
}

// Canned router-decision JSON a live router-LLM call is expected to return --
// both fake adapters below return this same content, so the *only* variable
// under test is which physical adapter (and which model) the router-LLM's
// own decision-making call reached, not the final delivered completion.
const routerDecisionContent = JSON.stringify({
  detectedTask: "simple_chat",
  complexity: "low",
  selectedProvider: "openai",
  selectedModel: "gpt-4o",
  fallbackModels: [],
  reason: "test router decision",
  confidence: 0.9,
});

function fakeAdapter(providerName: string, supportedModels: readonly string[]) {
  const chatCompletion = vi.fn(
    (request: {
      readonly model: string;
      readonly estimatedUsage: { inputTokens: number; outputTokens: number };
    }) =>
      Promise.resolve({
        id: `test-${providerName}`,
        object: "chat.completion" as const,
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant" as const, content: routerDecisionContent },
            finish_reason: "stop" as const,
          },
        ],
        usage: {
          prompt_tokens: request.estimatedUsage.inputTokens,
          completion_tokens: request.estimatedUsage.outputTokens,
          total_tokens: request.estimatedUsage.inputTokens + request.estimatedUsage.outputTokens,
        },
      }),
  );
  const adapter: ProviderAdapter = {
    providerName,
    supportedModels,
    chatCompletion,
  };
  return { adapter, chatCompletion };
}

describe("RouterConfig wiring into LiveRouterLLMService", () => {
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("uses a workspace-scoped RouterConfig row's resolved provider/model/credential for the router's own decision, instead of the platform default", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");

    const rawAnthropicKey = "test-anthropic-key-12345";
    const credential = await prisma.providerCredential.create({
      data: {
        userId: fixture.userId,
        workspaceId: fixture.workspaceId,
        provider: "anthropic",
        encryptedApiKey: encryptCredential(rawAnthropicKey, testConfig.CREDENTIAL_ENCRYPTION_KEY),
        isEnabled: true,
      },
    });
    const routerConfig = await prisma.routerConfig.create({
      data: {
        scopeType: "workspace",
        scopeId: fixture.workspaceId,
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        credentialId: credential.id,
      },
    });

    const { adapter: openaiAdapter, chatCompletion: openaiChatCompletion } = fakeAdapter("openai", [
      "gpt-4o",
    ]);
    const { adapter: anthropicAdapter, chatCompletion: anthropicChatCompletion } = fakeAdapter(
      "anthropic",
      ["claude-3-5-sonnet"],
    );
    // Only reachable through LiveRouterLLMService's credential-resolution path
    // -- deliberately absent from the ambient `providers` map passed to
    // buildApp, so the assertion below can only pass if the resolved
    // credentialId was actually fetched, decrypted, and used to build a
    // fresh adapter, not silently falling back to the ambient map.
    const providerFactorySpy = vi.fn<RouterCredentialProviderFactory>(
      () => new Map([["anthropic", anthropicAdapter]]),
    );

    const availabilityStore: UserAvailabilityStore = {
      getAvailability: () =>
        Promise.resolve({
          enabledProviders: ["openai"],
          enabledModels: ["gpt-4o"],
          providerApiKeys: {},
        }),
    };

    const app = await buildApp({
      config: { ...testConfig, ROUTER_LLM_ENABLED: true },
      prisma,
      authenticator: new PrismaApiKeyAuthenticator(prisma, testConfig.DEV_API_KEY),
      availabilityStore,
      providers: new Map([["openai", openaiAdapter]]),
      routerLLMServiceFactory: (providers, context) =>
        new LiveRouterLLMService(
          testConfig,
          providers,
          new PrismaRouterConfigLookup(prisma),
          context,
          prisma,
          providerFactorySpy,
        ),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": fixture.apiKey },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello" }],
        routing: { mode: "llm_assisted", strategy: "balanced" },
      },
    });

    expect(response.statusCode).toBe(200);

    // The router's own decision-making call used the workspace's resolved
    // provider/model, not the platform default (openai/gpt-4o-mini).
    expect(anthropicChatCompletion).toHaveBeenCalledTimes(1);
    expect(anthropicChatCompletion.mock.calls[0]![0]).toMatchObject({ model: "claude-3-5-sonnet" });

    // The resolved credentialId was actually fetched and decrypted -- not
    // just the provider name matched against the ambient providers map.
    expect(providerFactorySpy).toHaveBeenCalledWith({
      openai: undefined,
      anthropic: rawAnthropicKey,
      gemini: undefined,
      groq: undefined,
    });

    // The final delivered completion is unaffected -- still comes from the
    // ambient openai adapter, since the router's returned JSON decision
    // selected openai/gpt-4o (a real deliverable candidate).
    expect(openaiChatCompletion).toHaveBeenCalled();
    const metadata = parse<{ metadata: { provider: string; selectedModel: string } }>(
      response,
    ).metadata;
    expect(metadata.provider).toBe("openai");
    expect(metadata.selectedModel).toBe("gpt-4o");

    await prisma.routerConfig.deleteMany({ where: { id: routerConfig.id } });
    await prisma.providerCredential.deleteMany({ where: { id: credential.id } });
    await cleanupFixture(prisma, fixture);
    await app.close();
  });

  it("falls back to the platform default when the workspace has no RouterConfig row", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");

    const { adapter: openaiAdapter, chatCompletion: openaiChatCompletion } = fakeAdapter("openai", [
      "gpt-4o",
      "gpt-4o-mini",
    ]);
    const providerFactorySpy = vi.fn<RouterCredentialProviderFactory>(() => new Map());

    const availabilityStore: UserAvailabilityStore = {
      getAvailability: () =>
        Promise.resolve({
          enabledProviders: ["openai"],
          enabledModels: ["gpt-4o"],
          providerApiKeys: {},
        }),
    };

    const app = await buildApp({
      config: { ...testConfig, ROUTER_LLM_ENABLED: true },
      prisma,
      authenticator: new PrismaApiKeyAuthenticator(prisma, testConfig.DEV_API_KEY),
      availabilityStore,
      providers: new Map([["openai", openaiAdapter]]),
      routerLLMServiceFactory: (providers, context) =>
        new LiveRouterLLMService(
          testConfig,
          providers,
          new PrismaRouterConfigLookup(prisma),
          context,
          prisma,
          providerFactorySpy,
        ),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": fixture.apiKey },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello" }],
        routing: { mode: "llm_assisted", strategy: "balanced" },
      },
    });

    expect(response.statusCode).toBe(200);

    // No credentialId was resolved, so the credential-specific provider
    // factory is never consulted -- the router falls straight to the
    // ambient providers map using the platform default model.
    expect(providerFactorySpy).not.toHaveBeenCalled();
    const routerDecisionCall = openaiChatCompletion.mock.calls.find(
      (call) => call[0].model === testConfig.ROUTER_LLM_MODEL,
    );
    expect(routerDecisionCall).toBeDefined();

    await cleanupFixture(prisma, fixture);
    await app.close();
  });
});
