import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { NoopTracer, type Tracer } from "@routemind/observability";
import { createProviderRegistry } from "@routemind/providers";
import { PrismaClient } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";

import type { ApiConfig } from "./config.js";
import type { ProviderAdapter } from "@routemind/providers";
import type { ResolveRouterConfigContext, RouterLLMService } from "@routemind/routing";
import {
  StaticApiKeyAuthenticator,
  type AuthenticatedUser,
  type ApiKeyAuthenticator,
} from "./infrastructure/authenticator.js";
import { hashApiKey } from "./security/api-key.js";
import { AIPlannerService } from "./infrastructure/ai-planner-service.js";
import {
  InMemoryAnalyticsService,
  type AnalyticsService,
} from "./infrastructure/analytics-service.js";
import { InMemoryCacheService, type CacheService } from "./infrastructure/cache-service.js";
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
  InMemoryPromptFirewallService,
  type PromptFirewallService,
} from "./infrastructure/prompt-firewall-service.js";
import {
  InMemoryProviderAttemptLogStore,
  type ProviderAttemptLogStore,
} from "./infrastructure/provider-attempt-log-store.js";
import { ProviderFallbackService } from "./infrastructure/provider-fallback-service.js";
import { InMemoryRateLimiter, type RateLimiter } from "./infrastructure/rate-limiter.js";
import {
  StaticReadinessService,
  type ReadinessService,
} from "./infrastructure/readiness-service.js";
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
import { PrismaRouterConfigLookup } from "./infrastructure/router-config-lookup.js";
import {
  StaticUserAvailabilityStore,
  createDefaultAvailability,
  type UserAvailabilityStore,
} from "./infrastructure/user-availability.js";
import {
  InMemoryWorkspaceService,
  type WorkspaceService,
} from "./infrastructure/workspace-service.js";
import { registerChatCompletionRoutes } from "./routes/chat-completions.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerCacheRoutes } from "./routes/cache.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerEvaluationRoutes } from "./routes/evaluations.js";
import { registerFirewallRoutes } from "./routes/firewall.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerProviderHealthRoutes } from "./routes/provider-health.js";
import { registerResilienceRoutes } from "./routes/resilience.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerInviteRoutes } from "./routes/invites.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerProviderCredentialRoutes } from "./routes/provider-credentials.js";
import { registerRouterConfigRoutes } from "./routes/router-config.js";
import { registerServiceAccountRoutes } from "./routes/service-accounts.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { ConsoleEmailSender, type EmailSender } from "./infrastructure/email-sender.js";
import { toSafeErrorResponse } from "./security/errors.js";

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
  promptFirewallService?: PromptFirewallService;
  workspaceService?: WorkspaceService;
  prisma?: PrismaClient;
  emailSender?: EmailSender;
  analyticsService?: AnalyticsService;
  readinessService?: ReadinessService;
  tracer?: Tracer;
  retryPolicyService?: RetryPolicyService;
  aiPlannerService?: AIPlannerService;
  providers?: Map<string, ProviderAdapter>;
  authenticator?: ApiKeyAuthenticator;
  availabilityStore?: UserAvailabilityStore;
  routerLLMServiceFactory?: (
    providers: Map<string, ProviderAdapter>,
    context: ResolveRouterConfigContext,
  ) => RouterLLMService;
  costGuardrailService?: {
    checkBeforeRequest(input: {
      userId: string;
      workspaceId?: string;
      estimatedCostUsd: number;
      estimatedTokens: number;
      maxEstimatedCostUsd?: number;
    }): Promise<CostGuardrailCheck>;
    recordUsage(input: {
      userId: string;
      workspaceId?: string;
      actualCostUsd: number;
      totalTokens: number;
    }): Promise<void>;
  };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: options.config.REQUEST_BODY_LIMIT_BYTES ?? 1_048_576,
    genReqId: (request) => {
      const requestId = request.headers["x-request-id"];
      return typeof requestId === "string" && requestId.length > 0
        ? requestId
        : crypto.randomUUID();
    },
    logger: {
      level: options.config.LOG_LEVEL,
      redact: [
        "req.headers.authorization",
        "req.headers.x-api-key",
        "apiKey",
        "providerApiKey",
        "*.apiKey",
        "*.authorization",
      ],
    },
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: parseCorsOrigin(options.config.CORS_ORIGIN ?? "*"),
    // Needed so the dashboard's magic-link session cookie is sent/received
    // cross-origin (dashboard and API run on different ports in dev, and
    // different top-level domains in production).
    credentials: true,
  });
  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const errorCode = isErrorWithCode(error) ? error.code : "unknown";
    request.log.error({ errorCode, error }, "unhandled request error");
    const safeError = error instanceof Error ? error : new Error("Internal server error.");
    void reply.status(500).send(
      toSafeErrorResponse(safeError, {
        requestId: request.id,
        production: options.config.NODE_ENV === "production",
      }),
    );
  });

  const readinessService = options.readinessService ?? new StaticReadinessService();
  registerHealthRoutes(app, readinessService);
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
    options.evaluationService ?? new InMemoryEvaluationService(new EchoEvaluationModelRunner());
  const cacheService = options.cacheService ?? new InMemoryCacheService();
  const promptFirewallService =
    options.promptFirewallService ?? new InMemoryPromptFirewallService();
  const workspaceService = options.workspaceService ?? new InMemoryWorkspaceService();
  const prisma = options.prisma ?? new PrismaClient({ datasourceUrl: options.config.DATABASE_URL });
  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });
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
          promptFirewallService,
        )
      : undefined);
  if (!analyticsService) {
    throw new Error("analyticsService is required when custom log stores are provided.");
  }
  registerAnalyticsRoutes(app, analyticsService);
  registerCacheRoutes(app, cacheService);
  registerEvaluationRoutes(app, evaluationService);
  registerFirewallRoutes(app, promptFirewallService);
  registerWorkspaceRoutes(app, {
    config: options.config,
    workspaceService,
    prisma,
  });
  registerServiceAccountRoutes(app, {
    config: options.config,
    workspaceService,
    prisma,
  });
  registerRouterConfigRoutes(app, {
    config: options.config,
    prisma,
  });
  registerProviderCredentialRoutes(app, {
    config: options.config,
    prisma,
  });
  const emailSender = options.emailSender ?? new ConsoleEmailSender();
  registerAuthRoutes(app, {
    config: options.config,
    prisma,
    emailSender,
  });
  registerInviteRoutes(app, {
    config: options.config,
    prisma,
    emailSender,
  });
  registerMeRoutes(app, {
    config: options.config,
    prisma,
  });
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
    options.authenticator ??
    createDefaultAuthenticator(options.config.DEV_API_KEY, workspaceService);
  const availabilityStore =
    options.availabilityStore ??
    new StaticUserAvailabilityStore(createDefaultAvailability(options.config));
  registerModelRoutes(app, {
    authenticator,
    availabilityStore,
  });
  const providerFactory = (apiKeys: Parameters<typeof createProviderRegistry>[0]["apiKeys"]) =>
    createProviderRegistry({
      mode: options.config.PROVIDER_MODE,
      timeoutMs: options.config.PROVIDER_TIMEOUT_MS,
      apiKeys,
    });
  registerChatCompletionRoutes(app, {
    config: options.config,
    authenticator,
    costGuardrailService: options.costGuardrailService ?? {
      checkBeforeRequest: () => Promise.resolve({ allowed: true }),
      recordUsage: () => Promise.resolve(undefined),
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
    promptFirewallService,
    tracer: options.tracer ?? new NoopTracer(),
    retryPolicyService: options.retryPolicyService ?? new RetryPolicyService(),
    aiPlannerService: options.aiPlannerService ?? new AIPlannerService(),
    providerFallbackService: new ProviderFallbackService(circuitBreakerService),
    providers: options.providers,
    providerFactory,
    routerLLMServiceFactory:
      options.routerLLMServiceFactory ??
      ((providers, context) =>
        options.config.PROVIDER_MODE === "mock"
          ? new MockRouterLLMService()
          : new LiveRouterLLMService(
              options.config,
              providers,
              new PrismaRouterConfigLookup(prisma),
              context,
              prisma,
              providerFactory,
            )),
  });

  return app;
}

function isErrorWithCode(error: unknown): error is { readonly code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  );
}

function parseCorsOrigin(origin: string): boolean | string | RegExp | (string | RegExp)[] {
  if (origin === "*" || origin.toLowerCase() === "true") {
    return true;
  }

  if (origin.toLowerCase() === "false") {
    return false;
  }

  return origin
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function createDefaultAuthenticator(
  devApiKey: string,
  workspaceService: WorkspaceService,
): ApiKeyAuthenticator {
  const staticAuthenticator = new StaticApiKeyAuthenticator(devApiKey);
  return {
    async authenticate(apiKey: string): Promise<AuthenticatedUser | undefined> {
      const staticUser = await staticAuthenticator.authenticate(apiKey);
      if (staticUser) {
        return staticUser;
      }
      if (workspaceService instanceof InMemoryWorkspaceService) {
        const keyHash = hashApiKey(apiKey);
        const record = workspaceService.apiKeys.find(
          (item) => item.keyHash === keyHash && item.isActive,
        );
        if (record) {
          const member = await workspaceService.getMember(record.workspaceId, record.userId);
          return {
            id: record.userId,
            name: "Workspace User",
            email: `${record.userId}@routemind.local`,
            apiKey,
            apiKeyId: record.id,
            workspaceId: record.workspaceId,
            workspaceRole: member?.role,
          };
        }
      }
      return undefined;
    },
  };
}
