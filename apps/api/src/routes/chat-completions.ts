import { estimateCost, estimateTokens } from "@routemind/cost-engine";
import type { ProviderResponse } from "@routemind/core";
import type { Tracer } from "@routemind/observability";
import { type ProviderAdapter, isProviderError } from "@routemind/providers";
import {
  type RouterLLMService,
  type RoutingCandidateModel,
  decideLLMRoute,
} from "@routemind/routing";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import type {
  AIPlannerDecision,
  AIPlannerService,
  ExecutionPlanStep,
  ExecutionPlanType,
} from "../infrastructure/ai-planner-service.js";
import type { ApiKeyAuthenticator } from "../infrastructure/authenticator.js";
import type {
  CacheMode,
  CacheRequestOptions,
  CacheService,
} from "../infrastructure/cache-service.js";
import type { CircuitBreakerService } from "../infrastructure/circuit-breaker-service.js";
import type { CostGuardrailCheck } from "../infrastructure/cost-guardrail-service.js";
import type { ExecutionPlanLogStore } from "../infrastructure/execution-plan-log-store.js";
import type { EvaluationService } from "../infrastructure/evaluation-service.js";
import type {
  ProviderAttemptLogEntry,
  ProviderAttemptLogStore,
} from "../infrastructure/provider-attempt-log-store.js";
import type {
  FirewallInspectionResult,
  PromptFirewallService,
} from "../infrastructure/prompt-firewall-service.js";
import {
  ProviderErrorClassifier,
  type ProviderErrorType,
} from "../infrastructure/provider-error-classifier.js";
import type { ProviderFallbackService } from "../infrastructure/provider-fallback-service.js";
import type { RateLimiter } from "../infrastructure/rate-limiter.js";
import type { RequestLogStore } from "../infrastructure/request-log-store.js";
import type { RetryPolicyService } from "../infrastructure/retry-policy-service.js";
import type { RouterDecisionLogStore } from "../infrastructure/router-decision-log-store.js";
import type {
  ProviderHealthMetric,
  ProviderHealthService,
  ProviderRequestErrorCode,
} from "../infrastructure/provider-health-service.js";
import type {
  UserAvailabilityStore,
  UserProviderAvailability,
} from "../infrastructure/user-availability.js";
import { maskApiKey } from "../security/api-key.js";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

const cacheRequestSchema = z
  .object({
    mode: z.enum(["disabled", "exact", "semantic"]).optional().default("exact"),
    ttlSeconds: z.number().int().positive().optional().default(3600),
    similarityThreshold: z.number().min(0).max(1).optional().default(0.92),
    bypass: z.boolean().optional().default(false),
  })
  .optional()
  .default({
    mode: "exact",
    ttlSeconds: 3600,
    similarityThreshold: 0.92,
    bypass: false,
  });

const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  routing: z
    .object({
      mode: z
        .enum(["rule_based", "score_based", "llm_assisted"])
        .optional()
        .default("llm_assisted"),
      strategy: z
        .enum(["balanced", "cost_first", "latency_first", "quality_first"])
        .optional()
        .default("balanced"),
      maxCostTier: z.enum(["low", "medium", "high"]).optional(),
      blockedProviders: z.array(z.enum(["openai", "anthropic", "gemini", "groq"])).optional(),
      blockedModels: z.array(z.string().min(1)).optional(),
      requireHealthyProviders: z.boolean().optional(),
      allowUnhealthyProviders: z.boolean().optional().default(false),
      maxEstimatedCostUsd: z.number().positive().optional(),
      executionPlan: z
        .enum(["auto", "single_model", "cheap_first", "summarize_then_reason", "quality_first"])
        .optional()
        .default("auto"),
    })
    .optional()
    .default({ mode: "llm_assisted", strategy: "balanced" }),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional().default(false),
  cache: cacheRequestSchema,
});

type ChatCompletionBody = z.input<typeof chatCompletionRequestSchema>;

export interface ChatCompletionDependencies {
  readonly config: ApiConfig;
  readonly authenticator: ApiKeyAuthenticator;
  readonly availabilityStore: UserAvailabilityStore;
  readonly rateLimiter: RateLimiter;
  readonly requestLogStore: RequestLogStore;
  readonly routerDecisionLogStore: RouterDecisionLogStore;
  readonly providerHealthService: ProviderHealthService;
  readonly circuitBreakerService: CircuitBreakerService;
  readonly providerAttemptLogStore: ProviderAttemptLogStore;
  readonly executionPlanLogStore: ExecutionPlanLogStore;
  readonly evaluationService: EvaluationService;
  readonly cacheService: CacheService;
  readonly promptFirewallService: PromptFirewallService;
  readonly tracer: Tracer;
  readonly retryPolicyService: RetryPolicyService;
  readonly providerFallbackService: ProviderFallbackService;
  readonly aiPlannerService: AIPlannerService;
  readonly costGuardrailService: {
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
  readonly providers?: Map<string, ProviderAdapter>;
  readonly providerFactory: (
    apiKeys: UserProviderAvailability["providerApiKeys"],
  ) => Map<string, ProviderAdapter>;
  readonly routerLLMServiceFactory: (providers: Map<string, ProviderAdapter>) => RouterLLMService;
}

interface ResilienceAttemptMetadata {
  readonly provider: string;
  readonly model: string;
  readonly attemptNumber: number;
  readonly status: "success" | "failed";
  readonly latencyMs: number;
  readonly errorType?: ProviderErrorType;
  readonly errorMessage?: string;
}

interface ExecutionPlanMetadata {
  readonly planType: ExecutionPlanType;
  readonly steps: readonly ExecutionPlanStep[];
  readonly estimatedCostUsd: number;
  readonly actualCostUsd?: number;
  readonly confidence: number;
  readonly reason: string;
  readonly executed: boolean;
}

interface LogFailureOptions {
  readonly request: FastifyRequest;
  readonly requestStartedAt: number;
  readonly apiKey: string;
  readonly workspaceId?: string;
  readonly requestedModel: string;
  readonly message: string;
  readonly selectedModel?: string;
  readonly provider?: string;
  readonly providerStatusAtRouting?: string;
  readonly providerAvgLatencyAtRouting?: number;
  readonly providerSuccessRateAtRouting?: number;
  readonly routingMode?: string;
  readonly routingStrategy?: string;
}

export function registerChatCompletionRoutes(
  app: FastifyInstance,
  dependencies: ChatCompletionDependencies,
): void {
  app.post(
    "/v1/chat/completions",
    async (request: FastifyRequest<{ Body: ChatCompletionBody }>, reply: FastifyReply) => {
      const requestStartedAt = Date.now();
      const apiKey = extractApiKey(request);

      if (!apiKey) {
        await logFailure(
          {
            request,
            requestStartedAt,
            apiKey: "missing",
            requestedModel: extractRequestedModel(request.body),
            message: "Missing API key",
          },
          dependencies.requestLogStore,
        );
        return reply.status(401).send(
          openAiError({
            message: "Missing or invalid API key.",
            type: "authentication_error",
            code: "invalid_api_key",
          }),
        );
      }

      const user = await dependencies.authenticator.authenticate(apiKey);

      if (!user) {
        await logFailure(
          {
            request,
            requestStartedAt,
            apiKey,
            requestedModel: extractRequestedModel(request.body),
            message: "Invalid API key",
          },
          dependencies.requestLogStore,
        );
        return reply.status(401).send(
          openAiError({
            message: "Missing or invalid API key.",
            type: "authentication_error",
            code: "invalid_api_key",
          }),
        );
      }

      const rateLimit = await dependencies.rateLimiter.consume(apiKey);
      reply.header("x-ratelimit-limit", rateLimit.limit);
      reply.header("x-ratelimit-remaining", rateLimit.remaining);
      reply.header("x-ratelimit-reset", rateLimit.resetSeconds);

      if (!rateLimit.allowed) {
        await logFailure(
          {
            request,
            requestStartedAt,
            apiKey,
            requestedModel: extractRequestedModel(request.body),
            message: "Rate limit exceeded",
          },
          dependencies.requestLogStore,
        );
        return reply.status(429).send(
          openAiError({
            message: "Rate limit exceeded.",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          }),
        );
      }

      const parsed = chatCompletionRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        await logFailure(
          {
            request,
            requestStartedAt,
            apiKey,
            requestedModel: extractRequestedModel(request.body),
            message: "Invalid request body",
          },
          dependencies.requestLogStore,
        );
        return reply.status(400).send(
          openAiError({
            message: "Invalid request body.",
            type: "invalid_request_error",
            code: "invalid_request_body",
            issues: parsed.error.flatten(),
          }),
        );
      }

      const firewall = await dependencies.promptFirewallService.inspectRequest({
        userId: user.id,
        messages: parsed.data.messages,
      });
      const firewallMetadata = buildFirewallMetadata(firewall);

      if (!firewall.allowed) {
        const requestLogId = await logFailure(
          {
            request,
            requestStartedAt,
            apiKey,
            workspaceId: user.workspaceId,
            requestedModel: parsed.data.model,
            message: "Prompt blocked by RouteMind firewall policy.",
            routingMode: parsed.data.routing.mode,
            routingStrategy: parsed.data.routing.strategy,
          },
          dependencies.requestLogStore,
        );
        await dependencies.promptFirewallService.recordEvents({
          userId: user.id,
          workspaceId: user.workspaceId,
          requestLogId,
          events: firewall.events,
        });

        return reply.status(400).send({
          ...openAiError({
            message: "Prompt blocked by RouteMind firewall policy.",
            type: "invalid_request_error",
            code: "prompt_firewall_blocked",
          }),
          firewall: firewallMetadata,
          routemind: {
            firewall: firewallMetadata,
          },
        });
      }

      const effectiveMessages = firewall.sanitizedMessages;
      const cachePlan = buildCachePlan(
        parsed.data.cache,
        parsed.data.stream,
        parsed.data.temperature,
      );
      const cacheKey =
        cachePlan.lookupMode === "exact"
          ? dependencies.cacheService.buildCacheKey({
              userId: user.id,
              workspaceId: user.workspaceId,
              messages: effectiveMessages,
              requestedModel: parsed.data.model,
              routingStrategy: parsed.data.routing.strategy,
              temperature: parsed.data.temperature,
            })
          : undefined;

      if (cacheKey) {
        const cached = await dependencies.cacheService.getExactCache(cacheKey.cacheKey);
        if (cached) {
          const latencyMs = Date.now() - requestStartedAt;
          const costSavedUsd = estimateCost(cached.model, {
            inputTokens: cached.inputTokens,
            outputTokens: cached.outputTokens,
          });
          await dependencies.cacheService.recordCacheHit(cached.cacheKey, costSavedUsd);
          const requestLogId = await dependencies.requestLogStore.create({
            apiKey,
            workspaceId: user.workspaceId,
            requestedModel: parsed.data.model,
            selectedModel: cached.model,
            provider: cached.provider,
            inputTokens: cached.inputTokens,
            outputTokens: cached.outputTokens,
            estimatedCost: 0,
            latencyMs,
            status: "success",
            routingMode: parsed.data.routing.mode,
            routingStrategy: parsed.data.routing.strategy,
          });

          const cachedResponse = attachFirewallMetadata(
            attachCacheMetadata(cached.responseJson, {
              hit: true,
              mode: cachePlan.requestedMode,
              costSavedUsd,
              originalModel: cached.model,
              originalProvider: cached.provider,
              semanticFallback: cachePlan.semanticFallback,
            }),
            firewallMetadata,
          );
          await dependencies.promptFirewallService.recordEvents({
            userId: user.id,
            workspaceId: user.workspaceId,
            requestLogId,
            events: firewall.events,
          });
          return reply.send(cachedResponse);
        }
      }

      const availability = await dependencies.availabilityStore.getAvailability(user);
      const providers =
        dependencies.providers ?? dependencies.providerFactory(availability.providerApiKeys);
      const promptCharacters = effectiveMessages.reduce(
        (total, message) => total + message.content.length,
        0,
      );
      const tokenEstimate = estimateTokens(promptCharacters);
      const liveMetrics = toRoutingMetrics(await dependencies.providerHealthService.list());
      const route = await decideLLMRoute({
        requestedModel: parsed.data.model,
        messages: effectiveMessages,
        availableModels: availability.enabledModels,
        enabledProviders: availability.enabledProviders,
        providerApiKeys: availability.providerApiKeys,
        mode: parsed.data.routing.mode,
        strategy: parsed.data.routing.strategy,
        policy: {
          maxCostTier: parsed.data.routing.maxCostTier,
          blockedProviders: parsed.data.routing.blockedProviders,
          blockedModels: parsed.data.routing.blockedModels,
          requireHealthyProviders: parsed.data.routing.requireHealthyProviders,
          allowUnhealthyProviders: parsed.data.routing.allowUnhealthyProviders,
        },
        liveMetrics,
        evaluationScores: await dependencies.evaluationService.routingScores(),
        approximateInputTokens: tokenEstimate.inputTokens,
        routerLLMEnabled: dependencies.config.ROUTER_LLM_ENABLED,
        routerLLMService: dependencies.routerLLMServiceFactory(providers),
      });

      if (route.unsupported) {
        await logFailure(
          {
            request,
            requestStartedAt,
            apiKey,
            requestedModel: parsed.data.model,
            message: `Unsupported model: ${parsed.data.model}`,
          },
          dependencies.requestLogStore,
        );
        const message =
          route.routingReason === "unsupported model"
            ? `Unsupported model: ${parsed.data.model}`
            : (route.routingMetadata.unavailableReason ??
              `No suitable model available for ${parsed.data.model}`);

        return reply.status(400).send(
          openAiError({
            message,
            type: "invalid_request_error",
            code: "model_not_available",
            routingMetadata: route.routingMetadata,
          }),
        );
      }

      const plannerDecision = await dependencies.aiPlannerService.plan({
        requestedExecutionPlan: parsed.data.routing.executionPlan,
        userPrompt: effectiveMessages.map((message) => message.content).join("\n"),
        messages: effectiveMessages,
        candidates: route.candidates,
        primaryProvider: route.provider,
        primaryModel: route.selectedModel,
        approximateInputTokens: tokenEstimate.inputTokens,
        approximateOutputTokens: tokenEstimate.outputTokens,
        routingStrategy: parsed.data.routing.strategy,
        taskType: route.routingMetadata.detectedTask,
        complexity: route.routingMetadata.complexity,
      });
      const plannerValidation = await validatePlannerDecision(
        plannerDecision,
        route.candidates,
        dependencies.circuitBreakerService,
      );
      const effectivePlannerDecision = plannerValidation.valid
        ? plannerDecision
        : buildFallbackSingleModelPlan({
            provider: route.provider,
            model: route.selectedModel,
            estimatedCostUsd: estimateCost(route.selectedModel, tokenEstimate),
            reason: `Planner choice invalid (${plannerValidation.reason}); fell back to normal routing.`,
          });
      const primaryStep = effectivePlannerDecision.steps[0];
      const effectivePrimaryProvider = primaryStep?.provider ?? route.provider;
      const effectivePrimaryModel = primaryStep?.model ?? route.selectedModel;
      const initialExecutionPlanMetadata = buildExecutionPlanMetadata(
        effectivePlannerDecision,
        false,
      );

      if (!effectivePlannerDecision.executable) {
        const requestLogId = await logFailure(
          {
            request,
            requestStartedAt,
            apiKey,
            requestedModel: parsed.data.model,
            message: "Execution plan is planned but not executable yet.",
            selectedModel: effectivePrimaryModel,
            provider: effectivePrimaryProvider,
            routingMode: route.routingMetadata.mode,
            routingStrategy: route.routingMetadata.routingStrategy,
          },
          dependencies.requestLogStore,
        );
        await dependencies.executionPlanLogStore.create({
          requestLogId,
          workspaceId: user.workspaceId,
          userId: user.id,
          planType: effectivePlannerDecision.executionPlan,
          stepsJson: effectivePlannerDecision.steps,
          estimatedCostUsd: effectivePlannerDecision.estimatedCostUsd,
          confidence: effectivePlannerDecision.confidence,
          reason: effectivePlannerDecision.reason,
          executed: false,
        });

        return reply.status(501).send({
          ...openAiError({
            message: "Execution plan is planned but not executable yet.",
            type: "server_error",
            code: "execution_plan_not_executable",
          }),
          executionPlan: initialExecutionPlanMetadata,
          routemind: {
            executionPlan: initialExecutionPlanMetadata,
          },
        });
      }

      const healthAtRouting = route.candidates.find(
        (candidate) =>
          candidate.provider === effectivePrimaryProvider &&
          candidate.model === effectivePrimaryModel,
      )?.metrics;
      const fallbackOrder = await dependencies.providerFallbackService.buildFallbackOrder({
        primaryProvider: effectivePrimaryProvider,
        primaryModel: effectivePrimaryModel,
        candidates: route.candidates,
      });
      const attempts: ResilienceAttemptMetadata[] = [];
      const attemptLogEntries: ProviderAttemptLogEntry[] = [];
      const classifier = new ProviderErrorClassifier();
      let providerResponse: ProviderResponse | undefined;
      let finalProvider = effectivePrimaryProvider;
      let finalModel = effectivePrimaryModel;
      let finalGuardrailCheck: CostGuardrailCheck | undefined;
      let finalActualCostUsd = 0;
      let lastErrorMessage = "All provider attempts failed.";

      for (const candidate of fallbackOrder.candidates) {
        const estimatedCostUsd = estimateCost(candidate.model, tokenEstimate);
        const guardrailCheck = await dependencies.costGuardrailService.checkBeforeRequest({
          userId: user.id,
          workspaceId: user.workspaceId,
          estimatedCostUsd,
          estimatedTokens: tokenEstimate.inputTokens + tokenEstimate.outputTokens,
          maxEstimatedCostUsd: parsed.data.routing.maxEstimatedCostUsd,
        });

        if (!guardrailCheck.allowed) {
          const message = guardrailCheck.message ?? "Cost guardrail exceeded.";

          if (
            attempts.length === 0 &&
            candidate.provider === effectivePrimaryProvider &&
            candidate.model === effectivePrimaryModel
          ) {
            const requestLogId = await logFailure(
              {
                request,
                requestStartedAt,
                apiKey,
                requestedModel: parsed.data.model,
                message,
                selectedModel: candidate.model,
                provider: candidate.provider,
                providerStatusAtRouting: healthAtRouting?.status,
                providerAvgLatencyAtRouting:
                  healthAtRouting?.avgLatencyMs ?? healthAtRouting?.latencyMs,
                providerSuccessRateAtRouting:
                  healthAtRouting?.successRate ?? healthAtRouting?.reliabilityScore,
                routingMode: route.routingMetadata.mode,
                routingStrategy: route.routingMetadata.routingStrategy,
              },
              dependencies.requestLogStore,
            );
            await dependencies.executionPlanLogStore.create({
              requestLogId,
              workspaceId: user.workspaceId,
              userId: user.id,
              planType: effectivePlannerDecision.executionPlan,
              stepsJson: effectivePlannerDecision.steps,
              estimatedCostUsd: effectivePlannerDecision.estimatedCostUsd,
              confidence: effectivePlannerDecision.confidence,
              reason: effectivePlannerDecision.reason,
              executed: false,
            });

            const costGuardrails = {
              estimatedCostUsd,
              actualCostUsd: 0,
              budgetRemainingUsd: guardrailCheck.budgetRemainingUsd,
              budgetUsagePercent: guardrailCheck.budgetUsagePercent,
              quotaRemainingRequests: guardrailCheck.quotaRemainingRequests,
              quotaRemainingTokens: guardrailCheck.quotaRemainingTokens,
            };
            const resilience = buildResilienceMetadata({
              primaryProvider: effectivePrimaryProvider,
              primaryModel: effectivePrimaryModel,
              finalProvider: candidate.provider,
              finalModel: candidate.model,
              circuitBreakerTriggered: fallbackOrder.circuitBreakerTriggered,
              attempts,
            });
            const errorType =
              guardrailCheck.errorCode === "QUOTA_EXCEEDED"
                ? "rate_limit_error"
                : "invalid_request_error";

            return reply.status(403).send({
              ...openAiError({
                message,
                type: errorType,
                code: guardrailCheck.errorCode ?? "cost_guardrail_exceeded",
                costGuardrails,
              }),
              resilience,
              executionPlan: initialExecutionPlanMetadata,
              routemind: {
                resilience,
                costGuardrails,
                executionPlan: initialExecutionPlanMetadata,
              },
            });
          }

          lastErrorMessage = message;
          continue;
        }

        const provider = providers.get(candidate.provider);
        if (!provider) {
          lastErrorMessage = `No provider registered for ${candidate.provider}`;
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            attemptNumber: 1,
            status: "failed",
            latencyMs: 0,
            errorType: "PROVIDER_UNAVAILABLE",
            errorMessage: lastErrorMessage,
          });
          await dependencies.circuitBreakerService.recordFailure(
            candidate.provider,
            candidate.model,
          );
          continue;
        }

        const result = await dependencies.tracer.withSpan(
          "chat.provider_attempt",
          {
            requestId: request.id,
            userId: user.id,
            workspaceId: user.workspaceId,
            provider: candidate.provider,
            model: candidate.model,
          },
          async (span) => {
            const retryResult = await dependencies.retryPolicyService.execute(
              () =>
                provider.chatCompletion({
                  model: candidate.model,
                  messages: effectiveMessages,
                  temperature: parsed.data.temperature,
                  stream: false,
                  estimatedUsage: tokenEstimate,
                }),
              {
                onFailure: async ({ error, errorType, attemptNumber, latencyMs }) => {
                  const errorMessage = getProviderErrorMessage(error);
                  attempts.push({
                    provider: candidate.provider,
                    model: candidate.model,
                    attemptNumber,
                    status: "failed",
                    latencyMs,
                    errorType,
                    errorMessage,
                  });
                  await dependencies.providerHealthService.record({
                    provider: candidate.provider,
                    model: candidate.model,
                    latencyMs,
                    success: false,
                    errorCode: toHealthErrorCode(error, errorType),
                    errorMessage,
                    timestamp: new Date(),
                  });
                  await dependencies.circuitBreakerService.recordFailure(
                    candidate.provider,
                    candidate.model,
                  );
                },
                onSuccess: async ({ attemptNumber, latencyMs }) => {
                  attempts.push({
                    provider: candidate.provider,
                    model: candidate.model,
                    attemptNumber,
                    status: "success",
                    latencyMs,
                  });
                  await dependencies.providerHealthService.record({
                    provider: candidate.provider,
                    model: candidate.model,
                    latencyMs,
                    success: true,
                    timestamp: new Date(),
                  });
                  await dependencies.circuitBreakerService.recordSuccess(
                    candidate.provider,
                    candidate.model,
                  );
                },
              },
            );
            span.setAttribute("status", retryResult.value ? "success" : "failed");
            return retryResult;
          },
        );

        if (result.value) {
          providerResponse = result.value;
          finalProvider = candidate.provider;
          finalModel = candidate.model;
          finalGuardrailCheck = guardrailCheck;
          const actualUsageForCost = {
            inputTokens: providerResponse.usage.prompt_tokens,
            outputTokens: providerResponse.usage.completion_tokens,
          };
          finalActualCostUsd = estimateCost(candidate.model, actualUsageForCost);
          break;
        }

        const lastFailure = result.failures[result.failures.length - 1];
        lastErrorMessage = lastFailure
          ? getProviderErrorMessage(lastFailure.error)
          : "Provider request failed.";

        request.log.warn(
          {
            requestId: request.id,
            userId: user.id,
            workspaceId: user.workspaceId,
            provider: candidate.provider,
            model: candidate.model,
            errorType: lastFailure?.errorType ?? classifier.classify(result.error),
            status: "failed",
          },
          "provider candidate failed",
        );
      }

      for (const attempt of attempts) {
        attemptLogEntries.push({
          userId: user.id,
          workspaceId: user.workspaceId,
          provider: attempt.provider,
          model: attempt.model,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          latencyMs: attempt.latencyMs,
          errorType: attempt.errorType,
          errorMessage: attempt.errorMessage,
        });
      }

      if (!providerResponse) {
        const requestLogId = await logFailure(
          {
            request,
            requestStartedAt,
            apiKey,
            requestedModel: parsed.data.model,
            message: lastErrorMessage,
            selectedModel: finalModel,
            provider: finalProvider,
            providerStatusAtRouting: healthAtRouting?.status,
            providerAvgLatencyAtRouting:
              healthAtRouting?.avgLatencyMs ?? healthAtRouting?.latencyMs,
            providerSuccessRateAtRouting:
              healthAtRouting?.successRate ?? healthAtRouting?.reliabilityScore,
            routingMode: route.routingMetadata.mode,
            routingStrategy: route.routingMetadata.routingStrategy,
          },
          dependencies.requestLogStore,
        );
        await persistAttemptLogs(
          dependencies.providerAttemptLogStore,
          attemptLogEntries,
          requestLogId,
        );
        await dependencies.executionPlanLogStore.create({
          requestLogId,
          workspaceId: user.workspaceId,
          userId: user.id,
          planType: effectivePlannerDecision.executionPlan,
          stepsJson: effectivePlannerDecision.steps,
          estimatedCostUsd: effectivePlannerDecision.estimatedCostUsd,
          actualCostUsd: 0,
          confidence: effectivePlannerDecision.confidence,
          reason: effectivePlannerDecision.reason,
          executed: true,
        });

        const resilience = buildResilienceMetadata({
          primaryProvider: effectivePrimaryProvider,
          primaryModel: effectivePrimaryModel,
          finalProvider,
          finalModel,
          circuitBreakerTriggered: fallbackOrder.circuitBreakerTriggered,
          attempts,
        });
        const executionPlan = buildExecutionPlanMetadata(effectivePlannerDecision, true, 0);

        return reply.status(502).send({
          ...openAiError({
            message: lastErrorMessage,
            type: "server_error",
            code: "provider_failure",
          }),
          resilience,
          executionPlan,
          routemind: {
            resilience,
            executionPlan,
          },
        });
      }

      const latencyMs = Date.now() - requestStartedAt;
      const actualUsage = {
        inputTokens: providerResponse.usage.prompt_tokens,
        outputTokens: providerResponse.usage.completion_tokens,
      };
      await dependencies.costGuardrailService.recordUsage({
        userId: user.id,
        workspaceId: user.workspaceId,
        actualCostUsd: finalActualCostUsd,
        totalTokens: actualUsage.inputTokens + actualUsage.outputTokens,
      });

      const requestLogId = await dependencies.requestLogStore.create({
        apiKey,
        workspaceId: user.workspaceId,
        requestedModel: parsed.data.model,
        selectedModel: finalModel,
        provider: finalProvider,
        inputTokens: actualUsage.inputTokens,
        outputTokens: actualUsage.outputTokens,
        estimatedCost: finalActualCostUsd,
        latencyMs,
        status: "success",
        providerStatusAtRouting: healthAtRouting?.status,
        providerAvgLatencyAtRouting: healthAtRouting?.avgLatencyMs ?? healthAtRouting?.latencyMs,
        providerSuccessRateAtRouting:
          healthAtRouting?.successRate ?? healthAtRouting?.reliabilityScore,
        routingMode: route.routingMetadata.mode,
        routingStrategy: route.routingMetadata.routingStrategy,
      });
      await dependencies.promptFirewallService.recordEvents({
        userId: user.id,
        workspaceId: user.workspaceId,
        requestLogId,
        events: firewall.events,
      });
      await persistAttemptLogs(
        dependencies.providerAttemptLogStore,
        attemptLogEntries,
        requestLogId,
      );
      await dependencies.executionPlanLogStore.create({
        requestLogId,
        workspaceId: user.workspaceId,
        userId: user.id,
        planType: effectivePlannerDecision.executionPlan,
        stepsJson: effectivePlannerDecision.steps,
        estimatedCostUsd: effectivePlannerDecision.estimatedCostUsd,
        actualCostUsd: finalActualCostUsd,
        confidence: effectivePlannerDecision.confidence,
        reason: effectivePlannerDecision.reason,
        executed: true,
      });
      await dependencies.routerDecisionLogStore.create({
        requestLogId,
        workspaceId: user.workspaceId,
        userId: user.id,
        mode: route.routingMetadata.mode,
        routerModelUsed: route.routingMetadata.routerModelUsed,
        detectedTask: route.routingMetadata.detectedTask,
        complexity: route.routingMetadata.complexity,
        candidateModelsJson: route.candidates.map((candidate) => ({
          provider: candidate.provider,
          model: candidate.model,
          costTier: candidate.capabilities.costTier,
          status: candidate.metrics.status,
          avgLatencyMs: candidate.metrics.avgLatencyMs,
          p95LatencyMs: candidate.metrics.p95LatencyMs,
          successRate: candidate.metrics.successRate,
          errorRate: candidate.metrics.errorRate,
          latencyMs: candidate.metrics.latencyMs,
          reliabilityScore: candidate.metrics.reliabilityScore,
        })),
        selectedModel: finalModel,
        selectedProvider: finalProvider,
        confidence: route.routingMetadata.routerConfidence,
        reason: route.routingMetadata.routerReason,
        fallbackUsed:
          finalProvider !== effectivePrimaryProvider || finalModel !== effectivePrimaryModel,
      });

      const costGuardrails = {
        estimatedCostUsd: estimateCost(finalModel, tokenEstimate),
        actualCostUsd: finalActualCostUsd,
        budgetRemainingUsd: finalGuardrailCheck?.budgetRemainingUsd,
        budgetUsagePercent: finalGuardrailCheck?.budgetUsagePercent,
        quotaRemainingRequests: finalGuardrailCheck?.quotaRemainingRequests,
        quotaRemainingTokens: finalGuardrailCheck?.quotaRemainingTokens,
      };
      const resilience = buildResilienceMetadata({
        primaryProvider: effectivePrimaryProvider,
        primaryModel: effectivePrimaryModel,
        finalProvider,
        finalModel,
        circuitBreakerTriggered: fallbackOrder.circuitBreakerTriggered,
        attempts,
      });
      const executionPlan = buildExecutionPlanMetadata(
        effectivePlannerDecision,
        true,
        finalActualCostUsd,
      );

      const responseBody = {
        ...providerResponse,
        metadata: {
          requestedModel: parsed.data.model,
          selectedModel: finalModel,
          provider: finalProvider,
          inputTokens: actualUsage.inputTokens,
          outputTokens: actualUsage.outputTokens,
          estimatedCost: finalActualCostUsd,
          latencyMs,
          routingReason: route.routingReason,
          costGuardrails,
          resilience,
          executionPlan,
          firewall: firewallMetadata,
        },
        routingMetadata: route.routingMetadata,
        resilience,
        executionPlan,
        firewall: firewallMetadata,
        routemind: {
          routing: route.routingMetadata,
          resilience,
          costGuardrails,
          executionPlan,
          firewall: firewallMetadata,
        },
      };

      const responseWithCacheMetadata =
        cachePlan.lookupMode === "exact"
          ? attachCacheMetadata(responseBody, {
              hit: false,
              mode: cachePlan.requestedMode,
              semanticFallback: cachePlan.semanticFallback,
            })
          : responseBody;

      if (
        cacheKey &&
        shouldStoreCache(parsed.data.cache, parsed.data.stream, parsed.data.temperature) &&
        !hasUnsupportedToolCalls(responseWithCacheMetadata)
      ) {
        await dependencies.cacheService.setExactCache({
          userId: user.id,
          workspaceId: user.workspaceId,
          cacheKey: cacheKey.cacheKey,
          normalizedPromptHash: cacheKey.normalizedPromptHash,
          promptText: cacheKey.promptText,
          responseJson: responseWithCacheMetadata,
          model: finalModel,
          provider: finalProvider,
          inputTokens: actualUsage.inputTokens,
          outputTokens: actualUsage.outputTokens,
          estimatedCostUsd: finalActualCostUsd,
          ttlSeconds: parsed.data.cache.ttlSeconds,
        });
      }

      if (parsed.data.stream) {
        request.log.info(
          {
            requestId: request.id,
            userId: user.id,
            workspaceId: user.workspaceId,
            provider: finalProvider,
            model: finalModel,
            latencyMs,
            status: "success",
          },
          "chat completion stream prepared",
        );
        return sendStreamingResponse(reply, responseBody);
      }

      request.log.info(
        {
          requestId: request.id,
          userId: user.id,
          workspaceId: user.workspaceId,
          provider: finalProvider,
          model: finalModel,
          latencyMs,
          status: "success",
        },
        "chat completion request completed",
      );
      return reply.send(responseWithCacheMetadata);
    },
  );
}

function extractRequestedModel(body: unknown): string {
  if (typeof body === "object" && body !== null && "model" in body) {
    const model = (body as { model?: unknown }).model;
    return typeof model === "string" ? model : "unknown";
  }

  return "unknown";
}

interface CachePlan {
  readonly requestedMode: CacheMode;
  readonly lookupMode?: "exact";
  readonly semanticFallback?: boolean;
}

interface CacheResponseMetadata {
  readonly hit: boolean;
  readonly mode: CacheMode;
  readonly costSavedUsd?: number;
  readonly originalModel?: string;
  readonly originalProvider?: string;
  readonly semanticFallback?: boolean;
}

function buildCachePlan(
  options: CacheRequestOptions,
  stream: boolean,
  temperature?: number,
): CachePlan {
  const requestedMode = options.mode ?? "exact";
  if (requestedMode === "disabled" || options.bypass || stream || (temperature ?? 0) > 0.7) {
    return { requestedMode };
  }

  if (requestedMode === "semantic") {
    return { requestedMode, lookupMode: "exact", semanticFallback: true };
  }

  return { requestedMode, lookupMode: "exact" };
}

function shouldStoreCache(
  options: CacheRequestOptions,
  stream: boolean,
  temperature?: number,
): boolean {
  return Boolean(buildCachePlan(options, stream, temperature).lookupMode);
}

function attachCacheMetadata(
  responseJson: unknown,
  cache: CacheResponseMetadata,
): Record<string, unknown> {
  const response = cloneRecord(responseJson);
  const metadata = isUnknownRecord(response.metadata) ? response.metadata : {};
  const routemind = isUnknownRecord(response.routemind) ? response.routemind : {};

  response.metadata = {
    ...metadata,
    cache,
  };
  response.routemind = {
    ...routemind,
    cache,
  };

  return response;
}

function attachFirewallMetadata(
  responseJson: unknown,
  firewall: ReturnType<typeof buildFirewallMetadata>,
): Record<string, unknown> {
  const response = cloneRecord(responseJson);
  const metadata = isUnknownRecord(response.metadata) ? response.metadata : {};
  const routemind = isUnknownRecord(response.routemind) ? response.routemind : {};

  response.metadata = {
    ...metadata,
    firewall,
  };
  response.firewall = firewall;
  response.routemind = {
    ...routemind,
    firewall,
  };

  return response;
}

function buildFirewallMetadata(result: FirewallInspectionResult) {
  return {
    inspected: true,
    action: result.action,
    events: result.events.map((event) => ({
      type: event.type,
      severity: event.severity,
      action: event.action,
      message: event.message,
    })),
  };
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    return {};
  }

  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnsupportedToolCalls(response: Record<string, unknown>): boolean {
  const choices = response.choices;
  if (!Array.isArray(choices)) {
    return false;
  }

  return choices.some((choice) => {
    if (!isUnknownRecord(choice) || !isUnknownRecord(choice.message)) {
      return false;
    }

    const toolCalls = choice.message.tool_calls;
    return Array.isArray(toolCalls) && toolCalls.length > 0;
  });
}

function sendStreamingResponse(
  reply: FastifyReply,
  response: ProviderResponse & {
    readonly routemind: {
      readonly routing: unknown;
      readonly resilience: unknown;
      readonly costGuardrails: unknown;
      readonly executionPlan: unknown;
      readonly firewall?: unknown;
    };
  },
) {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const content = response.choices[0]?.message.content ?? "";
  for (const chunk of splitStreamContent(content)) {
    writeSse(reply, {
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: response.model,
      choices: [
        {
          index: 0,
          delta: { content: chunk },
          finish_reason: null,
        },
      ],
    });
  }

  writeSse(reply, {
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: response.choices[0]?.finish_reason ?? "stop",
      },
    ],
  });
  writeSse(reply, { routemind: response.routemind });
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
  return reply;
}

function writeSse(reply: FastifyReply, value: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(value)}\n\n`);
}

function splitStreamContent(content: string): readonly string[] {
  const chunks = content.match(/.{1,16}(\s|$)|.{1,16}/g);
  return chunks?.filter((chunk) => chunk.length > 0) ?? [];
}

function extractApiKey(request: FastifyRequest): string | undefined {
  const directApiKey = request.headers["x-api-key"];
  if (typeof directApiKey === "string" && directApiKey.length > 0) {
    return directApiKey;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return undefined;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function openAiError(input: {
  readonly message: string;
  readonly type:
    "invalid_request_error" | "authentication_error" | "rate_limit_error" | "server_error";
  readonly code: string;
  readonly issues?: unknown;
  readonly routingMetadata?: unknown;
  readonly costGuardrails?: unknown;
}) {
  return {
    error: {
      message: input.message,
      type: input.type,
      code: input.code,
      issues: input.issues,
      routingMetadata: input.routingMetadata,
      costGuardrails: input.costGuardrails,
    },
  };
}

async function logFailure(
  options: LogFailureOptions,
  requestLogStore: RequestLogStore,
): Promise<string> {
  const requestLogId = await requestLogStore.create({
    apiKey: options.apiKey,
    workspaceId: options.workspaceId,
    requestedModel: options.requestedModel,
    selectedModel: options.selectedModel,
    provider: options.provider,
    latencyMs: Date.now() - options.requestStartedAt,
    status: "failed",
    errorMessage: options.message,
    providerStatusAtRouting: options.providerStatusAtRouting,
    providerAvgLatencyAtRouting: options.providerAvgLatencyAtRouting,
    providerSuccessRateAtRouting: options.providerSuccessRateAtRouting,
    routingMode: options.routingMode,
    routingStrategy: options.routingStrategy,
  });

  options.request.log.warn(
    {
      requestId: options.request.id,
      workspaceId: options.workspaceId,
      apiKey: options.apiKey === "missing" ? "missing" : maskApiKey(options.apiKey),
      requestedModel: options.requestedModel,
      provider: options.provider,
      model: options.selectedModel,
      latencyMs: Date.now() - options.requestStartedAt,
      status: "failed",
      errorCode: "request_failed",
      errorMessage: options.message,
    },
    "chat completion request failed",
  );

  return requestLogId;
}

async function persistAttemptLogs(
  providerAttemptLogStore: ProviderAttemptLogStore,
  entries: readonly ProviderAttemptLogEntry[],
  requestLogId: string,
): Promise<void> {
  await Promise.all(
    entries.map((entry) =>
      providerAttemptLogStore.create({
        ...entry,
        requestLogId,
      }),
    ),
  );
}

function buildResilienceMetadata(input: {
  readonly primaryProvider: string;
  readonly primaryModel: string;
  readonly finalProvider: string;
  readonly finalModel: string;
  readonly circuitBreakerTriggered: boolean;
  readonly attempts: readonly ResilienceAttemptMetadata[];
}) {
  return {
    primaryProvider: input.primaryProvider,
    primaryModel: input.primaryModel,
    finalProvider: input.finalProvider,
    finalModel: input.finalModel,
    fallbackUsed:
      input.primaryProvider !== input.finalProvider || input.primaryModel !== input.finalModel,
    circuitBreakerTriggered: input.circuitBreakerTriggered,
    attempts: input.attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      latencyMs: attempt.latencyMs,
      errorType: attempt.errorType,
      errorMessage: attempt.errorMessage,
    })),
  };
}

function buildExecutionPlanMetadata(
  decision: AIPlannerDecision,
  executed: boolean,
  actualCostUsd?: number,
): ExecutionPlanMetadata {
  return {
    planType: decision.executionPlan,
    steps: decision.steps,
    estimatedCostUsd: decision.estimatedCostUsd,
    actualCostUsd,
    confidence: decision.confidence,
    reason: decision.reason,
    executed,
  };
}

async function validatePlannerDecision(
  decision: AIPlannerDecision,
  candidates: readonly RoutingCandidateModel[],
  circuitBreakerService: CircuitBreakerService,
): Promise<{ readonly valid: true } | { readonly valid: false; readonly reason: string }> {
  if (!decision.executable) {
    return { valid: true };
  }

  if (decision.steps.length !== 1) {
    return { valid: false, reason: "executable MVP plans must contain exactly one step" };
  }

  const step = decision.steps[0];
  if (!step) {
    return { valid: false, reason: "plan has no executable step" };
  }

  const candidate = candidates.find(
    (item) => item.provider === step.provider && item.model === step.model,
  );
  if (!candidate) {
    return { valid: false, reason: "planned model is not an eligible routing candidate" };
  }

  if (!(await circuitBreakerService.canAttempt(step.provider, step.model))) {
    return { valid: false, reason: "planned model circuit is open" };
  }

  return { valid: true };
}

function buildFallbackSingleModelPlan(input: {
  readonly provider: string;
  readonly model: string;
  readonly estimatedCostUsd: number;
  readonly reason: string;
}): AIPlannerDecision {
  return {
    executionPlan: "single_model",
    steps: [
      {
        step: 1,
        purpose: "answer_user_request",
        provider: input.provider,
        model: input.model,
        reason: "Normal routing fallback after planner validation.",
      },
    ],
    estimatedCostUsd: input.estimatedCostUsd,
    reason: input.reason,
    confidence: 0.7,
    executable: true,
  };
}

function getProviderErrorMessage(error: unknown): string {
  if (isProviderError(error)) {
    return error.message;
  }

  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Provider request failed.";
}

function toHealthErrorCode(error: unknown, errorType: ProviderErrorType): ProviderRequestErrorCode {
  if (isProviderError(error)) {
    return error.code;
  }

  switch (errorType) {
    case "TIMEOUT":
      return "timeout";
    case "RATE_LIMIT":
      return "rate_limit";
    case "AUTH_ERROR":
      return "invalid_api_key";
    case "BAD_REQUEST":
      return "provider_bad_request";
    case "PROVIDER_UNAVAILABLE":
    case "NETWORK_ERROR":
    case "SERVER_ERROR":
      return "provider_unavailable";
    case "UNKNOWN":
    default:
      return "unknown";
  }
}

function toRoutingMetrics(metrics: readonly ProviderHealthMetric[]) {
  return metrics.map((metric) => ({
    provider: metric.provider,
    model: metric.model,
    status: metric.status,
    healthy: metric.status === "healthy",
    latencyMs: metric.avgLatencyMs,
    reliabilityScore: metric.successRate,
    avgLatencyMs: metric.avgLatencyMs,
    p95LatencyMs: metric.p95LatencyMs,
    successRate: metric.successRate,
    errorRate: metric.errorRate,
    timeoutRate: metric.timeoutRate,
    rateLimitRate: metric.rateLimitRate,
    sampleSize: metric.sampleSize,
    lastCheckedAt: metric.lastCheckedAt,
  }));
}
