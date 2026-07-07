import type { AiGatewayRequest, TokenUsage } from "@routemind/core";

import { modelPricing } from "./pricing.js";

export interface ModelPricing {
  readonly providerId: string;
  readonly modelId: string;
  readonly inputTokenUsd: number;
  readonly outputTokenUsd: number;
}

export interface CostEstimate {
  readonly providerId: string;
  readonly modelId: string;
  readonly estimatedUsd: number;
}

export interface CostEstimator {
  estimate(request: AiGatewayRequest, pricing: ModelPricing): Promise<CostEstimate>;
  calculateActual(usage: TokenUsage, pricing: ModelPricing): Promise<CostEstimate>;
}

export interface TokenEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function estimateTokens(promptCharacters: number): TokenEstimate {
  return {
    inputTokens: Math.ceil(promptCharacters / 4),
    outputTokens: 300,
  };
}

export function estimateCost(modelId: string, estimate: TokenEstimate): number {
  const pricing = modelPricing[modelId];

  if (!pricing) {
    return 0;
  }

  const cost =
    estimate.inputTokens * pricing.inputTokenUsd + estimate.outputTokens * pricing.outputTokenUsd;

  return Number(cost.toFixed(8));
}

export { modelPricing } from "./pricing.js";
