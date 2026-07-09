import type { PrismaClient } from "@prisma/client";
import type {
  InMemoryExecutionPlanLogStore,
  ExecutionPlanLogEntry,
} from "./execution-plan-log-store.js";
import type {
  InMemoryProviderAttemptLogStore,
  RequiredProviderAttemptLogEntry,
} from "./provider-attempt-log-store.js";
import type { InMemoryRequestLogStore, RequestLogEntry } from "./request-log-store.js";
import type {
  InMemoryRouterDecisionLogStore,
  RouterDecisionLogEntry,
} from "./router-decision-log-store.js";
import type { CacheStats } from "./cache-service.js";
import type { FirewallStats } from "./prompt-firewall-service.js";

export interface AnalyticsFilters {
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

export interface AnalyticsSummary {
  readonly range: {
    readonly from?: string;
    readonly to?: string;
  };
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
  readonly resilience: {
    readonly circuitBreakerTriggered: number;
  };
  readonly cache: {
    readonly cacheHits: number;
    readonly cacheMisses: number;
    readonly estimatedCostSavedUsd: number;
    readonly cacheHitRate: number;
  };
  readonly firewall: {
    readonly totalEvents: number;
    readonly blockedRequests: number;
    readonly redactedRequests: number;
    readonly warnings: number;
    readonly topRuleTypes: readonly {
      readonly type: string;
      readonly count: number;
    }[];
  };
  readonly topModelsByUsage: readonly ModelAnalyticsRow[];
  readonly topModelsBySpend: readonly ModelAnalyticsRow[];
  readonly topProvidersByUsage: readonly ProviderAnalyticsRow[];
  readonly topProvidersBySpend: readonly ProviderAnalyticsRow[];
}

export interface ModelAnalyticsRow {
  readonly model: string;
  readonly provider?: string;
  readonly requests: number;
  readonly successRate: number;
  readonly totalSpendUsd: number;
  readonly averageLatencyMs: number;
}

export interface ProviderAnalyticsRow {
  readonly provider: string;
  readonly requests: number;
  readonly successRate: number;
  readonly totalSpendUsd: number;
  readonly averageLatencyMs: number;
}

export interface ErrorAnalyticsRow {
  readonly errorMessage: string;
  readonly provider?: string;
  readonly model?: string;
  readonly errorType?: string;
  readonly count: number;
}

export interface CostAnalyticsRow {
  readonly date: string;
  readonly spendUsd: number;
  readonly requests: number;
}

export interface LatencyAnalyticsRow {
  readonly date: string;
  readonly provider?: string;
  readonly averageLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly requests: number;
}

export interface RecentRequestAnalyticsRow {
  readonly id: string;
  readonly timestamp: string;
  readonly requestedModel: string;
  readonly workspaceId: string | null;
  readonly selectedModel?: string;
  readonly provider?: string;
  readonly status: "success" | "failed";
  readonly latencyMs: number;
  readonly costUsd?: number;
  readonly routingMode?: string;
  readonly routingStrategy?: string;
  readonly errorMessage?: string;
}

export interface AnalyticsService {
  summary(filters: AnalyticsFilters): Promise<AnalyticsSummary>;
  models(filters: AnalyticsFilters): Promise<readonly ModelAnalyticsRow[]>;
  providers(filters: AnalyticsFilters): Promise<readonly ProviderAnalyticsRow[]>;
  errors(filters: AnalyticsFilters): Promise<readonly ErrorAnalyticsRow[]>;
  costs(filters: AnalyticsFilters): Promise<readonly CostAnalyticsRow[]>;
  latency(filters: AnalyticsFilters): Promise<readonly LatencyAnalyticsRow[]>;
  requests(filters: AnalyticsFilters, limit: number): Promise<readonly RecentRequestAnalyticsRow[]>;
}

export class InMemoryAnalyticsService implements AnalyticsService {
  constructor(
    private readonly requestLogStore: InMemoryRequestLogStore,
    private readonly routerDecisionLogStore: InMemoryRouterDecisionLogStore,
    private readonly providerAttemptLogStore: InMemoryProviderAttemptLogStore,
    private readonly executionPlanLogStore: InMemoryExecutionPlanLogStore,
    private readonly cacheStatsProvider?: {
      stats(userId?: string): Promise<CacheStats>;
    },
    private readonly firewallStatsProvider?: {
      stats(userId?: string): Promise<FirewallStats>;
    },
  ) {}

  async summary(filters: AnalyticsFilters): Promise<AnalyticsSummary> {
    const data = this.snapshot(filters);
    const modelRows = groupModels(data.requests);
    const providerRows = groupProviders(data.requests);

    return buildSummary(
      filters,
      data,
      modelRows,
      providerRows,
      await this.cacheStatsProvider?.stats(filters.userId),
      await this.firewallStatsProvider?.stats(filters.userId),
    );
  }

  models(filters: AnalyticsFilters): Promise<readonly ModelAnalyticsRow[]> {
    return Promise.resolve(groupModels(this.snapshot(filters).requests));
  }

  providers(filters: AnalyticsFilters): Promise<readonly ProviderAnalyticsRow[]> {
    return Promise.resolve(groupProviders(this.snapshot(filters).requests));
  }

  errors(filters: AnalyticsFilters): Promise<readonly ErrorAnalyticsRow[]> {
    const data = this.snapshot(filters);
    return Promise.resolve(groupErrors(data.requests, data.attempts));
  }

  costs(filters: AnalyticsFilters): Promise<readonly CostAnalyticsRow[]> {
    return Promise.resolve(groupCosts(this.snapshot(filters).requests));
  }

  latency(filters: AnalyticsFilters): Promise<readonly LatencyAnalyticsRow[]> {
    return Promise.resolve(groupLatency(this.snapshot(filters).requests));
  }

  requests(
    filters: AnalyticsFilters,
    limit: number,
  ): Promise<readonly RecentRequestAnalyticsRow[]> {
    return Promise.resolve(recentRequests(this.snapshot(filters).requests, limit));
  }

  private snapshot(filters: AnalyticsFilters): AnalyticsSnapshot {
    const routerUserRequestIds = new Set(
      this.routerDecisionLogStore.entries
        .filter((entry) => filters.userId === undefined || entry.userId === filters.userId)
        .map((entry) => entry.requestLogId)
        .filter((id): id is string => typeof id === "string"),
    );
    const attemptUserRequestIds = new Set(
      this.providerAttemptLogStore.entries
        .filter((entry) => filters.userId === undefined || entry.userId === filters.userId)
        .map((entry) => entry.requestLogId)
        .filter((id): id is string => typeof id === "string"),
    );
    const planUserRequestIds = new Set(
      this.executionPlanLogStore.entries
        .filter((entry) => filters.userId === undefined || entry.userId === filters.userId)
        .map((entry) => entry.requestLogId)
        .filter((id): id is string => typeof id === "string"),
    );
    const userRequestIds = unionSets(
      routerUserRequestIds,
      attemptUserRequestIds,
      planUserRequestIds,
    );
    const requests = this.requestLogStore.entries
      .filter((entry) => dateInRange(entry.createdAt, filters))
      .filter(
        (entry) => filters.workspaceId === undefined || entry.workspaceId === filters.workspaceId,
      )
      .filter((entry) => filters.userId === undefined || userRequestIds.has(entry.id))
      .map(toRequestRow);
    const requestIds = new Set(requests.map((entry) => entry.id));

    return {
      requests,
      routerDecisions: this.routerDecisionLogStore.entries
        .filter((entry) => dateInRange(entry.createdAt, filters))
        .filter((entry) => filters.userId === undefined || entry.userId === filters.userId)
        .filter((entry) => !entry.requestLogId || requestIds.has(entry.requestLogId))
        .map(toRouterRow),
      attempts: this.providerAttemptLogStore.entries
        .filter((entry) => dateInRange(entry.createdAt, filters))
        .filter((entry) => filters.userId === undefined || entry.userId === filters.userId)
        .filter((entry) => !entry.requestLogId || requestIds.has(entry.requestLogId))
        .map(toAttemptRow),
      executionPlans: this.executionPlanLogStore.entries
        .filter((entry) => dateInRange(entry.createdAt ?? new Date(), filters))
        .filter((entry) => filters.userId === undefined || entry.userId === filters.userId)
        .filter((entry) => !entry.requestLogId || requestIds.has(entry.requestLogId))
        .map(toExecutionPlanRow),
    };
  }
}

export class PrismaAnalyticsService implements AnalyticsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cacheStatsProvider?: {
      stats(userId?: string): Promise<CacheStats>;
    },
    private readonly firewallStatsProvider?: {
      stats(userId?: string): Promise<FirewallStats>;
    },
  ) {}

  async summary(filters: AnalyticsFilters): Promise<AnalyticsSummary> {
    const data = await this.snapshot(filters);
    const modelRows = groupModels(data.requests);
    const providerRows = groupProviders(data.requests);

    return buildSummary(
      filters,
      data,
      modelRows,
      providerRows,
      await this.cacheStatsProvider?.stats(filters.userId),
      await this.firewallStatsProvider?.stats(filters.userId),
    );
  }

  async models(filters: AnalyticsFilters): Promise<readonly ModelAnalyticsRow[]> {
    return groupModels((await this.snapshot(filters)).requests);
  }

  async providers(filters: AnalyticsFilters): Promise<readonly ProviderAnalyticsRow[]> {
    return groupProviders((await this.snapshot(filters)).requests);
  }

  async errors(filters: AnalyticsFilters): Promise<readonly ErrorAnalyticsRow[]> {
    const data = await this.snapshot(filters);
    return groupErrors(data.requests, data.attempts);
  }

  async costs(filters: AnalyticsFilters): Promise<readonly CostAnalyticsRow[]> {
    return groupCosts((await this.snapshot(filters)).requests);
  }

  async latency(filters: AnalyticsFilters): Promise<readonly LatencyAnalyticsRow[]> {
    return groupLatency((await this.snapshot(filters)).requests);
  }

  async requests(
    filters: AnalyticsFilters,
    limit: number,
  ): Promise<readonly RecentRequestAnalyticsRow[]> {
    return recentRequests((await this.snapshot(filters)).requests, limit);
  }

  private async snapshot(filters: AnalyticsFilters): Promise<AnalyticsSnapshot> {
    const requests = await this.prisma.$queryRaw<RequestRow[]>`
      SELECT r.*
      FROM "RequestLog" r
      WHERE (${filters.from ?? null}::timestamp IS NULL OR r."createdAt" >= ${filters.from ?? null})
        AND (${filters.to ?? null}::timestamp IS NULL OR r."createdAt" <= ${filters.to ?? null})
        AND (${filters.workspaceId ?? null}::text IS NULL OR r."workspaceId" = ${filters.workspaceId ?? null})
        AND (
          ${filters.userId ?? null}::text IS NULL
          OR EXISTS (
            SELECT 1 FROM "RouterDecisionLog" d
            WHERE d."requestLogId" = r."id" AND d."userId" = ${filters.userId ?? null}
          )
          OR EXISTS (
            SELECT 1 FROM "ProviderAttemptLog" a
            WHERE a."requestLogId" = r."id" AND a."userId" = ${filters.userId ?? null}
          )
          OR EXISTS (
            SELECT 1 FROM "ExecutionPlanLog" e
            WHERE e."requestLogId" = r."id" AND e."userId" = ${filters.userId ?? null}
          )
        )
      ORDER BY r."createdAt" ASC
    `;
    const requestIds = requests.map((request) => request.id);

    if (requestIds.length === 0) {
      return { requests: [], routerDecisions: [], attempts: [], executionPlans: [] };
    }

    const routerDecisions = await this.prisma.$queryRaw<RouterRow[]>`
      SELECT * FROM "RouterDecisionLog"
      WHERE "requestLogId" = ANY(${requestIds})
        AND (${filters.userId ?? null}::text IS NULL OR "userId" = ${filters.userId ?? null})
      ORDER BY "createdAt" ASC
    `;
    const attempts = await this.prisma.$queryRaw<AttemptRow[]>`
      SELECT * FROM "ProviderAttemptLog"
      WHERE "requestLogId" = ANY(${requestIds})
        AND (${filters.userId ?? null}::text IS NULL OR "userId" = ${filters.userId ?? null})
      ORDER BY "createdAt" ASC
    `;
    const executionPlans = await this.prisma.$queryRaw<ExecutionPlanRow[]>`
      SELECT * FROM "ExecutionPlanLog"
      WHERE "requestLogId" = ANY(${requestIds})
        AND (${filters.userId ?? null}::text IS NULL OR "userId" = ${filters.userId ?? null})
      ORDER BY "createdAt" ASC
    `;

    return {
      requests: requests.map(normalizeRequestRow),
      routerDecisions: routerDecisions.map(normalizeRouterRow),
      attempts: attempts.map(normalizeAttemptRow),
      executionPlans: executionPlans.map(normalizeExecutionPlanRow),
    };
  }
}

interface AnalyticsSnapshot {
  readonly requests: readonly RequestRow[];
  readonly routerDecisions: readonly RouterRow[];
  readonly attempts: readonly AttemptRow[];
  readonly executionPlans: readonly ExecutionPlanRow[];
}

interface RequestRow {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly requestedModel: string;
  readonly selectedModel: string | null;
  readonly provider: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCost: number | null;
  readonly latencyMs: number;
  readonly status: "success" | "failed";
  readonly errorMessage: string | null;
  readonly routingMode: string | null;
  readonly routingStrategy: string | null;
  readonly createdAt: Date;
}

interface RouterRow {
  readonly requestLogId: string | null;
  readonly userId: string;
  readonly mode: string;
  readonly fallbackUsed: boolean;
  readonly createdAt: Date;
}

interface AttemptRow {
  readonly requestLogId: string | null;
  readonly userId: string;
  readonly provider: string;
  readonly model: string;
  readonly status: "success" | "failed";
  readonly latencyMs: number;
  readonly errorType: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
}

interface ExecutionPlanRow {
  readonly requestLogId: string | null;
  readonly userId: string;
  readonly planType: string;
  readonly estimatedCostUsd: number;
  readonly actualCostUsd: number | null;
  readonly executed: boolean;
  readonly createdAt: Date;
}

function buildSummary(
  filters: AnalyticsFilters,
  data: AnalyticsSnapshot,
  modelRows: readonly ModelAnalyticsRow[],
  providerRows: readonly ProviderAnalyticsRow[],
  cacheStats?: CacheStats,
  firewallStats?: FirewallStats,
): AnalyticsSummary {
  const total = data.requests.length;
  const success = data.requests.filter((request) => request.status === "success").length;
  const failed = total - success;
  const totalSpendUsd = roundMoney(sum(data.requests, (request) => request.estimatedCost ?? 0));
  const input = sum(data.requests, (request) => request.inputTokens ?? 0);
  const output = sum(data.requests, (request) => request.outputTokens ?? 0);
  const latencies = data.requests.map((request) => request.latencyMs);
  const cacheHits = cacheStats?.totalHits ?? 0;
  const cacheMisses = Math.max(0, total - cacheHits);

  return {
    range: {
      from: filters.from?.toISOString(),
      to: filters.to?.toISOString(),
    },
    requests: {
      total,
      success,
      failed,
      successRate: rate(success, total),
    },
    cost: {
      totalSpendUsd,
      averageCostPerRequest: total === 0 ? 0 : roundMoney(totalSpendUsd / total),
    },
    tokens: {
      input,
      output,
      total: input + output,
    },
    latency: {
      averageMs: average(latencies),
      p95Ms: percentile(latencies, 0.95),
    },
    routing: {
      fallbackUsed: data.routerDecisions.filter((decision) => decision.fallbackUsed).length,
      llmAssisted: countRoutingMode(data.requests, data.routerDecisions, "llm_assisted"),
      scoreBased: countRoutingMode(data.requests, data.routerDecisions, "score_based"),
      ruleBased: countRoutingMode(data.requests, data.routerDecisions, "rule_based"),
    },
    guardrails: {
      budgetBlocked: data.requests.filter((request) =>
        /budget|BUDGET_EXCEEDED/i.test(request.errorMessage ?? ""),
      ).length,
      quotaBlocked: data.requests.filter((request) =>
        /quota|QUOTA_EXCEEDED/i.test(request.errorMessage ?? ""),
      ).length,
    },
    resilience: {
      circuitBreakerTriggered: data.requests.filter((request) =>
        /circuit/i.test(request.errorMessage ?? ""),
      ).length,
    },
    cache: {
      cacheHits,
      cacheMisses,
      estimatedCostSavedUsd: cacheStats?.estimatedCostSavedUsd ?? 0,
      cacheHitRate: rate(cacheHits, cacheHits + cacheMisses),
    },
    firewall: {
      totalEvents: firewallStats?.totalEvents ?? 0,
      blockedRequests: firewallStats?.blockedRequests ?? 0,
      redactedRequests: firewallStats?.redactedRequests ?? 0,
      warnings: firewallStats?.warnings ?? 0,
      topRuleTypes: firewallStats?.topRuleTypes ?? [],
    },
    topModelsByUsage: modelRows.slice(0, 5),
    topModelsBySpend: [...modelRows]
      .sort((a, b) => b.totalSpendUsd - a.totalSpendUsd || b.requests - a.requests)
      .slice(0, 5),
    topProvidersByUsage: providerRows.slice(0, 5),
    topProvidersBySpend: [...providerRows]
      .sort((a, b) => b.totalSpendUsd - a.totalSpendUsd || b.requests - a.requests)
      .slice(0, 5),
  };
}

function groupModels(requests: readonly RequestRow[]): readonly ModelAnalyticsRow[] {
  return groupBy(
    requests.filter((request) => request.selectedModel),
    (request) => `${request.provider ?? "unknown"}:${request.selectedModel ?? "unknown"}`,
  )
    .map((items) => ({
      model: items[0]?.selectedModel ?? "unknown",
      provider: items[0]?.provider ?? undefined,
      requests: items.length,
      successRate: rate(items.filter((item) => item.status === "success").length, items.length),
      totalSpendUsd: roundMoney(sum(items, (item) => item.estimatedCost ?? 0)),
      averageLatencyMs: average(items.map((item) => item.latencyMs)),
    }))
    .sort((a, b) => b.requests - a.requests || b.totalSpendUsd - a.totalSpendUsd);
}

function groupProviders(requests: readonly RequestRow[]): readonly ProviderAnalyticsRow[] {
  return groupBy(
    requests.filter((request) => request.provider),
    (request) => request.provider ?? "unknown",
  )
    .map((items) => ({
      provider: items[0]?.provider ?? "unknown",
      requests: items.length,
      successRate: rate(items.filter((item) => item.status === "success").length, items.length),
      totalSpendUsd: roundMoney(sum(items, (item) => item.estimatedCost ?? 0)),
      averageLatencyMs: average(items.map((item) => item.latencyMs)),
    }))
    .sort((a, b) => b.requests - a.requests || b.totalSpendUsd - a.totalSpendUsd);
}

function groupErrors(
  requests: readonly RequestRow[],
  attempts: readonly AttemptRow[],
): readonly ErrorAnalyticsRow[] {
  const rows: ErrorAnalyticsRow[] = [
    ...requests
      .filter((request) => request.status === "failed" && request.errorMessage)
      .map((request) => ({
        errorMessage: request.errorMessage ?? "Unknown error",
        provider: request.provider ?? undefined,
        model: request.selectedModel ?? undefined,
        count: 1,
      })),
    ...attempts
      .filter((attempt) => attempt.status === "failed")
      .map((attempt) => ({
        errorMessage: attempt.errorMessage ?? "Provider attempt failed",
        provider: attempt.provider,
        model: attempt.model,
        errorType: attempt.errorType ?? undefined,
        count: 1,
      })),
  ];

  return groupBy(
    rows,
    (row) => `${row.errorMessage}:${row.provider ?? ""}:${row.model ?? ""}:${row.errorType ?? ""}`,
  )
    .map((items) => ({
      ...items[0]!,
      count: sum(items, (item) => item.count),
    }))
    .sort((a, b) => b.count - a.count || a.errorMessage.localeCompare(b.errorMessage));
}

function groupCosts(requests: readonly RequestRow[]): readonly CostAnalyticsRow[] {
  return groupBy(requests, (request) => dayKey(request.createdAt))
    .map((items) => ({
      date: dayKey(items[0]!.createdAt),
      spendUsd: roundMoney(sum(items, (item) => item.estimatedCost ?? 0)),
      requests: items.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function groupLatency(requests: readonly RequestRow[]): readonly LatencyAnalyticsRow[] {
  return groupBy(
    requests.filter((request) => request.provider),
    (request) => `${dayKey(request.createdAt)}:${request.provider ?? "unknown"}`,
  )
    .map((items) => ({
      date: dayKey(items[0]!.createdAt),
      provider: items[0]?.provider ?? undefined,
      averageLatencyMs: average(items.map((item) => item.latencyMs)),
      p95LatencyMs: percentile(
        items.map((item) => item.latencyMs),
        0.95,
      ),
      requests: items.length,
    }))
    .sort(
      (a, b) => a.date.localeCompare(b.date) || (a.provider ?? "").localeCompare(b.provider ?? ""),
    );
}

function recentRequests(
  requests: readonly RequestRow[],
  limit: number,
): readonly RecentRequestAnalyticsRow[] {
  return [...requests]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, Math.max(1, Math.min(limit, 200)))
    .map((request) => ({
      id: request.id,
      timestamp: request.createdAt.toISOString(),
      requestedModel: request.requestedModel,
      workspaceId: request.workspaceId,
      selectedModel: request.selectedModel ?? undefined,
      provider: request.provider ?? undefined,
      status: request.status,
      latencyMs: request.latencyMs,
      costUsd: request.estimatedCost ?? undefined,
      routingMode: request.routingMode ?? undefined,
      routingStrategy: request.routingStrategy ?? undefined,
      errorMessage: request.errorMessage ?? undefined,
    }));
}

function countRoutingMode(
  requests: readonly RequestRow[],
  decisions: readonly RouterRow[],
  mode: string,
): number {
  const fromRequests = requests.filter((request) => request.routingMode === mode).length;
  if (fromRequests > 0) {
    return fromRequests;
  }

  return decisions.filter((decision) => decision.mode === mode).length;
}

function toRequestRow(
  entry: RequestLogEntry & { readonly id: string; readonly createdAt: Date },
): RequestRow {
  return {
    id: entry.id,
    requestedModel: entry.requestedModel,
    workspaceId: entry.workspaceId ?? null,
    selectedModel: entry.selectedModel ?? null,
    provider: entry.provider ?? null,
    inputTokens: entry.inputTokens ?? null,
    outputTokens: entry.outputTokens ?? null,
    estimatedCost: entry.estimatedCost ?? null,
    latencyMs: entry.latencyMs,
    status: entry.status,
    errorMessage: entry.errorMessage ?? null,
    routingMode: entry.routingMode ?? null,
    routingStrategy: entry.routingStrategy ?? null,
    createdAt: entry.createdAt,
  };
}

function toRouterRow(entry: RouterDecisionLogEntry & { readonly createdAt: Date }): RouterRow {
  return {
    requestLogId: entry.requestLogId ?? null,
    userId: entry.userId,
    mode: entry.mode,
    fallbackUsed: entry.fallbackUsed,
    createdAt: entry.createdAt,
  };
}

function toAttemptRow(entry: RequiredProviderAttemptLogEntry): AttemptRow {
  return {
    requestLogId: entry.requestLogId ?? null,
    userId: entry.userId,
    provider: entry.provider,
    model: entry.model,
    status: entry.status,
    latencyMs: entry.latencyMs,
    errorType: entry.errorType ?? null,
    errorMessage: entry.errorMessage ?? null,
    createdAt: entry.createdAt,
  };
}

function toExecutionPlanRow(
  entry: ExecutionPlanLogEntry & { readonly createdAt?: Date },
): ExecutionPlanRow {
  return {
    requestLogId: entry.requestLogId ?? null,
    userId: entry.userId,
    planType: entry.planType,
    estimatedCostUsd: entry.estimatedCostUsd,
    actualCostUsd: entry.actualCostUsd ?? null,
    executed: entry.executed,
    createdAt: entry.createdAt ?? new Date(),
  };
}

function normalizeRequestRow(row: RequestRow): RequestRow {
  return { ...row, createdAt: new Date(row.createdAt) };
}

function normalizeRouterRow(row: RouterRow): RouterRow {
  return { ...row, createdAt: new Date(row.createdAt) };
}

function normalizeAttemptRow(row: AttemptRow): AttemptRow {
  return { ...row, createdAt: new Date(row.createdAt) };
}

function normalizeExecutionPlanRow(row: ExecutionPlanRow): ExecutionPlanRow {
  return { ...row, createdAt: new Date(row.createdAt) };
}

function dateInRange(date: Date, filters: AnalyticsFilters): boolean {
  return (
    (filters.from === undefined || date.getTime() >= filters.from.getTime()) &&
    (filters.to === undefined || date.getTime() <= filters.to.getTime())
  );
}

function groupBy<TItem>(items: readonly TItem[], keyFor: (item: TItem) => string): TItem[][] {
  const groups = new Map<string, TItem[]>();
  for (const item of items) {
    const key = keyFor(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.values()];
}

function unionSets<TItem>(...sets: readonly Set<TItem>[]): Set<TItem> {
  return new Set(sets.flatMap((set) => [...set]));
}

function sum<TItem>(items: readonly TItem[], valueFor: (item: TItem) => number): number {
  return items.reduce((total, item) => total + valueFor(item), 0);
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return Math.round(sum(values, (value) => value) / values.length);
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * percentileValue) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function roundMoney(value: number): number {
  return Number(value.toFixed(6));
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
