import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ProviderId } from "@routemind/providers";

export type ProviderHealthStatus = "healthy" | "degraded" | "down";
export type ProviderRequestErrorCode =
  | "timeout"
  | "rate_limit"
  | "invalid_api_key"
  | "provider_unavailable"
  | "provider_bad_request"
  | "malformed_response"
  | "missing_api_key"
  | "unsupported_model"
  | "unknown";

export interface ProviderHealthMetric {
  readonly provider: ProviderId;
  readonly model: string;
  readonly status: ProviderHealthStatus;
  readonly avgLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly successRate: number;
  readonly errorRate: number;
  readonly timeoutRate: number;
  readonly rateLimitRate: number;
  readonly windowMinutes: number;
  readonly sampleSize: number;
  readonly lastErrorCode?: ProviderRequestErrorCode;
  readonly lastErrorMessage?: string;
  readonly lastCheckedAt: Date;
  readonly updatedAt: Date;
}

export interface ProviderRequestSample {
  readonly provider: ProviderId;
  readonly model: string;
  readonly latencyMs: number;
  readonly success: boolean;
  readonly errorCode?: ProviderRequestErrorCode;
  readonly errorMessage?: string;
  readonly timestamp: Date;
}

export interface ProviderHealthService {
  record(sample: ProviderRequestSample): Promise<ProviderHealthMetric>;
  list(provider?: ProviderId, model?: string): Promise<readonly ProviderHealthMetric[]>;
  get(provider: ProviderId, model: string): Promise<ProviderHealthMetric | undefined>;
}

const maxSamples = 100;
const windowMinutes = 60;

export class InMemoryProviderHealthService implements ProviderHealthService {
  protected readonly samplesByModel = new Map<string, ProviderRequestSample[]>();
  protected readonly metricsByModel = new Map<string, ProviderHealthMetric>();

  async record(sample: ProviderRequestSample): Promise<ProviderHealthMetric> {
    const key = metricKey(sample.provider, sample.model);
    const existing = this.samplesByModel.get(key) ?? [];
    const cutoff = sample.timestamp.getTime() - windowMinutes * 60 * 1000;
    const samples = [...existing, sample]
      .filter((item) => item.timestamp.getTime() >= cutoff)
      .slice(-maxSamples);
    const metric = calculateMetric(sample.provider, sample.model, samples);

    this.samplesByModel.set(key, samples);
    this.metricsByModel.set(key, metric);
    await this.persist(metric);
    return metric;
  }

  list(provider?: ProviderId, model?: string): Promise<readonly ProviderHealthMetric[]> {
    return Promise.resolve(
      [...this.metricsByModel.values()].filter(
        (metric) =>
          (provider === undefined || metric.provider === provider) &&
          (model === undefined || metric.model === model),
      ),
    );
  }

  async get(provider: ProviderId, model: string): Promise<ProviderHealthMetric | undefined> {
    const existing = this.metricsByModel.get(metricKey(provider, model));
    if (existing) {
      return existing;
    }

    const [metric] = await this.list(provider, model);
    return metric;
  }

  protected persist(_metric: ProviderHealthMetric): Promise<void> {
    void _metric;
    return Promise.resolve();
  }
}

export class PrismaProviderHealthService extends InMemoryProviderHealthService {
  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  override async list(
    provider?: ProviderId,
    model?: string,
  ): Promise<readonly ProviderHealthMetric[]> {
    const rows =
      provider && model
        ? await this.prisma.$queryRaw<ProviderHealthMetric[]>`
            SELECT * FROM "ProviderHealthMetric"
            WHERE "provider" = ${provider} AND "model" = ${model}
            ORDER BY "provider" ASC, "model" ASC
          `
        : provider
          ? await this.prisma.$queryRaw<ProviderHealthMetric[]>`
              SELECT * FROM "ProviderHealthMetric"
              WHERE "provider" = ${provider}
              ORDER BY "provider" ASC, "model" ASC
            `
          : await this.prisma.$queryRaw<ProviderHealthMetric[]>`
              SELECT * FROM "ProviderHealthMetric"
              ORDER BY "provider" ASC, "model" ASC
            `;

    return rows.map(normalizeMetricRow);
  }

  protected override async persist(metric: ProviderHealthMetric): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "ProviderHealthMetric" (
        "id",
        "provider",
        "model",
        "status",
        "avgLatencyMs",
        "p95LatencyMs",
        "successRate",
        "errorRate",
        "timeoutRate",
        "rateLimitRate",
        "windowMinutes",
        "sampleSize",
        "lastErrorCode",
        "lastErrorMessage",
        "lastCheckedAt",
        "updatedAt"
      )
      VALUES (
        ${randomUUID()},
        ${metric.provider},
        ${metric.model},
        ${metric.status},
        ${metric.avgLatencyMs},
        ${metric.p95LatencyMs},
        ${metric.successRate},
        ${metric.errorRate},
        ${metric.timeoutRate},
        ${metric.rateLimitRate},
        ${metric.windowMinutes},
        ${metric.sampleSize},
        ${metric.lastErrorCode ?? null},
        ${metric.lastErrorMessage ?? null},
        ${metric.lastCheckedAt},
        ${metric.updatedAt}
      )
      ON CONFLICT ("provider", "model") DO UPDATE SET
        "status" = EXCLUDED."status",
        "avgLatencyMs" = EXCLUDED."avgLatencyMs",
        "p95LatencyMs" = EXCLUDED."p95LatencyMs",
        "successRate" = EXCLUDED."successRate",
        "errorRate" = EXCLUDED."errorRate",
        "timeoutRate" = EXCLUDED."timeoutRate",
        "rateLimitRate" = EXCLUDED."rateLimitRate",
        "windowMinutes" = EXCLUDED."windowMinutes",
        "sampleSize" = EXCLUDED."sampleSize",
        "lastErrorCode" = EXCLUDED."lastErrorCode",
        "lastErrorMessage" = EXCLUDED."lastErrorMessage",
        "lastCheckedAt" = EXCLUDED."lastCheckedAt",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }
}

function calculateMetric(
  provider: ProviderId,
  model: string,
  samples: readonly ProviderRequestSample[],
): ProviderHealthMetric {
  const sortedLatencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const sampleSize = samples.length;
  const failures = samples.filter((sample) => !sample.success);
  const timeouts = samples.filter((sample) => sample.errorCode === "timeout");
  const rateLimits = samples.filter((sample) => sample.errorCode === "rate_limit");
  const lastFailure = [...failures].reverse()[0];
  const avgLatencyMs =
    sampleSize === 0
      ? 0
      : Math.round(samples.reduce((total, sample) => total + sample.latencyMs, 0) / sampleSize);
  const p95LatencyMs = percentile(sortedLatencies, 0.95);
  const successRate = sampleSize === 0 ? 1 : roundRate((sampleSize - failures.length) / sampleSize);
  const errorRate = sampleSize === 0 ? 0 : roundRate(failures.length / sampleSize);
  const timeoutRate = sampleSize === 0 ? 0 : roundRate(timeouts.length / sampleSize);
  const rateLimitRate = sampleSize === 0 ? 0 : roundRate(rateLimits.length / sampleSize);
  const now = new Date();

  return {
    provider,
    model,
    status: calculateStatus({ successRate, p95LatencyMs, timeoutRate }),
    avgLatencyMs,
    p95LatencyMs,
    successRate,
    errorRate,
    timeoutRate,
    rateLimitRate,
    windowMinutes,
    sampleSize,
    lastErrorCode: lastFailure?.errorCode,
    lastErrorMessage: lastFailure?.errorMessage,
    lastCheckedAt: samples[samples.length - 1]?.timestamp ?? now,
    updatedAt: now,
  };
}

function calculateStatus(input: {
  readonly successRate: number;
  readonly p95LatencyMs: number;
  readonly timeoutRate: number;
}): ProviderHealthStatus {
  if (input.successRate < 0.9 || input.timeoutRate > 0.2) {
    return "down";
  }

  if ((input.successRate >= 0.9 && input.successRate < 0.98) || input.p95LatencyMs > 8_000) {
    return "degraded";
  }

  return "healthy";
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))] ?? 0;
}

function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

function normalizeMetricRow(row: ProviderHealthMetric): ProviderHealthMetric {
  return {
    ...row,
    lastCheckedAt: new Date(row.lastCheckedAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function metricKey(provider: ProviderId, model: string): string {
  return `${provider}:${model}`;
}
