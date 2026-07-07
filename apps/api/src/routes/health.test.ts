import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import type { ApiConfig } from "../config.js";
import { InMemoryRateLimiter } from "../infrastructure/rate-limiter.js";
import { InMemoryRequestLogStore } from "../infrastructure/request-log-store.js";

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

describe("health route", async () => {
  const app = await buildApp({
    config: testConfig,
    rateLimiter: new InMemoryRateLimiter(),
    requestLogStore: new InMemoryRequestLogStore(),
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns service health metadata", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "routemind-api",
      status: "ok",
      version: "0.1.0",
    });
  });
});
