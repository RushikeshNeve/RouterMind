import { estimateCost, estimateTokens } from "@routemind/cost-engine";
import type { ProviderResponse } from "@routemind/core";
import { type ProviderAdapter, isProviderError } from "@routemind/providers";
import { type RouterLLMService, decideLLMRoute } from "@routemind/routing";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import type { ApiKeyAuthenticator } from "../infrastructure/authenticator.js";
import type { RateLimiter } from "../infrastructure/rate-limiter.js";
import type { RequestLogStore } from "../infrastructure/request-log-store.js";
import type { RouterDecisionLogStore } from "../infrastructure/router-decision-log-store.js";
import type {
  ProviderHealthMetric,
  ProviderHealthService,
} from "../infrastructure/provider-health-service.js";
import type {
  UserAvailabilityStore,
  UserProviderAvailability,
} from "../infrastructure/user-availability.js";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
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
    })
    .optional()
    .default({ mode: "llm_assisted", strategy: "balanced" }),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional().default(false),
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
  readonly providers?: Map<string, ProviderAdapter>;
  readonly providerFactory: (
    apiKeys: UserProviderAvailability["providerApiKeys"],
  ) => Map<string, ProviderAdapter>;
  readonly routerLLMServiceFactory: (providers: Map<string, ProviderAdapter>) => RouterLLMService;
}

interface LogFailureOptions {
  readonly request: FastifyRequest;
  readonly requestStartedAt: number;
  readonly apiKey: string;
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
      const apiKey = request.headers["x-api-key"];

      if (typeof apiKey !== "string" || apiKey.length === 0) {
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
        return reply.status(401).send({ error: { message: "Missing or invalid API key." } });
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
        return reply.status(401).send({ error: { message: "Missing or invalid API key." } });
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
        return reply.status(429).send({ error: { message: "Rate limit exceeded." } });
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
        return reply.status(400).send({
          error: {
            message: "Invalid request body.",
            issues: parsed.error.flatten(),
          },
        });
      }

      if (parsed.data.stream) {
        await logFailure(
          {
            request,
            requestStartedAt,
            apiKey,
            requestedModel: parsed.data.model,
            message: "Streaming is not supported in MVP yet.",
          },
          dependencies.requestLogStore,
        );
        return reply.status(400).send({
          error: {
            message: "Streaming is not supported in MVP yet.",
          },
        });
      }

      const availability = await dependencies.availabilityStore.getAvailability(user);
      const providers =
        dependencies.providers ?? dependencies.providerFactory(availability.providerApiKeys);
      const promptCharacters = parsed.data.messages.reduce(
        (total, message) => total + message.content.length,
        0,
      );
      const tokenEstimate = estimateTokens(promptCharacters);
      const liveMetrics = toRoutingMetrics(await dependencies.providerHealthService.list());
      const route = await decideLLMRoute({
        requestedModel: parsed.data.model,
        messages: parsed.data.messages,
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

        return reply.status(400).send({
          error: {
            message,
            routingMetadata: route.routingMetadata,
          },
        });
      }

      const provider = providers.get(route.provider);
      const healthAtRouting = route.candidates.find(
        (candidate) =>
          candidate.provider === route.provider && candidate.model === route.selectedModel,
      )?.metrics;

      if (!provider) {
        await logFailure(
          {
            request,
            requestStartedAt,
            apiKey,
            requestedModel: parsed.data.model,
            message: `No provider registered for ${route.provider}`,
          },
          dependencies.requestLogStore,
        );
        return reply.status(502).send({ error: { message: "Selected provider is unavailable." } });
      }

      let providerResponse: ProviderResponse;

      try {
        providerResponse = await provider.chatCompletion({
          model: route.selectedModel,
          messages: parsed.data.messages,
          temperature: parsed.data.temperature,
          stream: false,
          estimatedUsage: tokenEstimate,
        });
      } catch (error) {
        const message = isProviderError(error) ? error.message : "Provider request failed.";
        const statusCode = isProviderError(error) ? error.statusCode : 502;
        const latencyMs = Date.now() - requestStartedAt;

        await dependencies.providerHealthService.record({
          provider: route.provider,
          model: route.selectedModel,
          latencyMs,
          success: false,
          errorCode: isProviderError(error) ? error.code : "unknown",
          errorMessage: message,
          timestamp: new Date(),
        });

        await logFailure(
          {
            request,
            requestStartedAt,
            apiKey,
            requestedModel: parsed.data.model,
            message,
            selectedModel: route.selectedModel,
            provider: route.provider,
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

        request.log.warn(
          {
            provider: route.provider,
            selectedModel: route.selectedModel,
            errorCode: isProviderError(error) ? error.code : "provider_error",
          },
          "provider request failed",
        );

        return reply.status(statusCode).send({
          error: {
            message,
          },
        });
      }

      const latencyMs = Date.now() - requestStartedAt;
      await dependencies.providerHealthService.record({
        provider: route.provider,
        model: route.selectedModel,
        latencyMs,
        success: true,
        timestamp: new Date(),
      });
      const actualUsage = {
        inputTokens: providerResponse.usage.prompt_tokens,
        outputTokens: providerResponse.usage.completion_tokens,
      };
      const estimatedCost = estimateCost(route.selectedModel, actualUsage);

      const requestLogId = await dependencies.requestLogStore.create({
        apiKey,
        requestedModel: parsed.data.model,
        selectedModel: route.selectedModel,
        provider: route.provider,
        inputTokens: actualUsage.inputTokens,
        outputTokens: actualUsage.outputTokens,
        estimatedCost,
        latencyMs,
        status: "success",
        providerStatusAtRouting: healthAtRouting?.status,
        providerAvgLatencyAtRouting: healthAtRouting?.avgLatencyMs ?? healthAtRouting?.latencyMs,
        providerSuccessRateAtRouting:
          healthAtRouting?.successRate ?? healthAtRouting?.reliabilityScore,
        routingMode: route.routingMetadata.mode,
        routingStrategy: route.routingMetadata.routingStrategy,
      });
      await dependencies.routerDecisionLogStore.create({
        requestLogId,
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
        selectedModel: route.selectedModel,
        selectedProvider: route.provider,
        confidence: route.routingMetadata.routerConfidence,
        reason: route.routingMetadata.routerReason,
        fallbackUsed: route.routingMetadata.fallbackUsed,
      });

      return reply.send({
        ...providerResponse,
        metadata: {
          requestedModel: parsed.data.model,
          selectedModel: route.selectedModel,
          provider: route.provider,
          inputTokens: actualUsage.inputTokens,
          outputTokens: actualUsage.outputTokens,
          estimatedCost,
          latencyMs,
          routingReason: route.routingReason,
        },
        routingMetadata: route.routingMetadata,
      });
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

async function logFailure(
  options: LogFailureOptions,
  requestLogStore: RequestLogStore,
): Promise<void> {
  await requestLogStore.create({
    apiKey: options.apiKey,
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
      apiKey: options.apiKey === "missing" ? "missing" : "provided",
      requestedModel: options.requestedModel,
      errorMessage: options.message,
    },
    "chat completion request failed",
  );
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
