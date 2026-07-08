import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export interface RouterDecisionLogEntry {
  readonly requestLogId?: string | undefined;
  readonly userId: string;
  readonly mode: string;
  readonly routerModelUsed?: string | undefined;
  readonly detectedTask?: string | undefined;
  readonly complexity?: string | undefined;
  readonly candidateModelsJson: unknown;
  readonly selectedModel?: string | undefined;
  readonly selectedProvider?: string | undefined;
  readonly confidence?: number | undefined;
  readonly reason?: string | undefined;
  readonly fallbackUsed: boolean;
  readonly createdAt?: Date;
}

export interface RouterDecisionLogStore {
  create(entry: RouterDecisionLogEntry): Promise<void>;
}

export class PrismaRouterDecisionLogStore implements RouterDecisionLogStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(entry: RouterDecisionLogEntry): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "RouterDecisionLog" (
        "id",
        "requestLogId",
        "userId",
        "mode",
        "routerModelUsed",
        "detectedTask",
        "complexity",
        "candidateModelsJson",
        "selectedModel",
        "selectedProvider",
        "confidence",
        "reason",
        "fallbackUsed",
        "createdAt"
      )
      VALUES (
        ${randomUUID()},
        ${entry.requestLogId ?? null},
        ${entry.userId},
        ${entry.mode},
        ${entry.routerModelUsed ?? null},
        ${entry.detectedTask ?? null},
        ${entry.complexity ?? null},
        ${JSON.stringify(entry.candidateModelsJson)}::jsonb,
        ${entry.selectedModel ?? null},
        ${entry.selectedProvider ?? null},
        ${entry.confidence ?? null},
        ${entry.reason ?? null},
        ${entry.fallbackUsed},
        ${entry.createdAt ?? new Date()}
      )
    `;
  }
}

export class InMemoryRouterDecisionLogStore implements RouterDecisionLogStore {
  readonly entries: Array<
    RouterDecisionLogEntry & { readonly id: string; readonly createdAt: Date }
  > = [];

  create(entry: RouterDecisionLogEntry): Promise<void> {
    this.entries.push({
      ...entry,
      id: randomUUID(),
      createdAt: entry.createdAt ?? new Date(),
    });
    return Promise.resolve();
  }
}
