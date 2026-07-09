import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type CircuitBreakerStatus = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerSnapshot {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly state: CircuitBreakerStatus;
  readonly failureCount: number;
  readonly openedAt?: Date;
  readonly halfOpenAt?: Date;
  readonly lastFailureAt?: Date;
  readonly lastSuccessAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CircuitBreakerService {
  getState(provider: string, model: string): Promise<CircuitBreakerSnapshot>;
  canAttempt(provider: string, model: string): Promise<boolean>;
  recordSuccess(provider: string, model: string): Promise<void>;
  recordFailure(provider: string, model: string): Promise<void>;
  reset(provider: string, model: string): Promise<void>;
  list(provider?: string): Promise<readonly CircuitBreakerSnapshot[]>;
}

const failureThreshold = 5;
const failureWindowMs = 5 * 60 * 1000;
const openDurationMs = 2 * 60 * 1000;

export class InMemoryCircuitBreakerService implements CircuitBreakerService {
  protected readonly states = new Map<string, CircuitBreakerSnapshot>();
  private readonly failureTimestamps = new Map<string, Date[]>();

  async getState(provider: string, model: string): Promise<CircuitBreakerSnapshot> {
    const existing = this.states.get(keyFor(provider, model));
    if (existing) {
      return this.maybeTransition(existing);
    }

    const now = new Date();
    const created = {
      id: randomUUID(),
      provider,
      model,
      state: "CLOSED" as const,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.states.set(keyFor(provider, model), created);
    await this.persist(created);
    return created;
  }

  async canAttempt(provider: string, model: string): Promise<boolean> {
    const state = await this.getState(provider, model);
    return state.state !== "OPEN";
  }

  async recordSuccess(provider: string, model: string): Promise<void> {
    const state = await this.getState(provider, model);
    const now = new Date();
    const next = {
      ...state,
      state: "CLOSED" as const,
      failureCount: 0,
      openedAt: undefined,
      halfOpenAt: undefined,
      lastSuccessAt: now,
      updatedAt: now,
    };

    this.failureTimestamps.set(keyFor(provider, model), []);
    this.states.set(keyFor(provider, model), next);
    await this.persist(next);
  }

  async recordFailure(provider: string, model: string): Promise<void> {
    const state = await this.getState(provider, model);
    const key = keyFor(provider, model);
    const now = new Date();

    if (state.state === "HALF_OPEN") {
      const next = this.openState(state, now);
      this.states.set(key, next);
      await this.persist(next);
      return;
    }

    const cutoff = now.getTime() - failureWindowMs;
    const failures = [...(this.failureTimestamps.get(key) ?? []), now].filter(
      (timestamp) => timestamp.getTime() >= cutoff,
    );
    this.failureTimestamps.set(key, failures);

    const next =
      failures.length >= failureThreshold
        ? this.openState(state, now)
        : {
            ...state,
            failureCount: failures.length,
            lastFailureAt: now,
            updatedAt: now,
          };

    this.states.set(key, next);
    await this.persist(next);
  }

  async reset(provider: string, model: string): Promise<void> {
    const state = await this.getState(provider, model);
    const now = new Date();
    const next = {
      ...state,
      state: "CLOSED" as const,
      failureCount: 0,
      openedAt: undefined,
      halfOpenAt: undefined,
      updatedAt: now,
    };

    this.failureTimestamps.set(keyFor(provider, model), []);
    this.states.set(keyFor(provider, model), next);
    await this.persist(next);
  }

  async list(provider?: string): Promise<readonly CircuitBreakerSnapshot[]> {
    const values = await Promise.all(
      [...this.states.values()].map((state) => this.maybeTransition(state)),
    );
    return values
      .filter((state) => provider === undefined || state.provider === provider)
      .sort((a, b) => `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`));
  }

  protected persist(_state: CircuitBreakerSnapshot): Promise<void> {
    void _state;
    return Promise.resolve();
  }

  private async maybeTransition(state: CircuitBreakerSnapshot): Promise<CircuitBreakerSnapshot> {
    if (
      state.state !== "OPEN" ||
      !state.openedAt ||
      Date.now() - state.openedAt.getTime() < openDurationMs
    ) {
      return state;
    }

    const now = new Date();
    const next = {
      ...state,
      state: "HALF_OPEN" as const,
      halfOpenAt: now,
      updatedAt: now,
    };
    this.states.set(keyFor(state.provider, state.model), next);
    await this.persist(next);
    return next;
  }

  private openState(state: CircuitBreakerSnapshot, now: Date): CircuitBreakerSnapshot {
    return {
      ...state,
      state: "OPEN",
      failureCount: state.failureCount + 1,
      openedAt: now,
      halfOpenAt: undefined,
      lastFailureAt: now,
      updatedAt: now,
    };
  }
}

export class PrismaCircuitBreakerService extends InMemoryCircuitBreakerService {
  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  override async getState(provider: string, model: string): Promise<CircuitBreakerSnapshot> {
    const [row] = await this.prisma.$queryRaw<CircuitBreakerRow[]>`
      SELECT * FROM "CircuitBreakerState"
      WHERE "provider" = ${provider} AND "model" = ${model}
      LIMIT 1
    `;

    if (row) {
      const snapshot = normalizeCircuitBreakerRow(row);
      this.states.set(keyFor(provider, model), snapshot);
      return super.getState(provider, model);
    }

    return super.getState(provider, model);
  }

  override async list(provider?: string): Promise<readonly CircuitBreakerSnapshot[]> {
    const rows = provider
      ? await this.prisma.$queryRaw<CircuitBreakerRow[]>`
          SELECT * FROM "CircuitBreakerState"
          WHERE "provider" = ${provider}
          ORDER BY "provider" ASC, "model" ASC
        `
      : await this.prisma.$queryRaw<CircuitBreakerRow[]>`
          SELECT * FROM "CircuitBreakerState"
          ORDER BY "provider" ASC, "model" ASC
        `;

    for (const row of rows) {
      const snapshot = normalizeCircuitBreakerRow(row);
      this.states.set(keyFor(snapshot.provider, snapshot.model), snapshot);
    }

    return super.list(provider);
  }

  protected override async persist(state: CircuitBreakerSnapshot): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "CircuitBreakerState" (
        "id",
        "provider",
        "model",
        "state",
        "failureCount",
        "openedAt",
        "halfOpenAt",
        "lastFailureAt",
        "lastSuccessAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${state.id},
        ${state.provider},
        ${state.model},
        ${state.state},
        ${state.failureCount},
        ${state.openedAt ?? null},
        ${state.halfOpenAt ?? null},
        ${state.lastFailureAt ?? null},
        ${state.lastSuccessAt ?? null},
        ${state.createdAt},
        ${state.updatedAt}
      )
      ON CONFLICT ("provider", "model") DO UPDATE SET
        "state" = EXCLUDED."state",
        "failureCount" = EXCLUDED."failureCount",
        "openedAt" = EXCLUDED."openedAt",
        "halfOpenAt" = EXCLUDED."halfOpenAt",
        "lastFailureAt" = EXCLUDED."lastFailureAt",
        "lastSuccessAt" = EXCLUDED."lastSuccessAt",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }
}

interface CircuitBreakerRow {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly state: CircuitBreakerStatus;
  readonly failureCount: number;
  readonly openedAt: Date | null;
  readonly halfOpenAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function normalizeCircuitBreakerRow(row: CircuitBreakerRow): CircuitBreakerSnapshot {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    state: row.state,
    failureCount: row.failureCount,
    openedAt: row.openedAt ? new Date(row.openedAt) : undefined,
    halfOpenAt: row.halfOpenAt ? new Date(row.halfOpenAt) : undefined,
    lastFailureAt: row.lastFailureAt ? new Date(row.lastFailureAt) : undefined,
    lastSuccessAt: row.lastSuccessAt ? new Date(row.lastSuccessAt) : undefined,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function keyFor(provider: string, model: string): string {
  return `${provider}:${model}`;
}
