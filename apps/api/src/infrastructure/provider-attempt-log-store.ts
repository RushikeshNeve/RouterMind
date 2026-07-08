import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ProviderErrorType } from "./provider-error-classifier.js";

export interface ProviderAttemptLogEntry {
  readonly requestLogId?: string;
  readonly userId: string;
  readonly provider: string;
  readonly model: string;
  readonly attemptNumber: number;
  readonly status: "success" | "failed";
  readonly latencyMs: number;
  readonly errorType?: ProviderErrorType;
  readonly errorMessage?: string;
  readonly createdAt?: Date;
}

export interface ProviderAttemptLogStore {
  create(entry: ProviderAttemptLogEntry): Promise<void>;
  list(filters?: {
    readonly userId?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly status?: "success" | "failed";
    readonly limit?: number;
  }): Promise<readonly RequiredProviderAttemptLogEntry[]>;
}

export type RequiredProviderAttemptLogEntry = ProviderAttemptLogEntry & {
  readonly id: string;
  readonly createdAt: Date;
};

export class InMemoryProviderAttemptLogStore implements ProviderAttemptLogStore {
  readonly entries: RequiredProviderAttemptLogEntry[] = [];

  create(entry: ProviderAttemptLogEntry): Promise<void> {
    this.entries.push({
      ...entry,
      id: randomUUID(),
      createdAt: entry.createdAt ?? new Date(),
    });
    return Promise.resolve();
  }

  list(filters: Parameters<ProviderAttemptLogStore["list"]>[0] = {}) {
    const limit = filters.limit ?? 100;
    return Promise.resolve(
      this.entries
        .filter(
          (entry) =>
            (filters.userId === undefined || entry.userId === filters.userId) &&
            (filters.provider === undefined || entry.provider === filters.provider) &&
            (filters.model === undefined || entry.model === filters.model) &&
            (filters.status === undefined || entry.status === filters.status),
        )
        .slice(-limit)
        .reverse(),
    );
  }
}

export class PrismaProviderAttemptLogStore implements ProviderAttemptLogStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(entry: ProviderAttemptLogEntry): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "ProviderAttemptLog" (
        "id",
        "requestLogId",
        "userId",
        "provider",
        "model",
        "attemptNumber",
        "status",
        "latencyMs",
        "errorType",
        "errorMessage",
        "createdAt"
      )
      VALUES (
        ${randomUUID()},
        ${entry.requestLogId ?? null},
        ${entry.userId},
        ${entry.provider},
        ${entry.model},
        ${entry.attemptNumber},
        ${entry.status},
        ${entry.latencyMs},
        ${entry.errorType ?? null},
        ${entry.errorMessage ?? null},
        ${entry.createdAt ?? new Date()}
      )
    `;
  }

  async list(filters: Parameters<ProviderAttemptLogStore["list"]>[0] = {}) {
    const limit = Math.min(filters.limit ?? 100, 500);
    const rows = await this.prisma.$queryRaw<ProviderAttemptLogRow[]>`
      SELECT * FROM "ProviderAttemptLog"
      WHERE (${filters.userId ?? null}::text IS NULL OR "userId" = ${filters.userId ?? null})
        AND (${filters.provider ?? null}::text IS NULL OR "provider" = ${filters.provider ?? null})
        AND (${filters.model ?? null}::text IS NULL OR "model" = ${filters.model ?? null})
        AND (${filters.status ?? null}::text IS NULL OR "status" = ${filters.status ?? null})
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      ...row,
      requestLogId: row.requestLogId ?? undefined,
      errorType: row.errorType ?? undefined,
      errorMessage: row.errorMessage ?? undefined,
      createdAt: new Date(row.createdAt),
    }));
  }
}

interface ProviderAttemptLogRow {
  readonly id: string;
  readonly requestLogId: string | null;
  readonly userId: string;
  readonly provider: string;
  readonly model: string;
  readonly attemptNumber: number;
  readonly status: "success" | "failed";
  readonly latencyMs: number;
  readonly errorType: ProviderErrorType | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
}
