import type { GatewayRequestContext, TokenUsage } from "@routemind/core";

export interface UsageEvent {
  readonly context: GatewayRequestContext;
  readonly providerId: string;
  readonly modelId: string;
  readonly usage?: TokenUsage;
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly recordedAt: Date;
}

export interface AnalyticsSink {
  recordUsage(event: UsageEvent): Promise<void>;
}
