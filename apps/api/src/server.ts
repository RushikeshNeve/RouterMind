import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PrismaApiKeyAuthenticator } from "./infrastructure/authenticator.js";
import { PrismaOnboardingStore } from "./infrastructure/onboarding-store.js";
import { PrismaProviderHealthService } from "./infrastructure/provider-health-service.js";
import { RedisRateLimiter } from "./infrastructure/rate-limiter.js";
import { PrismaRequestLogStore } from "./infrastructure/request-log-store.js";
import { PrismaRouterDecisionLogStore } from "./infrastructure/router-decision-log-store.js";
import { PrismaUserAvailabilityStore } from "./infrastructure/user-availability.js";

const config = loadConfig();
const prisma = new PrismaClient();
const redis = new Redis(config.REDIS_URL);
const app = await buildApp({
  config,
  authenticator: new PrismaApiKeyAuthenticator(prisma),
  onboardingStore: new PrismaOnboardingStore(prisma),
  providerHealthService: new PrismaProviderHealthService(prisma),
  availabilityStore: new PrismaUserAvailabilityStore(prisma, config),
  rateLimiter: new RedisRateLimiter(redis),
  requestLogStore: new PrismaRequestLogStore(prisma),
  routerDecisionLogStore: new PrismaRouterDecisionLogStore(prisma),
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
