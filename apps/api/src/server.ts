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
import { PrismaPromptFirewallService } from "./infrastructure/prompt-firewall-service.js";
import { RedisRateLimiter } from "./infrastructure/rate-limiter.js";
import { DependencyReadinessService } from "./infrastructure/readiness-service.js";
import { PrismaRequestLogStore } from "./infrastructure/request-log-store.js";
import { PrismaRouterDecisionLogStore } from "./infrastructure/router-decision-log-store.js";
import { PrismaUserAvailabilityStore } from "./infrastructure/user-availability.js";
import { PrismaWorkspaceService } from "./infrastructure/workspace-service.js";

const config = loadConfig();
const prisma = new PrismaClient();
const redis = new Redis(config.REDIS_URL);
const circuitBreakerService = new PrismaCircuitBreakerService(prisma);
const authenticator = new PrismaApiKeyAuthenticator(prisma, config.DEV_API_KEY);
const providerAttemptLogStore = new PrismaProviderAttemptLogStore(prisma);
const executionPlanLogStore = new PrismaExecutionPlanLogStore(prisma);
const cacheService = new PrismaCacheService(prisma);
const promptFirewallService = new PrismaPromptFirewallService(prisma);
const workspaceService = new PrismaWorkspaceService(prisma);
const app = await buildApp({
  config,
  authenticator,
  onboardingStore: new PrismaOnboardingStore(prisma),
  providerHealthService: new PrismaProviderHealthService(prisma),
  circuitBreakerService,
  providerAttemptLogStore,
  executionPlanLogStore,
  analyticsService: new PrismaAnalyticsService(prisma, cacheService, promptFirewallService),
  cacheService,
  promptFirewallService,
  workspaceService,
  availabilityStore: new PrismaUserAvailabilityStore(prisma, config),
  rateLimiter: new RedisRateLimiter(
    redis,
    config.RATE_LIMIT_MAX_REQUESTS ?? 100,
    config.RATE_LIMIT_WINDOW_SECONDS ?? 3600,
  ),
  readinessService: new DependencyReadinessService({
    database: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
    redis: async () => {
      await redis.ping();
    },
    providers: async () => {
      const availability = await new PrismaUserAvailabilityStore(prisma, config).getAvailability({
        id: "dev-user",
        name: "readiness",
        email: "readiness@routemind.local",
        apiKey: config.DEV_API_KEY,
      });
      if (availability.enabledProviders.length === 0 || availability.enabledModels.length === 0) {
        throw new Error("Provider registry is empty.");
      }
    },
  }),
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
