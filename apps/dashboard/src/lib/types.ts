export interface AnalyticsSummary {
  readonly requests: {
    readonly total: number;
    readonly success: number;
    readonly failed: number;
    readonly successRate: number;
  };
  readonly cost: {
    readonly totalSpendUsd: number;
    readonly averageCostPerRequest: number;
  };
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly latency: {
    readonly averageMs: number;
    readonly p95Ms: number;
  };
  readonly routing: {
    readonly fallbackUsed: number;
    readonly llmAssisted: number;
    readonly scoreBased: number;
    readonly ruleBased: number;
  };
  readonly guardrails: {
    readonly budgetBlocked: number;
    readonly quotaBlocked: number;
  };
  readonly resilience?: {
    readonly circuitBreakerTriggered: number;
  };
  readonly cache?: {
    readonly cacheHits: number;
    readonly cacheMisses: number;
    readonly estimatedCostSavedUsd: number;
    readonly cacheHitRate: number;
  };
  readonly topModelsByUsage: readonly ModelAnalytics[];
  readonly topModelsBySpend: readonly ModelAnalytics[];
  readonly topProvidersByUsage: readonly ProviderAnalytics[];
  readonly topProvidersBySpend: readonly ProviderAnalytics[];
}

export interface ModelAnalytics {
  readonly model: string;
  readonly provider?: string;
  readonly requests: number;
  readonly successRate: number;
  readonly totalSpendUsd: number;
  readonly averageLatencyMs: number;
}

export interface ProviderAnalytics {
  readonly provider: string;
  readonly requests: number;
  readonly successRate: number;
  readonly totalSpendUsd: number;
  readonly averageLatencyMs: number;
}

export interface ErrorAnalytics {
  readonly errorMessage: string;
  readonly provider?: string;
  readonly model?: string;
  readonly errorType?: string;
  readonly count: number;
}

export interface CostPoint {
  readonly date: string;
  readonly spendUsd: number;
  readonly requests: number;
}

export interface LatencyPoint {
  readonly date: string;
  readonly provider?: string;
  readonly averageLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly requests: number;
}

export interface ProviderHealthResponse {
  readonly providers: readonly {
    readonly provider: string;
    readonly models: readonly ProviderHealthModel[];
  }[];
}

export interface ProviderHealthModel {
  readonly model: string;
  readonly status: "healthy" | "degraded" | "down";
  readonly avgLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly successRate: number;
  readonly errorRate: number;
  readonly timeoutRate: number;
  readonly rateLimitRate: number;
  readonly sampleSize: number;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
  readonly lastCheckedAt?: string;
  readonly updatedAt?: string;
}

export interface CircuitBreakerResponse {
  readonly circuitBreakers: readonly CircuitBreaker[];
}

export interface CircuitBreaker {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly state: "CLOSED" | "OPEN" | "HALF_OPEN";
  readonly failureCount: number;
  readonly openedAt?: string;
  readonly halfOpenAt?: string;
  readonly lastFailureAt?: string;
  readonly lastSuccessAt?: string;
  readonly updatedAt: string;
}

export interface ProviderAttemptsResponse {
  readonly attempts: readonly ProviderAttempt[];
}

export interface ProviderAttempt {
  readonly id: string;
  readonly requestLogId?: string;
  readonly userId: string;
  readonly provider: string;
  readonly model: string;
  readonly attemptNumber: number;
  readonly status: "success" | "failed";
  readonly latencyMs: number;
  readonly errorType?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
}

export interface RecentRequestsResponse {
  readonly requests: readonly RecentRequest[];
}

export interface RecentRequest {
  readonly id: string;
  readonly timestamp: string;
  readonly requestedModel: string;
  readonly selectedModel?: string;
  readonly provider?: string;
  readonly status: "success" | "failed";
  readonly latencyMs: number;
  readonly costUsd?: number;
  readonly routingMode?: string;
  readonly routingStrategy?: string;
  readonly errorMessage?: string;
}

export interface EvaluationDataset {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly taskType: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvaluationRun {
  readonly id: string;
  readonly datasetId: string;
  readonly model: string;
  readonly provider: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly totalCases: number;
  readonly passedCases: number;
  readonly averageScore: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
}

export interface EvaluationScore {
  readonly taskType: string;
  readonly provider: string;
  readonly model: string;
  readonly averageScore: number;
  readonly runs: number;
  readonly totalCases: number;
}

export interface DashboardData {
  readonly summary: AnalyticsSummary;
  readonly models: readonly ModelAnalytics[];
  readonly providers: readonly ProviderAnalytics[];
  readonly errors: readonly ErrorAnalytics[];
  readonly costs: readonly CostPoint[];
  readonly latency: readonly LatencyPoint[];
  readonly health: ProviderHealthResponse;
  readonly circuitBreakers: readonly CircuitBreaker[];
  readonly attempts: readonly ProviderAttempt[];
  readonly requests: readonly RecentRequest[];
  readonly evaluationDatasets: readonly EvaluationDataset[];
  readonly evaluationRuns: readonly EvaluationRun[];
  readonly evaluationScores: readonly EvaluationScore[];
  readonly isDemo: boolean;
  readonly error?: string;
}
