import type { PrismaClient } from "@prisma/client";
import { estimateTokens } from "@routemind/cost-engine";
import type { ChatMessage } from "@routemind/core";
import type { ProviderAdapter } from "@routemind/providers";
import {
  resolveRouterConfig,
  type ResolveRouterConfigContext,
  type RouterConfigLookup,
  type RouterLLMDecision,
  type RouterLLMRequest,
  type RouterLLMService,
  type RoutingCandidateModel,
} from "@routemind/routing";

import type { ApiConfig } from "../config.js";
import { decryptCredential } from "../security/credentials.js";

export type RouterCredentialProviderFactory = (apiKeys: {
  readonly openai?: string | undefined;
  readonly anthropic?: string | undefined;
  readonly gemini?: string | undefined;
  readonly groq?: string | undefined;
}) => Map<string, ProviderAdapter>;

export class MockRouterLLMService implements RouterLLMService {
  decide(request: RouterLLMRequest): Promise<RouterLLMDecision> {
    const selected = selectMockCandidate(request.candidates, request.userPrompt);

    return Promise.resolve({
      detectedTask: detectMockTask(request.userPrompt),
      complexity: detectMockComplexity(request.userPrompt),
      selectedProvider: selected.provider,
      selectedModel: selected.model,
      fallbackModels: request.candidates
        .filter((candidate) => candidate.model !== selected.model)
        .slice(0, 3)
        .map((candidate) => ({
          provider: candidate.provider,
          model: candidate.model,
          reason: "Available fallback candidate.",
        })),
      reason: `Mock Router LLM selected ${selected.model} for ${request.strategy} routing.`,
      confidence: 0.82,
      routerModelUsed: "mock-router-llm",
    });
  }
}

export class LiveRouterLLMService implements RouterLLMService {
  constructor(
    private readonly config: ApiConfig,
    private readonly providers: Map<string, ProviderAdapter>,
    private readonly routerConfigLookup: RouterConfigLookup,
    private readonly context: ResolveRouterConfigContext,
    private readonly prisma: PrismaClient,
    private readonly providerFactory: RouterCredentialProviderFactory,
  ) {}

  async decide(request: RouterLLMRequest): Promise<RouterLLMDecision> {
    const platformDefaultModel = this.config.ROUTER_LLM_MODEL.startsWith("gpt")
      ? this.config.ROUTER_LLM_MODEL
      : "gpt-4o-mini";
    const resolved = await resolveRouterConfig(this.context, this.routerConfigLookup, {
      provider: "openai",
      model: platformDefaultModel,
    });

    const routerProvider = await this.resolveProvider(resolved.provider, resolved.credentialId);

    if (!routerProvider) {
      return {
        ...(await new MockRouterLLMService().decide(request)),
        configSource: resolved.source,
      };
    }

    if (!routerProvider.supportedModels.includes(resolved.model)) {
      return {
        ...(await new MockRouterLLMService().decide(request)),
        configSource: resolved.source,
      };
    }

    const prompt = buildRouterPrompt(request);
    const estimate = estimateTokens(prompt.length);
    const response = await routerProvider.chatCompletion({
      model: resolved.model,
      messages: [
        {
          role: "system",
          content:
            "You are RouteMind's router. Return only valid JSON matching the requested schema.",
        },
        {
          role: "user",
          content: prompt,
        },
      ] satisfies readonly ChatMessage[],
      stream: false,
      estimatedUsage: {
        inputTokens: estimate.inputTokens,
        outputTokens: this.config.ROUTER_LLM_MAX_TOKENS,
      },
    });
    const content = response.choices[0]?.message.content;

    if (!content) {
      throw new Error("Router LLM returned no content.");
    }

    return {
      ...parseRouterDecision(content),
      routerModelUsed: resolved.model,
      configSource: resolved.source,
    };
  }

  // A resolved credentialId names a *specific* ProviderCredential row, which
  // may not be the one already baked into `this.providers` (that map only
  // reflects the calling workspace's own default credential per provider).
  // Fetch and decrypt that exact row and build a one-off adapter for it,
  // rather than assuming the ambient providers map already has the right key.
  private async resolveProvider(
    provider: string,
    credentialId: string | undefined,
  ): Promise<ProviderAdapter | undefined> {
    if (!credentialId) {
      return this.providers.get(provider);
    }

    const credential = await this.prisma.providerCredential.findUnique({
      where: { id: credentialId },
    });

    if (!credential || !credential.isEnabled) {
      return this.providers.get(provider);
    }

    const decryptedKey = decryptCredential(
      credential.encryptedApiKey,
      this.config.CREDENTIAL_ENCRYPTION_KEY,
    );

    return this.providerFactory({
      openai: credential.provider === "openai" ? decryptedKey : undefined,
      anthropic: credential.provider === "anthropic" ? decryptedKey : undefined,
      gemini: credential.provider === "gemini" ? decryptedKey : undefined,
      groq: credential.provider === "groq" ? decryptedKey : undefined,
    }).get(provider);
  }
}

function buildRouterPrompt(request: RouterLLMRequest): string {
  return JSON.stringify({
    instruction:
      "Analyze the request and select exactly one candidate model. Use cost-effective routing by default: prefer low/medium cost models that satisfy the task, avoid high/pro models unless strategy is quality_first or complexity is high. Return JSON only with detectedTask, complexity, selectedProvider, selectedModel, fallbackModels, reason, confidence.",
    userPrompt: request.userPrompt,
    messageCount: request.messageCount,
    approximateInputTokens: request.approximateInputTokens,
    candidateModels: request.candidates.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      capabilities: candidate.capabilities,
      pricing: candidate.pricing,
      health: {
        status: candidate.metrics.status ?? (candidate.metrics.healthy ? "healthy" : "down"),
        avgLatencyMs: candidate.metrics.avgLatencyMs ?? candidate.metrics.latencyMs,
        p95LatencyMs: candidate.metrics.p95LatencyMs ?? candidate.metrics.latencyMs,
        successRate: candidate.metrics.successRate ?? candidate.metrics.reliabilityScore,
        errorRate: candidate.metrics.errorRate ?? 1 - candidate.metrics.reliabilityScore,
        timeoutRate: candidate.metrics.timeoutRate ?? 0,
        rateLimitRate: candidate.metrics.rateLimitRate ?? 0,
        sampleSize: candidate.metrics.sampleSize ?? 0,
      },
      evaluationScore: candidate.evaluationScore,
    })),
    policyConstraints: request.policy,
    routingStrategy: request.strategy,
    recentEvaluationScores: request.evaluationScores,
  });
}

function parseRouterDecision(rawContent: string): RouterLLMDecision {
  const cleaned = rawContent
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned) as RouterLLMDecision;

  if (
    !parsed.selectedModel ||
    !parsed.selectedProvider ||
    typeof parsed.confidence !== "number" ||
    !parsed.reason
  ) {
    throw new Error("Router LLM returned invalid decision JSON.");
  }

  return parsed;
}

function selectMockCandidate(
  candidates: readonly RoutingCandidateModel[],
  prompt: string,
): RoutingCandidateModel {
  const lower = prompt.toLowerCase();
  const preferences = /\b(debug|code|refactor|unit test)\b/.test(lower)
    ? ["claude-3-5-sonnet", "gpt-4o", "gemini-1.5-pro", "gemini-1.5-flash"]
    : /\b(system design|architecture|reasoning)\b/.test(lower)
      ? ["gpt-4o", "claude-3-5-sonnet", "gemini-1.5-pro"]
      : ["gpt-4o-mini", "gemini-1.5-flash", "llama-3.1-70b-versatile", "gpt-4o"];

  return (
    preferences
      .map((model) => candidates.find((candidate) => candidate.model === model))
      .find(Boolean) ?? candidates[0]!
  );
}

function detectMockTask(prompt: string): RouterLLMDecision["detectedTask"] {
  const lower = prompt.toLowerCase();
  if (/\b(debug|bug|error)\b/.test(lower)) return "debugging";
  if (/\b(code|refactor|unit test)\b/.test(lower)) return "code";
  if (/\b(summarize|summary)\b/.test(lower)) return "summarization";
  if (/\b(system design|architecture)\b/.test(lower)) return "system_design";
  if (/\b(reasoning|analyze)\b/.test(lower)) return "reasoning";
  return "simple_chat";
}

function detectMockComplexity(prompt: string): RouterLLMDecision["complexity"] {
  if (
    prompt.length > 800 ||
    /\b(distributed|architecture|system design|race condition)\b/i.test(prompt)
  ) {
    return "high";
  }

  if (prompt.length > 180 || /\b(debug|refactor|analyze)\b/i.test(prompt)) {
    return "medium";
  }

  return "low";
}
