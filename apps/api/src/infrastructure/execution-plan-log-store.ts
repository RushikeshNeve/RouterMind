import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ExecutionPlanStep, ExecutionPlanType } from "./ai-planner-service.js";

export interface ExecutionPlanLogEntry {
  readonly requestLogId?: string;
  readonly workspaceId?: string;
  readonly userId: string;
  readonly planType: ExecutionPlanType;
  readonly stepsJson: readonly ExecutionPlanStep[];
  readonly estimatedCostUsd: number;
  readonly actualCostUsd?: number;
  readonly confidence: number;
  readonly reason: string;
  readonly executed: boolean;
  readonly createdAt?: Date;
}

export interface ExecutionPlanLogStore {
  create(entry: ExecutionPlanLogEntry): Promise<void>;
}

export class InMemoryExecutionPlanLogStore implements ExecutionPlanLogStore {
  readonly entries: ExecutionPlanLogEntry[] = [];

  create(entry: ExecutionPlanLogEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

export class PrismaExecutionPlanLogStore implements ExecutionPlanLogStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(entry: ExecutionPlanLogEntry): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "ExecutionPlanLog" (
        "id",
        "requestLogId",
        "workspaceId",
        "userId",
        "planType",
        "stepsJson",
        "estimatedCostUsd",
        "actualCostUsd",
        "confidence",
        "reason",
        "executed",
        "createdAt"
      )
      VALUES (
        ${randomUUID()},
        ${entry.requestLogId ?? null},
        ${entry.workspaceId ?? null},
        ${entry.userId},
        ${entry.planType},
        ${JSON.stringify(entry.stepsJson)}::jsonb,
        ${entry.estimatedCostUsd},
        ${entry.actualCostUsd ?? null},
        ${entry.confidence},
        ${entry.reason},
        ${entry.executed},
        ${entry.createdAt ?? new Date()}
      )
    `;
  }
}
