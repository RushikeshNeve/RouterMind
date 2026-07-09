export type ReadinessCheckStatus = "ok" | "error";

export interface ReadinessService {
  check(): Promise<{
    readonly status: "ready" | "not_ready";
    readonly checks: {
      readonly database: ReadinessCheckStatus;
      readonly redis: ReadinessCheckStatus;
      readonly providers: ReadinessCheckStatus;
    };
  }>;
}

export class StaticReadinessService implements ReadinessService {
  constructor(
    private readonly checks: {
      readonly database?: ReadinessCheckStatus;
      readonly redis?: ReadinessCheckStatus;
      readonly providers?: ReadinessCheckStatus;
    } = {},
  ) {}

  check(): Promise<Awaited<ReturnType<ReadinessService["check"]>>> {
    const checks = {
      database: this.checks.database ?? "ok",
      redis: this.checks.redis ?? "ok",
      providers: this.checks.providers ?? "ok",
    } as const;

    return Promise.resolve({
      status: Object.values(checks).every((status) => status === "ok") ? "ready" : "not_ready",
      checks,
    });
  }
}

export class DependencyReadinessService implements ReadinessService {
  constructor(
    private readonly dependencies: {
      readonly database: () => Promise<void>;
      readonly redis: () => Promise<void>;
      readonly providers: () => Promise<void>;
    },
  ) {}

  async check(): Promise<Awaited<ReturnType<ReadinessService["check"]>>> {
    const [database, redis, providers] = await Promise.all([
      runCheck(this.dependencies.database),
      runCheck(this.dependencies.redis),
      runCheck(this.dependencies.providers),
    ]);
    const checks = { database, redis, providers };

    return {
      status: Object.values(checks).every((status) => status === "ok") ? "ready" : "not_ready",
      checks,
    };
  }
}

async function runCheck(check: () => Promise<void>): Promise<ReadinessCheckStatus> {
  try {
    await check();
    return "ok";
  } catch {
    return "error";
  }
}
