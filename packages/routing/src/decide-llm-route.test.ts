import { describe, expect, it, vi } from "vitest";

import {
  LLM_ROUTING_CALL_FAILED_REASON,
  LLM_ROUTING_DISABLED_REASON,
  LLM_ROUTING_NO_CANDIDATE_MATCH_REASON,
  LLM_ROUTING_STRATEGY_SKIP_REASON,
  decideLLMRoute,
  type LLMEngineInput,
  type RouterLLMDecision,
  type RouterLLMService,
} from "./index.js";

function fakeRouterService(
  decide: (request: unknown) => Promise<RouterLLMDecision>,
): RouterLLMService {
  return { decide };
}

const validDecision: RouterLLMDecision = {
  detectedTask: "simple_chat",
  complexity: "low",
  selectedProvider: "openai",
  selectedModel: "gpt-4o",
  fallbackModels: [],
  reason: "Router chose the only enabled candidate.",
  confidence: 0.9,
};

function baseInput(overrides: Partial<LLMEngineInput> = {}): LLMEngineInput {
  return {
    requestedModel: "auto",
    messages: [{ content: "Hello there" }],
    availableModels: ["gpt-4o"],
    enabledProviders: ["openai"],
    mode: "llm_assisted",
    strategy: "balanced",
    policy: {},
    approximateInputTokens: 5,
    routerLLMEnabled: true,
    routerLLMService: fakeRouterService(() => Promise.resolve(validDecision)),
    ...overrides,
  };
}

describe("decideLLMRoute's llm_assisted fallback reasons", () => {
  it("uses the router's own reason when it selects a real candidate (control case)", async () => {
    const decision = await decideLLMRoute(baseInput());

    expect(decision.unsupported).toBe(false);
    expect(decision.routingReason).toBe(validDecision.reason);
    expect(decision.routingMetadata.routerReason).toBe(validDecision.reason);
  });

  it("reports LLM_ROUTING_DISABLED_REASON when routerLLMEnabled is false, without calling the router", async () => {
    const decide = vi.fn(() => Promise.resolve(validDecision));

    const decision = await decideLLMRoute(
      baseInput({ routerLLMEnabled: false, routerLLMService: fakeRouterService(decide) }),
    );

    expect(decide).not.toHaveBeenCalled();
    expect(decision.routingReason).toBe(LLM_ROUTING_DISABLED_REASON);
    expect(decision.routingMetadata.routerReason).toBe(LLM_ROUTING_DISABLED_REASON);
    expect(decision.routingMetadata.mode).toBe("score_based");
  });

  it("reports LLM_ROUTING_STRATEGY_SKIP_REASON for a cost_first, simple, low-complexity request, without calling the router", async () => {
    const decide = vi.fn(() => Promise.resolve(validDecision));

    const decision = await decideLLMRoute(
      baseInput({
        strategy: "cost_first",
        messages: [{ content: "Hi" }],
        routerLLMService: fakeRouterService(decide),
      }),
    );

    expect(decide).not.toHaveBeenCalled();
    expect(decision.routingReason).toBe(LLM_ROUTING_STRATEGY_SKIP_REASON);
    expect(decision.routingMetadata.routerReason).toBe(LLM_ROUTING_STRATEGY_SKIP_REASON);
  });

  it("reports LLM_ROUTING_CALL_FAILED_REASON when the router call throws", async () => {
    const decision = await decideLLMRoute(
      baseInput({
        routerLLMService: fakeRouterService(() => Promise.reject(new Error("provider down"))),
      }),
    );

    expect(decision.routingReason).toBe(LLM_ROUTING_CALL_FAILED_REASON);
    expect(decision.routingMetadata.routerReason).toBe(LLM_ROUTING_CALL_FAILED_REASON);
  });

  it("reports LLM_ROUTING_NO_CANDIDATE_MATCH_REASON when the router picks a provider/model that isn't an available candidate", async () => {
    const decision = await decideLLMRoute(
      baseInput({
        routerLLMService: fakeRouterService(() =>
          Promise.resolve({
            ...validDecision,
            selectedProvider: "anthropic",
            selectedModel: "claude-3-5-sonnet",
          }),
        ),
      }),
    );

    expect(decision.routingReason).toBe(LLM_ROUTING_NO_CANDIDATE_MATCH_REASON);
    expect(decision.routingMetadata.routerReason).toBe(LLM_ROUTING_NO_CANDIDATE_MATCH_REASON);
  });

  it("produces four mutually distinguishable reasons, not the same collapsed string", async () => {
    const [disabled, strategySkip, callFailed, noMatch] = await Promise.all([
      decideLLMRoute(baseInput({ routerLLMEnabled: false })),
      decideLLMRoute(baseInput({ strategy: "cost_first", messages: [{ content: "Hi" }] })),
      decideLLMRoute(
        baseInput({
          routerLLMService: fakeRouterService(() => Promise.reject(new Error("boom"))),
        }),
      ),
      decideLLMRoute(
        baseInput({
          routerLLMService: fakeRouterService(() =>
            Promise.resolve({
              ...validDecision,
              selectedProvider: "anthropic",
              selectedModel: "claude-3-5-sonnet",
            }),
          ),
        }),
      ),
    ]);

    const reasons = [
      disabled.routingReason,
      strategySkip.routingReason,
      callFailed.routingReason,
      noMatch.routingReason,
    ];

    expect(new Set(reasons).size).toBe(reasons.length);
  });
});
