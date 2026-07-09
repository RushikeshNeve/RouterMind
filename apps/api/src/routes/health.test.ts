import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import type { ApiConfig } from "../config.js";
import { InMemoryRateLimiter } from "../infrastructure/rate-limiter.js";
import { StaticReadinessService } from "../infrastructure/readiness-service.js";
import { InMemoryRequestLogStore } from "../infrastructure/request-log-store.js";
import { maskApiKey } from "../security/api-key.js";

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

  it("returns readiness success", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      checks: {
        database: "ok",
        redis: "ok",
        providers: "ok",
      },
    });
  });

  it("returns not ready when database check fails", async () => {
    const failingApp = await buildApp({
      config: testConfig,
      rateLimiter: new InMemoryRateLimiter(),
      requestLogStore: new InMemoryRequestLogStore(),
      readinessService: new StaticReadinessService({ database: "error" }),
    });

    const response = await failingApp.inject({
      method: "GET",
      url: "/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: {
        database: "error",
      },
    });
    await failingApp.close();
  });

  it("does not expose stack traces in production error responses", async () => {
    const productionApp = await buildApp({
      config: { ...testConfig, NODE_ENV: "production", LOG_LEVEL: "silent" },
      rateLimiter: new InMemoryRateLimiter(),
      requestLogStore: new InMemoryRequestLogStore(),
    });
    productionApp.get("/boom", () => {
      throw new Error("database password leaked in stack");
    });

    const response = await productionApp.inject({
      method: "GET",
      url: "/boom",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        message: "Internal server error.",
        code: "internal_server_error",
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("database password leaked");
    await productionApp.close();
  });

  it("loads CORS origins from config", async () => {
    const corsApp = await buildApp({
      config: { ...testConfig, CORS_ORIGIN: "https://dashboard.routemind.dev" },
      rateLimiter: new InMemoryRateLimiter(),
      requestLogStore: new InMemoryRequestLogStore(),
    });

    const response = await corsApp.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://dashboard.routemind.dev",
      },
    });

    expect(response.headers["access-control-allow-origin"]).toBe("https://dashboard.routemind.dev");
    await corsApp.close();
  });

  it("masks API keys", () => {
    expect(maskApiKey("rm_live_1234567890")).toBe("rm_live...7890");
    expect(maskApiKey(undefined)).toBe("missing");
  });
});
