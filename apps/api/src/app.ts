import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { createProviderRegistry } from "@routemind/providers";
import Fastify, { type FastifyInstance } from "fastify";

import type { ApiConfig } from "./config.js";
import type { ProviderAdapter } from "@routemind/providers";
import type { RouterLLMService } from "@routemind/routing";
import {
  StaticApiKeyAuthenticator,
  type ApiKeyAuthenticator,
} from "./infrastructure/authenticator.js";
import { InMemoryRateLimiter, type RateLimiter } from "./infrastructure/rate-limiter.js";
import {
  InMemoryRequestLogStore,
  type RequestLogStore,
} from "./infrastructure/request-log-store.js";
import {
  InMemoryOnboardingStore,
  type OnboardingStore,
} from "./infrastructure/onboarding-store.js";
import {
  InMemoryProviderHealthService,
  type ProviderHealthService,
} from "./infrastructure/provider-health-service.js";
import {
  InMemoryRouterDecisionLogStore,
  type RouterDecisionLogStore,
} from "./infrastructure/router-decision-log-store.js";
import { LiveRouterLLMService, MockRouterLLMService } from "./infrastructure/router-llm-service.js";
import {
  StaticUserAvailabilityStore,
  createDefaultAvailability,
  type UserAvailabilityStore,
} from "./infrastructure/user-availability.js";
import { registerChatCompletionRoutes } from "./routes/chat-completions.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerProviderHealthRoutes } from "./routes/provider-health.js";

export interface BuildAppOptions {
  config: ApiConfig;
  rateLimiter?: RateLimiter;
  requestLogStore?: RequestLogStore;
  routerDecisionLogStore?: RouterDecisionLogStore;
  onboardingStore?: OnboardingStore;
  providerHealthService?: ProviderHealthService;
  providers?: Map<string, ProviderAdapter>;
  authenticator?: ApiKeyAuthenticator;
  availabilityStore?: UserAvailabilityStore;
  routerLLMServiceFactory?: (providers: Map<string, ProviderAdapter>) => RouterLLMService;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    genReqId: (request) => {
      const requestId = request.headers["x-request-id"];
      return typeof requestId === "string" && requestId.length > 0
        ? requestId
        : crypto.randomUUID();
    },
    logger: {
      level: options.config.LOG_LEVEL,
    },
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: true,
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ error }, "unhandled request error");
    void reply.status(500).send({
      error: {
        message: "Internal server error.",
      },
      requestId: request.id,
    });
  });

  registerHealthRoutes(app);
  const providerHealthService =
    options.providerHealthService ?? new InMemoryProviderHealthService();
  registerProviderHealthRoutes(app, providerHealthService);
  registerOnboardingRoutes(app, {
    config: options.config,
    onboardingStore: options.onboardingStore ?? new InMemoryOnboardingStore(),
  });
  registerChatCompletionRoutes(app, {
    config: options.config,
    authenticator:
      options.authenticator ?? new StaticApiKeyAuthenticator(options.config.DEV_API_KEY),
    availabilityStore:
      options.availabilityStore ??
      new StaticUserAvailabilityStore(createDefaultAvailability(options.config)),
    rateLimiter: options.rateLimiter ?? new InMemoryRateLimiter(),
    requestLogStore: options.requestLogStore ?? new InMemoryRequestLogStore(),
    routerDecisionLogStore: options.routerDecisionLogStore ?? new InMemoryRouterDecisionLogStore(),
    providerHealthService,
    providers: options.providers,
    providerFactory: (apiKeys) =>
      createProviderRegistry({
        mode: options.config.PROVIDER_MODE,
        timeoutMs: options.config.PROVIDER_TIMEOUT_MS,
        apiKeys,
      }),
    routerLLMServiceFactory:
      options.routerLLMServiceFactory ??
      ((providers) =>
        options.config.PROVIDER_MODE === "mock"
          ? new MockRouterLLMService()
          : new LiveRouterLLMService(options.config, providers)),
  });

  return app;
}
