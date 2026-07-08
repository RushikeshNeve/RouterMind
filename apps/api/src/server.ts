import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PrismaAnalyticsService } from "./infrastructure/analytics-service.js";
import { PrismaApiKeyAuthenticator } from "./infrastructure/authenticator.js";
import { PrismaCacheService } from "./infrastructure/cache-service.js";
import { PrismaCircuitBreakerService } from "./infrastructure/circuit-breaker-service.js";
import { CostGuardrailService } from "./infrastructure/cost-guardrail-service.js";
import { PrismaExecutionPlanLogStore } from "./infrastructure/execution-plan-log-store.js";
import { PrismaOnboardingStore } from "./infrastructure/onboarding-store.js";
import { PrismaProviderAttemptLogStore } from "./infrastructure/provider-attempt-log-store.js";
import { PrismaProviderHealthService } from "./infrastructure/provider-health-service.js";
import { RedisRateLimiter } from "./infrastructure/rate-limiter.js";
import { PrismaRequestLogStore } from "./infrastructure/request-log-store.js";
import { PrismaRouterDecisionLogStore } from "./infrastructure/router-decision-log-store.js";
import { PrismaUserAvailabilityStore } from "./infrastructure/user-availability.js";

const config = loadConfig();
const prisma = new PrismaClient();
const redis = new Redis(config.REDIS_URL);
const circuitBreakerService = new PrismaCircuitBreakerService(prisma);
const authenticator = new PrismaApiKeyAuthenticator(prisma, config.DEV_API_KEY);
const providerAttemptLogStore = new PrismaProviderAttemptLogStore(prisma);
const executionPlanLogStore = new PrismaExecutionPlanLogStore(prisma);
const cacheService = new PrismaCacheService(prisma);
const app = await buildApp({
  config,
  authenticator,
  onboardingStore: new PrismaOnboardingStore(prisma),
  providerHealthService: new PrismaProviderHealthService(prisma),
  circuitBreakerService,
  providerAttemptLogStore,
  executionPlanLogStore,
  analyticsService: new PrismaAnalyticsService(prisma, cacheService),
  cacheService,
  availabilityStore: new PrismaUserAvailabilityStore(prisma, config),
  rateLimiter: new RedisRateLimiter(redis),
  requestLogStore: new PrismaRequestLogStore(prisma),
  routerDecisionLogStore: new PrismaRouterDecisionLogStore(prisma),
  costGuardrailService: new CostGuardrailService(prisma),
});

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "received shutdown signal");
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
};

process.on("SIGINT", (signal) => {
  void shutdown(signal).then(() => process.exit(0));
});

process.on("SIGTERM", (signal) => {
  void shutdown(signal).then(() => process.exit(0));
});

await app.listen({
  host: "0.0.0.0",
  port: config.PORT,
});
