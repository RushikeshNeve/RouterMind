import type { AiGatewayRequest, GatewayRequestContext } from "@routemind/core";
import { modelPricing } from "@routemind/cost-engine";
import { getModelRegistryEntry, modelRegistry, type ProviderId } from "@routemind/providers";

import type { RouterConfigSource } from "./router-config.js";

export * from "./router-config.js";

export interface RoutingCandidate {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly estimatedCostUsd?: number;
  readonly estimatedLatencyMs?: number;
}

export interface RoutingDecision {
  readonly selected: RoutingCandidate;
  readonly candidates: readonly RoutingCandidate[];
  readonly strategy: string;
  readonly decidedAt: Date;
}

export interface RoutingStrategy {
  readonly name: string;
  decide(
    request: AiGatewayRequest,
    context: GatewayRequestContext,
    candidates: readonly RoutingCandidate[],
  ): Promise<RoutingDecision>;
}

export interface ChatRoutingInput {
  readonly requestedModel: string;
  readonly messages: readonly {
    readonly content: string;
  }[];
  readonly availableModels?: readonly string[];
}

export interface ChatRoute {
  readonly provider: ProviderId;
  readonly selectedModel: string;
  readonly routingReason: string;
  readonly routingMetadata: RoutingMetadata;
  readonly unsupported?: false;
}

export interface UnsupportedChatRoute {
  readonly requestedModel: string;
  readonly routingReason: string;
  readonly routingMetadata: RoutingMetadata;
  readonly unsupported: true;
}

export interface RoutingMetadata {
  readonly idealModel: string;
  readonly selectedModel?: string;
  readonly selectedProvider?: ProviderId;
  readonly availableModels: readonly string[];
  readonly unavailableReason?: string;
  readonly routingStrategy: string;
  readonly fallbackUsed: boolean;
}

export type RouterDecisionMode = "rule_based" | "score_based" | "llm_assisted";
export type RouterStrategy = "balanced" | "cost_first" | "latency_first" | "quality_first";
export type DetectedTask =
  | "code"
  | "debugging"
  | "summarization"
  | "rewriting"
  | "reasoning"
  | "system_design"
  | "extraction"
  | "simple_chat"
  | "unknown";

export interface RoutingPolicy {
  readonly maxCostTier?: "low" | "medium" | "high";
  readonly blockedProviders?: readonly ProviderId[];
  readonly blockedModels?: readonly string[];
  readonly requireHealthyProviders?: boolean;
  readonly allowUnhealthyProviders?: boolean;
}

export interface LiveProviderMetric {
  readonly provider: ProviderId;
  readonly model?: string;
  readonly status?: "healthy" | "degraded" | "down";
  readonly healthy: boolean;
  readonly latencyMs: number;
  readonly reliabilityScore: number;
  readonly avgLatencyMs?: number;
  readonly p95LatencyMs?: number;
  readonly successRate?: number;
  readonly errorRate?: number;
  readonly timeoutRate?: number;
  readonly rateLimitRate?: number;
  readonly sampleSize?: number;
  readonly lastCheckedAt?: Date;
}

export interface ModelEvaluationScore {
  readonly model: string;
  readonly score: number;
}

export interface RoutingCandidateModel {
  readonly provider: ProviderId;
  readonly model: string;
  readonly capabilities: (typeof modelRegistry)[keyof typeof modelRegistry];
  readonly pricing: (typeof modelPricing)[string] | undefined;
  readonly metrics: LiveProviderMetric;
  readonly evaluationScore?: number;
}

export interface RouterLLMDecision {
  readonly detectedTask: DetectedTask;
  readonly complexity: "low" | "medium" | "high";
  readonly selectedProvider: ProviderId;
  readonly selectedModel: string;
  readonly fallbackModels: readonly {
    readonly provider: ProviderId;
    readonly model: string;
    readonly reason: string;
  }[];
  readonly reason: string;
  readonly confidence: number;
  readonly routerModelUsed?: string;
  // Which BYO Router Model scope resolveRouterConfig() resolved to, so
  // callers can tell "the workspace's own config was used" apart from
  // "the platform default was used" -- set even when the resolved provider
  // turned out to be unusable and a mock decision was returned instead.
  readonly configSource?: RouterConfigSource;
}

export interface RouterLLMRequest {
  readonly userPrompt: string;
  readonly messageCount: number;
  readonly approximateInputTokens: number;
  readonly candidates: readonly RoutingCandidateModel[];
  readonly policy: RoutingPolicy;
  readonly strategy: RouterStrategy;
  readonly evaluationScores: readonly ModelEvaluationScore[];
}

export interface RouterLLMService {
  decide(request: RouterLLMRequest): Promise<RouterLLMDecision>;
}

export interface LLMEngineInput {
  readonly requestedModel: string;
  readonly messages: readonly { readonly content: string }[];
  readonly availableModels: readonly string[];
  readonly enabledProviders: readonly ProviderId[];
  readonly providerApiKeys?: Partial<Record<ProviderId, string | undefined>>;
  readonly mode: RouterDecisionMode;
  readonly strategy: RouterStrategy;
  readonly policy: RoutingPolicy;
  readonly liveMetrics?: readonly LiveProviderMetric[];
  readonly evaluationScores?: readonly ModelEvaluationScore[];
  readonly approximateInputTokens: number;
  readonly routerLLMEnabled: boolean;
  readonly routerLLMService: RouterLLMService;
}

export interface LLMEngineDecision {
  readonly provider: ProviderId;
  readonly selectedModel: string;
  readonly routingReason: string;
  readonly candidates: readonly RoutingCandidateModel[];
  readonly routerDecision?: RouterLLMDecision;
  readonly routingMetadata: RoutingMetadata & {
    readonly mode: RouterDecisionMode;
    readonly detectedTask: DetectedTask;
    readonly complexity: "low" | "medium" | "high";
    readonly selectedProvider: ProviderId;
    readonly routerModelUsed?: string;
    readonly routerConfidence?: number;
    readonly routerReason: string;
    readonly configSource?: RouterConfigSource;
    readonly hardConstraintsApplied: readonly string[];
  };
  readonly unsupported?: false;
}

export interface UnsupportedLLMEngineDecision {
  readonly routingReason: string;
  readonly candidates: readonly RoutingCandidateModel[];
  readonly routingMetadata: RoutingMetadata & {
    readonly mode: RouterDecisionMode;
    readonly detectedTask: DetectedTask;
    readonly complexity: "low" | "medium" | "high";
    readonly routerReason: string;
    readonly hardConstraintsApplied: readonly string[];
  };
  readonly unsupported: true;
}

const defaultMetrics: Record<ProviderId, LiveProviderMetric> = {
  anthropic: { provider: "anthropic", healthy: true, latencyMs: 900, reliabilityScore: 0.98 },
  gemini: { provider: "gemini", healthy: true, latencyMs: 500, reliabilityScore: 0.96 },
  groq: { provider: "groq", healthy: true, latencyMs: 250, reliabilityScore: 0.94 },
  openai: { provider: "openai", healthy: true, latencyMs: 700, reliabilityScore: 0.97 },
};

const fallbackMetric: LiveProviderMetric = {
  provider: "openai",
  healthy: true,
  latencyMs: 700,
  reliabilityScore: 0.97,
};

const tierRank = {
  low: 1,
  medium: 2,
  high: 3,
  standard: 1,
  strong: 2,
  premium: 3,
};

// Distinct, stable reason strings for every way the llm_assisted path can
// fall through to score_based routing -- these used to collapse into one
// generic "Router LLM skipped or invalid" string, making it impossible to
// tell "disabled by config" apart from "the router call threw" apart from
// "the router picked a model that isn't actually available." Exported so
// tests can assert exact equality instead of fragile substring matching.
export const LLM_ROUTING_DISABLED_REASON =
  "LLM-assisted routing is disabled (ROUTER_LLM_ENABLED=false); used score_based fallback instead";
export const LLM_ROUTING_STRATEGY_SKIP_REASON =
  "LLM-assisted routing skipped for a cost_first, simple, low-complexity request; used score_based fallback instead";
export const LLM_ROUTING_CALL_FAILED_REASON =
  "Router LLM call failed or returned an invalid decision; used score_based fallback instead";
export const LLM_ROUTING_NO_CANDIDATE_MATCH_REASON =
  "Router LLM's selected provider/model was not among the available candidates; used score_based fallback instead";

export async function decideLLMRoute(
  input: LLMEngineInput,
): Promise<LLMEngineDecision | UnsupportedLLMEngineDecision> {
  const task = detectTask(input.messages);
  const complexity = detectComplexity(input.messages);
  const hardConstraintsApplied: string[] = [];

  if (input.requestedModel !== "auto" && !getModelRegistryEntry(input.requestedModel)) {
    return {
      routingReason: "unsupported model",
      candidates: [],
      routingMetadata: {
        idealModel: input.requestedModel,
        availableModels: input.availableModels,
        unavailableReason: "requested model is not registered",
        mode: input.mode,
        detectedTask: task,
        complexity,
        routerReason: "unsupported model",
        hardConstraintsApplied: [],
        routingStrategy: input.strategy,
        fallbackUsed: false,
      },
      unsupported: true,
    };
  }

  const candidates = buildCandidates(input, hardConstraintsApplied);

  if (candidates.length === 0) {
    return unsupportedDecision(input, task, complexity, hardConstraintsApplied, candidates);
  }

  if (input.requestedModel !== "auto") {
    const directCandidate = candidates.find(
      (candidate) => candidate.model === input.requestedModel,
    );

    if (!directCandidate) {
      return unsupportedDecision(input, task, complexity, hardConstraintsApplied, candidates);
    }

    return toEngineDecision({
      input,
      task,
      complexity,
      candidate: directCandidate,
      idealModel: input.requestedModel,
      candidates,
      reason: "direct model request",
      hardConstraintsApplied,
      mode: input.mode,
    });
  }

  let llmAssistedFallbackReason: string | undefined;

  if (input.mode === "llm_assisted") {
    if (!input.routerLLMEnabled) {
      llmAssistedFallbackReason = LLM_ROUTING_DISABLED_REASON;
    } else if (input.strategy === "cost_first" && task === "simple_chat" && complexity === "low") {
      llmAssistedFallbackReason = LLM_ROUTING_STRATEGY_SKIP_REASON;
    } else {
      try {
        const routerDecision = await input.routerLLMService.decide({
          userPrompt: input.messages.map((message) => message.content).join("\n"),
          messageCount: input.messages.length,
          approximateInputTokens: input.approximateInputTokens,
          candidates,
          policy: input.policy,
          strategy: input.strategy,
          evaluationScores: input.evaluationScores ?? [],
        });
        const candidate = candidates.find(
          (item) =>
            item.model === routerDecision.selectedModel &&
            item.provider === routerDecision.selectedProvider,
        );

        if (candidate) {
          return toEngineDecision({
            input,
            task: routerDecision.detectedTask,
            complexity: routerDecision.complexity,
            candidate,
            idealModel: idealModelForTask(task),
            candidates,
            reason: routerDecision.reason,
            hardConstraintsApplied,
            mode: "llm_assisted",
            routerDecision,
          });
        }

        llmAssistedFallbackReason = LLM_ROUTING_NO_CANDIDATE_MATCH_REASON;
      } catch {
        llmAssistedFallbackReason = LLM_ROUTING_CALL_FAILED_REASON;
      }
    }
  }

  const scoreCandidate = selectScoreBasedCandidate(candidates, task, complexity, input.strategy);

  return toEngineDecision({
    input,
    task,
    complexity,
    candidate: scoreCandidate,
    idealModel: idealModelForTask(task),
    candidates,
    reason: llmAssistedFallbackReason ?? `${input.mode} routing selected best-scored candidate`,
    hardConstraintsApplied,
    mode: input.mode === "rule_based" ? "rule_based" : "score_based",
  });
}

function buildCandidates(
  input: LLMEngineInput,
  hardConstraintsApplied: string[],
): RoutingCandidateModel[] {
  const metrics = new Map(
    (input.liveMetrics ?? Object.values(defaultMetrics)).flatMap((metric) => [
      [metric.provider, metric] as const,
      ...(metric.model ? ([[`${metric.provider}:${metric.model}`, metric] as const] as const) : []),
    ]),
  );
  const evaluationScores = new Map(
    (input.evaluationScores ?? []).map((score) => [score.model, score.score]),
  );
  const maxCostRank = input.policy.maxCostTier ? tierRank[input.policy.maxCostTier] : undefined;

  return Object.values(modelRegistry)
    .filter((entry) => {
      if (!input.enabledProviders.includes(entry.provider)) {
        hardConstraintsApplied.push(`provider disabled:${entry.provider}`);
        return false;
      }

      if (!input.availableModels.includes(entry.modelId)) {
        hardConstraintsApplied.push(`model disabled:${entry.modelId}`);
        return false;
      }

      if (
        input.providerApiKeys &&
        input.providerApiKeys[entry.provider] !== undefined &&
        input.providerApiKeys[entry.provider]?.length === 0
      ) {
        hardConstraintsApplied.push(`provider credential missing:${entry.provider}`);
        return false;
      }

      if (input.policy.blockedProviders?.includes(entry.provider)) {
        hardConstraintsApplied.push(`provider blocked:${entry.provider}`);
        return false;
      }

      if (input.policy.blockedModels?.includes(entry.modelId)) {
        hardConstraintsApplied.push(`model blocked:${entry.modelId}`);
        return false;
      }

      if (maxCostRank && tierRank[entry.costTier] > maxCostRank) {
        hardConstraintsApplied.push(`cost tier blocked:${entry.modelId}`);
        return false;
      }

      const metric = getMetric(metrics, entry.provider);
      if (metric.status === "down" && !input.policy.allowUnhealthyProviders) {
        hardConstraintsApplied.push(`model down:${entry.modelId}`);
        return false;
      }

      if (
        input.policy.requireHealthyProviders &&
        (!metric.healthy || metric.status === "degraded" || metric.status === "down")
      ) {
        hardConstraintsApplied.push(`model not healthy:${entry.modelId}`);
        return false;
      }

      return true;
    })
    .map((entry) => ({
      provider: entry.provider,
      model: entry.modelId,
      capabilities: entry,
      pricing: modelPricing[entry.modelId],
      metrics: getMetric(metrics, entry.provider, entry.modelId),
      evaluationScore: evaluationScores.get(entry.modelId),
    }));
}

function selectScoreBasedCandidate(
  candidates: readonly RoutingCandidateModel[],
  task: DetectedTask,
  complexity: "low" | "medium" | "high",
  strategy: RouterStrategy,
): RoutingCandidateModel {
  const preferences = preferencesForTask(task);
  const preferred = [...candidates].sort((a, b) => {
    const normalizedPreferenceDelta =
      (preferences.includes(a.model) ? preferences.indexOf(a.model) : 999) -
      (preferences.includes(b.model) ? preferences.indexOf(b.model) : 999);

    if (strategy === "quality_first" || complexity === "high") {
      return (
        healthPenalty(a) - healthPenalty(b) ||
        tierRank[b.capabilities.qualityTier] - tierRank[a.capabilities.qualityTier] ||
        normalizedPreferenceDelta
      );
    }

    if (strategy === "cost_first") {
      return (
        healthPenalty(a) - healthPenalty(b) ||
        tierRank[a.capabilities.costTier] - tierRank[b.capabilities.costTier] ||
        normalizedPreferenceDelta
      );
    }

    if (strategy === "latency_first") {
      return (
        healthPenalty(a) - healthPenalty(b) ||
        a.metrics.latencyMs - b.metrics.latencyMs ||
        normalizedPreferenceDelta
      );
    }

    return (
      healthPenalty(a) - healthPenalty(b) ||
      normalizedPreferenceDelta ||
      (b.evaluationScore ?? 0) - (a.evaluationScore ?? 0) ||
      b.metrics.reliabilityScore - a.metrics.reliabilityScore ||
      a.metrics.latencyMs - b.metrics.latencyMs
    );
  });

  return preferred[0] ?? candidates[0]!;
}

function toEngineDecision(options: {
  readonly input: LLMEngineInput;
  readonly task: DetectedTask;
  readonly complexity: "low" | "medium" | "high";
  readonly candidate: RoutingCandidateModel;
  readonly idealModel: string;
  readonly candidates: readonly RoutingCandidateModel[];
  readonly reason: string;
  readonly hardConstraintsApplied: readonly string[];
  readonly mode: RouterDecisionMode;
  readonly routerDecision?: RouterLLMDecision;
}): LLMEngineDecision {
  return {
    provider: options.candidate.provider,
    selectedModel: options.candidate.model,
    routingReason: options.reason,
    candidates: options.candidates,
    routerDecision: options.routerDecision,
    routingMetadata: {
      idealModel: options.idealModel,
      selectedModel: options.candidate.model,
      selectedProvider: options.candidate.provider,
      availableModels: options.candidates.map((candidate) => candidate.model),
      mode: options.mode,
      detectedTask: options.task,
      complexity: options.complexity,
      routerModelUsed: options.routerDecision?.routerModelUsed,
      routerConfidence: options.routerDecision?.confidence,
      routerReason: options.reason,
      configSource: options.routerDecision?.configSource,
      hardConstraintsApplied: dedupe(options.hardConstraintsApplied),
      routingStrategy: options.input.strategy,
      fallbackUsed: options.candidate.model !== options.idealModel,
    },
    unsupported: false,
  };
}

function unsupportedDecision(
  input: LLMEngineInput,
  task: DetectedTask,
  complexity: "low" | "medium" | "high",
  hardConstraintsApplied: readonly string[],
  candidates: readonly RoutingCandidateModel[],
): UnsupportedLLMEngineDecision {
  return {
    routingReason: "no suitable model available after hard constraints",
    candidates,
    routingMetadata: {
      idealModel: idealModelForTask(task),
      availableModels: candidates.map((candidate) => candidate.model),
      unavailableReason: "no candidate models satisfied hard constraints",
      mode: input.mode,
      detectedTask: task,
      complexity,
      routerReason: "no suitable model available after hard constraints",
      hardConstraintsApplied: dedupe(hardConstraintsApplied),
      routingStrategy: input.strategy,
      fallbackUsed: false,
    },
    unsupported: true,
  };
}

function detectTask(messages: readonly { readonly content: string }[]): DetectedTask {
  const prompt = messages
    .map((message) => message.content)
    .join("\n")
    .toLowerCase();

  if (/\b(debug|bug|stack trace|error)\b/.test(prompt)) return "debugging";
  if (/\b(code|refactor|unit test)\b/.test(prompt)) return "code";
  if (/\b(summarize|summary)\b/.test(prompt)) return "summarization";
  if (/\b(rewrite|grammar)\b/.test(prompt)) return "rewriting";
  if (/\b(architecture|system design)\b/.test(prompt)) return "system_design";
  if (/\b(reasoning|analyze|tradeoff)\b/.test(prompt)) return "reasoning";
  if (/\b(extract|parse)\b/.test(prompt)) return "extraction";
  if (prompt.length < 80) return "simple_chat";
  return "unknown";
}

function getMetric(
  metrics: Map<string, LiveProviderMetric>,
  provider: ProviderId,
  model?: string,
): LiveProviderMetric {
  const modelMetric = model ? metrics.get(`${provider}:${model}`) : undefined;
  if (modelMetric) {
    return modelMetric;
  }

  const metric = metrics.get(provider);

  if (metric) {
    return metric;
  }

  switch (provider) {
    case "anthropic":
      return {
        provider: "anthropic",
        healthy: true,
        latencyMs: 900,
        reliabilityScore: 0.98,
      };
    case "gemini":
      return {
        provider: "gemini",
        healthy: true,
        latencyMs: 500,
        reliabilityScore: 0.96,
      };
    case "groq":
      return {
        provider: "groq",
        healthy: true,
        latencyMs: 250,
        reliabilityScore: 0.94,
      };
    case "openai":
      return fallbackMetric;
    default:
      return fallbackMetric;
  }
}

function healthPenalty(candidate: RoutingCandidateModel): number {
  if (candidate.metrics.status === "down") {
    return 1_000;
  }

  if (candidate.metrics.status === "degraded") {
    return 50;
  }

  return 0;
}

function detectComplexity(
  messages: readonly { readonly content: string }[],
): "low" | "medium" | "high" {
  const prompt = messages.map((message) => message.content).join("\n");

  if (
    prompt.length > 1200 ||
    /\b(distributed|race condition|architecture|system design)\b/i.test(prompt)
  ) {
    return "high";
  }

  if (prompt.length > 250 || /\b(debug|refactor|analyze)\b/i.test(prompt)) {
    return "medium";
  }

  return "low";
}

function preferencesForTask(task: DetectedTask): readonly string[] {
  if (task === "code" || task === "debugging") {
    return [
      "claude-3-5-sonnet",
      "gpt-5-codex",
      "gpt-5.1-codex",
      "gpt-4.1",
      "gpt-4o",
      "gpt-5-mini",
      "gpt-4.1-mini",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "llama-3.1-70b-versatile",
    ];
  }

  if (task === "summarization" || task === "rewriting") {
    return [
      "gemini-1.5-flash",
      "gpt-4.1-nano",
      "gpt-4o-mini",
      "gpt-5-nano",
      "gpt-5-mini",
      "llama-3.1-70b-versatile",
      "gpt-4o",
    ];
  }

  if (task === "reasoning" || task === "system_design") {
    return [
      "gpt-5",
      "gpt-4.1",
      "gpt-4o",
      "o3",
      "claude-3-5-sonnet",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ];
  }

  return [
    "gpt-4.1-nano",
    "gpt-4o-mini",
    "gpt-5-nano",
    "gemini-1.5-flash",
    "llama-3.1-70b-versatile",
    "gpt-4o",
  ];
}

function idealModelForTask(task: DetectedTask): string {
  return preferencesForTask(task)[0] ?? "gemini-1.5-flash";
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function routeChatCompletion(input: ChatRoutingInput): ChatRoute | UnsupportedChatRoute {
  const availableModels = input.availableModels ?? Object.keys(modelRegistry);

  if (input.requestedModel !== "auto") {
    const modelEntry = getModelRegistryEntry(input.requestedModel);

    if (!modelEntry) {
      return {
        requestedModel: input.requestedModel,
        routingReason: "unsupported model",
        routingMetadata: {
          idealModel: input.requestedModel,
          availableModels,
          unavailableReason: "requested model is not registered",
          routingStrategy: "direct",
          fallbackUsed: false,
        },
        unsupported: true,
      };
    }

    if (!availableModels.includes(input.requestedModel)) {
      return {
        requestedModel: input.requestedModel,
        routingReason: "model unavailable for user",
        routingMetadata: {
          idealModel: input.requestedModel,
          availableModels,
          unavailableReason: "requested model is not enabled for this user",
          routingStrategy: "direct",
          fallbackUsed: false,
        },
        unsupported: true,
      };
    }

    return {
      provider: modelEntry.provider,
      selectedModel: input.requestedModel,
      routingReason: "direct model request",
      routingMetadata: {
        idealModel: input.requestedModel,
        selectedModel: input.requestedModel,
        selectedProvider: modelEntry.provider,
        availableModels,
        routingStrategy: "direct",
        fallbackUsed: false,
      },
      unsupported: false,
    };
  }

  const prompt = input.messages
    .map((message) => message.content)
    .join("\n")
    .toLowerCase();

  if (/\b(code|debug|refactor|unit test)\b/.test(prompt)) {
    return selectAvailableModel({
      availableModels,
      idealModel: "claude-3-5-sonnet",
      preferences: [
        "claude-3-5-sonnet",
        "gpt-5-codex",
        "gpt-5.1-codex",
        "gpt-4.1",
        "gpt-4o",
        "gpt-5-mini",
        "gpt-4.1-mini",
        "gemini-1.5-pro",
        "gemini-1.5-flash",
        "llama-3.1-70b-versatile",
      ],
      routingReason: "matched code/debug prompt",
      routingStrategy: "code-preference",
    });
  }

  if (/\b(summarize|rewrite|grammar)\b/.test(prompt)) {
    return selectAvailableModel({
      availableModels,
      idealModel: "gemini-1.5-flash",
      preferences: [
        "gemini-1.5-flash",
        "gpt-4.1-nano",
        "gpt-4o-mini",
        "gpt-5-nano",
        "gpt-5-mini",
        "llama-3.1-70b-versatile",
        "gpt-4o",
      ],
      routingReason: "matched summarization or writing prompt",
      routingStrategy: "summarization-preference",
    });
  }

  if (/\b(architecture|reasoning|system design)\b/.test(prompt)) {
    return selectAvailableModel({
      availableModels,
      idealModel: "gpt-5",
      preferences: [
        "gpt-5",
        "gpt-4.1",
        "gpt-4o",
        "o3",
        "claude-3-5-sonnet",
        "gemini-1.5-pro",
        "gemini-1.5-flash",
      ],
      routingReason: "matched architecture/reasoning prompt",
      routingStrategy: "reasoning-preference",
    });
  }

  if (/\b(fast|cheap|simple)\b/.test(prompt)) {
    return selectAvailableModel({
      availableModels,
      idealModel: "gpt-4.1-nano",
      preferences: [
        "gpt-4.1-nano",
        "gpt-4o-mini",
        "gpt-5-nano",
        "gemini-1.5-flash",
        "llama-3.1-70b-versatile",
      ],
      routingReason: "matched fast/cheap/simple prompt",
      routingStrategy: "fast-low-cost-preference",
    });
  }

  return selectAvailableModel({
    availableModels,
    idealModel: "gemini-1.5-flash",
    preferences: [
      "gemini-1.5-flash",
      "gpt-4.1-nano",
      "gpt-4o-mini",
      "gpt-5-nano",
      "llama-3.1-70b-versatile",
      "gpt-4o",
    ],
    routingReason: "fallback default route",
    routingStrategy: "default-fallback",
  });
}

function selectAvailableModel(options: {
  readonly availableModels: readonly string[];
  readonly idealModel: string;
  readonly preferences: readonly string[];
  readonly routingReason: string;
  readonly routingStrategy: string;
}): ChatRoute | UnsupportedChatRoute {
  const selectedModel = options.preferences.find((model) =>
    options.availableModels.includes(model),
  );

  if (!selectedModel) {
    return {
      requestedModel: options.idealModel,
      routingReason: "no suitable model available",
      routingMetadata: {
        idealModel: options.idealModel,
        availableModels: options.availableModels,
        unavailableReason: "none of the preferred models are enabled for this user",
        routingStrategy: options.routingStrategy,
        fallbackUsed: false,
      },
      unsupported: true,
    };
  }

  const modelEntry = getModelRegistryEntry(selectedModel);

  if (!modelEntry) {
    return {
      requestedModel: selectedModel,
      routingReason: "selected model is not registered",
      routingMetadata: {
        idealModel: options.idealModel,
        availableModels: options.availableModels,
        unavailableReason: "selected model is not registered",
        routingStrategy: options.routingStrategy,
        fallbackUsed: false,
      },
      unsupported: true,
    };
  }

  return {
    provider: modelEntry.provider,
    selectedModel,
    routingReason: options.routingReason,
    routingMetadata: {
      idealModel: options.idealModel,
      selectedModel,
      selectedProvider: modelEntry.provider,
      availableModels: options.availableModels,
      unavailableReason:
        selectedModel === options.idealModel ? undefined : `${options.idealModel} unavailable`,
      routingStrategy: options.routingStrategy,
      fallbackUsed: selectedModel !== options.idealModel,
    },
    unsupported: false,
  };
}
