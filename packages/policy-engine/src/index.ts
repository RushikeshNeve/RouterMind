import type { AiGatewayRequest, GatewayRequestContext } from "@routemind/core";

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly constraints?: Record<string, unknown>;
}

export interface PolicyEvaluator {
  evaluate(request: AiGatewayRequest, context: GatewayRequestContext): Promise<PolicyDecision>;
}
