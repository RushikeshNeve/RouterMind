import { estimateTokens } from "@routemind/cost-engine";
import type { ChatMessage } from "@routemind/core";
import type { ProviderAdapter } from "@routemind/providers";
import type {
  RouterLLMDecision,
  RouterLLMRequest,
  RouterLLMService,
  RoutingCandidateModel,
} from "@routemind/routing";

import type { ApiConfig } from "../config.js";

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
  ) {}

  async decide(request: RouterLLMRequest): Promise<RouterLLMDecision> {
    const routerModel = this.config.ROUTER_LLM_MODEL.startsWith("gpt")
      ? this.config.ROUTER_LLM_MODEL
      : "gpt-4o-mini";
    const routerProvider = this.providers.get("openai");

    if (!routerProvider) {
      return new MockRouterLLMService().decide(request);
    }

    if (!routerProvider.supportedModels.includes(routerModel)) {
      return new MockRouterLLMService().decide(request);
    }

    const prompt = buildRouterPrompt(request);
    const estimate = estimateTokens(prompt.length);
    const response = await routerProvider.chatCompletion({
      model: routerModel,
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
      routerModelUsed: routerModel,
    };
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
