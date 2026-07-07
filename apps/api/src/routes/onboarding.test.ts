import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthenticatedUser, ApiKeyAuthenticator } from "../infrastructure/authenticator.js";
import { buildApp } from "../app.js";
import type { ApiConfig } from "../config.js";
import { InMemoryOnboardingStore } from "../infrastructure/onboarding-store.js";
import { InMemoryRateLimiter } from "../infrastructure/rate-limiter.js";
import { InMemoryRequestLogStore } from "../infrastructure/request-log-store.js";
import { InMemoryRouterDecisionLogStore } from "../infrastructure/router-decision-log-store.js";
import type {
  UserAvailabilityStore,
  UserProviderAvailability,
} from "../infrastructure/user-availability.js";
import { hashApiKey } from "../security/api-key.js";

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

interface UserResponse {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly createdAt: string;
}

interface ApiKeyResponse {
  readonly apiKey: string;
  readonly name: string;
  readonly createdAt: string;
}

interface ProviderCredentialResponse {
  readonly id: string;
  readonly provider: string;
  readonly isEnabled: boolean;
  readonly createdAt: string;
}

interface AvailableModelsResponse {
  readonly userId: string;
  readonly models: readonly {
    readonly provider: string;
    readonly model: string;
    readonly enabled: boolean;
    readonly capabilities: readonly string[];
    readonly costTier: string;
    readonly latencyTier: string;
    readonly qualityTier: string;
  }[];
}

interface ChatCompletionResponse {
  readonly routingMetadata: {
    readonly selectedModel?: string;
    readonly availableModels: readonly string[];
  };
}

function parseResponse<TResponse>(response: { payload: string }): TResponse {
  return JSON.parse(response.payload) as TResponse;
}

class StoreBackedAuthenticator implements ApiKeyAuthenticator {
  constructor(private readonly store: InMemoryOnboardingStore) {}

  authenticate(apiKey: string): Promise<AuthenticatedUser | undefined> {
    const record = this.store.apiKeys.find(
      (item) => item.keyHash === hashApiKey(apiKey) && item.isActive,
    );
    const user = record
      ? this.store.users.find((candidate) => candidate.id === record.userId)
      : undefined;

    if (!record || !user) {
      return Promise.resolve(undefined);
    }

    return Promise.resolve({
      id: user.id,
      name: user.name,
      email: user.email,
      apiKey,
    });
  }
}

class StoreBackedAvailabilityStore implements UserAvailabilityStore {
  constructor(private readonly store: InMemoryOnboardingStore) {}

  getAvailability(user: AuthenticatedUser): Promise<UserProviderAvailability> {
    const enabledProviders = this.store.providerCredentials
      .filter((credential) => credential.userId === user.id && credential.isEnabled)
      .map((credential) => credential.provider);
    const enabledModels = this.store.modelAccess
      .filter(
        (access) =>
          access.userId === user.id &&
          access.isEnabled &&
          enabledProviders.includes(access.provider),
      )
      .map((access) => access.model);

    return Promise.resolve({
      enabledProviders,
      enabledModels,
      providerApiKeys: {},
    });
  }
}

async function createOnboardingTestApp() {
  const onboardingStore = new InMemoryOnboardingStore();
  const app = await buildApp({
    config: testConfig,
    onboardingStore,
    authenticator: new StoreBackedAuthenticator(onboardingStore),
    availabilityStore: new StoreBackedAvailabilityStore(onboardingStore),
    rateLimiter: new InMemoryRateLimiter(),
    requestLogStore: new InMemoryRequestLogStore(),
    routerDecisionLogStore: new InMemoryRouterDecisionLogStore(),
  });

  return { app, onboardingStore };
}

describe("onboarding routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("creates a user", async () => {
    const { app } = await createOnboardingTestApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: {
        name: "Rushikesh",
        email: "rushikesh@example.com",
      },
    });
    const body = parseResponse<UserResponse>(response);

    expect(response.statusCode).toBe(201);
    expect(body).toMatchObject({
      name: "Rushikesh",
      email: "rushikesh@example.com",
    });
    expect(body.id).toBeTruthy();
  });

  it("creates an API key, returns the raw key once, and stores only its hash", async () => {
    const { app, onboardingStore } = await createOnboardingTestApp();
    apps.push(app);
    const user = await onboardingStore.createUser({
      name: "Rushikesh",
      email: "rushikesh@example.com",
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      payload: {
        userId: user.id,
        name: "Local Dev Key",
      },
    });
    const body = parseResponse<ApiKeyResponse>(response);

    expect(response.statusCode).toBe(201);
    expect(body.apiKey).toMatch(/^rm_test_/);
    expect(body.name).toBe("Local Dev Key");
    expect(onboardingStore.apiKeys).toHaveLength(1);
    expect(onboardingStore.apiKeys[0]?.keyHash).toBe(hashApiKey(body.apiKey));
    expect(JSON.stringify(onboardingStore.apiKeys)).not.toContain(body.apiKey);
    expect(JSON.stringify(body)).not.toContain("keyHash");
  });

  it("rejects invalid API keys for chat completions", async () => {
    const { app } = await createOnboardingTestApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("stores provider credentials encrypted and never returns the raw provider key", async () => {
    const { app, onboardingStore } = await createOnboardingTestApp();
    apps.push(app);
    const user = await onboardingStore.createUser({
      name: "Rushikesh",
      email: "rushikesh@example.com",
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/provider-credentials",
      payload: {
        userId: user.id,
        provider: "openai",
        apiKey: "sk-test-secret",
      },
    });
    const body = parseResponse<ProviderCredentialResponse>(response);

    expect(response.statusCode).toBe(201);
    expect(body).toMatchObject({
      provider: "openai",
      isEnabled: true,
    });
    expect(response.payload).not.toContain("sk-test-secret");
    expect(onboardingStore.providerCredentials[0]?.encryptedApiKey).not.toBe("sk-test-secret");
  });

  it("lists user available models with capabilities and provider enablement", async () => {
    const { app, onboardingStore } = await createOnboardingTestApp();
    apps.push(app);
    const user = await onboardingStore.createUser({
      name: "Rushikesh",
      email: "rushikesh@example.com",
    });
    await onboardingStore.createProviderCredential({
      userId: user.id,
      provider: "openai",
      apiKey: "sk-test-secret",
      encryptionKey: testConfig.CREDENTIAL_ENCRYPTION_KEY,
    });
    await onboardingStore.upsertModelAccess({
      userId: user.id,
      provider: "openai",
      model: "gpt-4o",
      isEnabled: true,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/users/${user.id}/available-models`,
    });
    const body = parseResponse<AvailableModelsResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.userId).toBe(user.id);
    expect(body.models).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        enabled: true,
        costTier: "high",
        qualityTier: "premium",
      }),
    );
    expect(body.models[0]?.capabilities).toContain("reasoning");
  });

  it("routes using user-specific available models from the generated API key", async () => {
    const { app, onboardingStore } = await createOnboardingTestApp();
    apps.push(app);
    const user = await onboardingStore.createUser({
      name: "Rushikesh",
      email: "rushikesh@example.com",
    });
    await onboardingStore.createProviderCredential({
      userId: user.id,
      provider: "openai",
      apiKey: "sk-test-secret",
      encryptionKey: testConfig.CREDENTIAL_ENCRYPTION_KEY,
    });
    await onboardingStore.upsertModelAccess({
      userId: user.id,
      provider: "openai",
      model: "gpt-4o-mini",
      isEnabled: true,
    });
    const apiKeyResponse = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      payload: {
        userId: user.id,
        name: "Local Dev Key",
      },
    });
    const apiKey = parseResponse<ApiKeyResponse>(apiKeyResponse).apiKey;

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": apiKey },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Help me debug this code" }],
        stream: false,
        routing: { mode: "score_based", strategy: "balanced" },
      },
    });
    const body = parseResponse<ChatCompletionResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(body.routingMetadata.selectedModel).toBe("gpt-4o-mini");
    expect(body.routingMetadata.availableModels).toEqual(["gpt-4o-mini"]);
  });
});
