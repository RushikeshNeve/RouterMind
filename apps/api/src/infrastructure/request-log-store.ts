import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export interface RequestLogEntry {
  readonly apiKey: string;
  readonly requestedModel: string;
  readonly selectedModel?: string;
  readonly provider?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCost?: number;
  readonly latencyMs: number;
  readonly status: "success" | "failed";
  readonly errorMessage?: string;
  readonly providerStatusAtRouting?: string;
  readonly providerAvgLatencyAtRouting?: number;
  readonly providerSuccessRateAtRouting?: number;
  readonly routingMode?: string;
  readonly routingStrategy?: string;
}

export interface RequestLogStore {
  create(entry: RequestLogEntry): Promise<string>;
}

export class PrismaRequestLogStore implements RequestLogStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(entry: RequestLogEntry): Promise<string> {
    const id = randomUUID();

    await this.prisma.$executeRaw`
      INSERT INTO "RequestLog" (
        "id",
        "apiKey",
        "requestedModel",
        "selectedModel",
        "provider",
        "inputTokens",
        "outputTokens",
        "estimatedCost",
        "latencyMs",
        "status",
        "errorMessage",
        "providerStatusAtRouting",
        "providerAvgLatencyAtRouting",
        "providerSuccessRateAtRouting",
        "routingMode",
        "routingStrategy"
      )
      VALUES (
        ${id},
        ${entry.apiKey},
        ${entry.requestedModel},
        ${entry.selectedModel ?? null},
        ${entry.provider ?? null},
        ${entry.inputTokens ?? null},
        ${entry.outputTokens ?? null},
        ${entry.estimatedCost ?? null},
        ${entry.latencyMs},
        ${entry.status},
        ${entry.errorMessage ?? null},
        ${entry.providerStatusAtRouting ?? null},
        ${entry.providerAvgLatencyAtRouting ?? null},
        ${entry.providerSuccessRateAtRouting ?? null},
        ${entry.routingMode ?? null},
        ${entry.routingStrategy ?? null}
      )
    `;

    return id;
  }
}

export class InMemoryRequestLogStore implements RequestLogStore {
  readonly entries: RequestLogEntry[] = [];

  create(entry: RequestLogEntry): Promise<string> {
    const id = `request_log_${this.entries.length + 1}`;
    this.entries.push(entry);
    return Promise.resolve(id);
  }
}
