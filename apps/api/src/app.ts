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
import { AIPlannerService } from "./infrastructure/ai-planner-service.js";
import {
  InMemoryAnalyticsService,
  type AnalyticsService,
} from "./infrastructure/analytics-service.js";
import {
  InMemoryCacheService,
  type CacheService,
} from "./infrastructure/cache-service.js";
import type { CostGuardrailCheck } from "./infrastructure/cost-guardrail-service.js";
import {
  InMemoryCircuitBreakerService,
  type CircuitBreakerService,
} from "./infrastructure/circuit-breaker-service.js";
import {
  InMemoryExecutionPlanLogStore,
  type ExecutionPlanLogStore,
} from "./infrastructure/execution-plan-log-store.js";
import {
  EchoEvaluationModelRunner,
  InMemoryEvaluationService,
  type EvaluationService,
} from "./infrastructure/evaluation-service.js";
import {
  InMemoryProviderAttemptLogStore,
  type ProviderAttemptLogStore,
} from "./infrastructure/provider-attempt-log-store.js";
import { ProviderFallbackService } from "./infrastructure/provider-fallback-service.js";
import { InMemoryRateLimiter, type RateLimiter } from "./infrastructure/rate-limiter.js";
import { RetryPolicyService } from "./infrastructure/retry-policy-service.js";
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
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerCacheRoutes } from "./routes/cache.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerEvaluationRoutes } from "./routes/evaluations.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerProviderHealthRoutes } from "./routes/provider-health.js";
import { registerResilienceRoutes } from "./routes/resilience.js";

export interface BuildAppOptions {
  config: ApiConfig;
  rateLimiter?: RateLimiter;
  requestLogStore?: RequestLogStore;
  routerDecisionLogStore?: RouterDecisionLogStore;
  onboardingStore?: OnboardingStore;
  providerHealthService?: ProviderHealthService;
  circuitBreakerService?: CircuitBreakerService;
  providerAttemptLogStore?: ProviderAttemptLogStore;
  executionPlanLogStore?: ExecutionPlanLogStore;
  evaluationService?: EvaluationService;
  cacheService?: CacheService;
  analyticsService?: AnalyticsService;
  retryPolicyService?: RetryPolicyService;
  aiPlannerService?: AIPlannerService;
  providers?: Map<string, ProviderAdapter>;
  authenticator?: ApiKeyAuthenticator;
  availabilityStore?: UserAvailabilityStore;
  routerLLMServiceFactory?: (providers: Map<string, ProviderAdapter>) => RouterLLMService;
  costGuardrailService?: {
    checkBeforeRequest(input: {
      userId: string;
      estimatedCostUsd: number;
      estimatedTokens: number;
      maxEstimatedCostUsd?: number;
    }): Promise<CostGuardrailCheck>;
    recordUsage(input: {
      userId: string;
      actualCostUsd: number;
      totalTokens: number;
    }): Promise<void>;
  };
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
  const circuitBreakerService =
    options.circuitBreakerService ?? new InMemoryCircuitBreakerService();
  const providerAttemptLogStore =
    options.providerAttemptLogStore ?? new InMemoryProviderAttemptLogStore();
  const executionPlanLogStore =
    options.executionPlanLogStore ?? new InMemoryExecutionPlanLogStore();
  const requestLogStore = options.requestLogStore ?? new InMemoryRequestLogStore();
  const routerDecisionLogStore =
    options.routerDecisionLogStore ?? new InMemoryRouterDecisionLogStore();
  const evaluationService =
    options.evaluationService ??
    new InMemoryEvaluationService(new EchoEvaluationModelRunner());
  const cacheService = options.cacheService ?? new InMemoryCacheService();
  const analyticsService =
    options.analyticsService ??
    (requestLogStore instanceof InMemoryRequestLogStore &&
    routerDecisionLogStore instanceof InMemoryRouterDecisionLogStore &&
    providerAttemptLogStore instanceof InMemoryProviderAttemptLogStore &&
    executionPlanLogStore instanceof InMemoryExecutionPlanLogStore
      ? new InMemoryAnalyticsService(
          requestLogStore,
          routerDecisionLogStore,
          providerAttemptLogStore,
          executionPlanLogStore,
          cacheService,
        )
      : undefined);
  if (!analyticsService) {
    throw new Error("analyticsService is required when custom log stores are provided.");
  }
  registerAnalyticsRoutes(app, analyticsService);
  registerCacheRoutes(app, cacheService);
  registerEvaluationRoutes(app, evaluationService);
  registerProviderHealthRoutes(app, providerHealthService);
  registerResilienceRoutes(app, {
    circuitBreakerService,
    providerAttemptLogStore,
  });
  registerOnboardingRoutes(app, {
    config: options.config,
    onboardingStore: options.onboardingStore ?? new InMemoryOnboardingStore(),
  });
  const authenticator =
    options.authenticator ?? new StaticApiKeyAuthenticator(options.config.DEV_API_KEY);
  const availabilityStore =
    options.availabilityStore ??
    new StaticUserAvailabilityStore(createDefaultAvailability(options.config));
  registerModelRoutes(app, {
    authenticator,
    availabilityStore,
  });
  registerChatCompletionRoutes(app, {
    config: options.config,
    authenticator,
    costGuardrailService: options.costGuardrailService ?? {
      checkBeforeRequest: async () => ({ allowed: true }),
      recordUsage: async () => undefined,
    },
    availabilityStore,
    rateLimiter: options.rateLimiter ?? new InMemoryRateLimiter(),
    requestLogStore,
    routerDecisionLogStore,
    providerHealthService,
    circuitBreakerService,
    providerAttemptLogStore,
    executionPlanLogStore,
    evaluationService,
    cacheService,
    retryPolicyService: options.retryPolicyService ?? new RetryPolicyService(),
    aiPlannerService: options.aiPlannerService ?? new AIPlannerService(),
    providerFallbackService: new ProviderFallbackService(circuitBreakerService),
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
