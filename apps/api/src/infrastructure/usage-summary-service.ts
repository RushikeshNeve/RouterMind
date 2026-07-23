import type { PrismaClient } from "@prisma/client";

export interface UsageSummary {
  readonly organizationId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly requestCount: number;
  readonly tokenCount: number;
}

interface UsageSummaryRow {
  readonly requestCount: bigint | number;
  readonly tokenCount: bigint | number;
}

/**
 * Computed on read directly from RequestLog (joined through Workspace to
 * get organizationId, which RequestLog doesn't carry directly) -- no
 * separate UsageSummary table. Current RequestLog volume in this
 * environment is trivial (19 rows), so a nightly precomputation job would
 * be a second counting system for no real benefit yet; revisit if volume
 * grows enough that this on-read query shows up in latency profiling.
 *
 * Only status = "success" requests count -- a request that failed before
 * reaching a provider (auth error, validation error, etc.) was never
 * actually billable usage. This is an interpretation decision, not an
 * explicit spec requirement; flagged here rather than assumed silently.
 */
export async function computeUsageSummary(
  prisma: PrismaClient,
  input: { readonly organizationId: string; readonly periodStart: Date; readonly periodEnd: Date },
): Promise<UsageSummary> {
  const [row] = await prisma.$queryRaw<UsageSummaryRow[]>`
    SELECT
      COUNT(*)::int AS "requestCount",
      COALESCE(SUM(COALESCE(r."inputTokens", 0) + COALESCE(r."outputTokens", 0)), 0)::int AS "tokenCount"
    FROM "RequestLog" r
    JOIN "Workspace" w ON w.id = r."workspaceId"
    WHERE w."organizationId" = ${input.organizationId}
      AND r.status = 'success'
      AND r."createdAt" >= ${input.periodStart}
      AND r."createdAt" < ${input.periodEnd}
  `;

  return {
    organizationId: input.organizationId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    requestCount: Number(row?.requestCount ?? 0),
    tokenCount: Number(row?.tokenCount ?? 0),
  };
}

/**
 * Falls back to the current calendar month when the org has no active
 * Subscription with a known billing period (e.g. still on Free, which
 * never goes through checkout so never gets a Subscription row).
 */
export function defaultUsagePeriod(
  subscription: {
    readonly currentPeriodStart: Date | null;
    readonly currentPeriodEnd: Date | null;
  } | null,
): { readonly periodStart: Date; readonly periodEnd: Date } {
  if (subscription?.currentPeriodStart && subscription.currentPeriodEnd) {
    return {
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
    };
  }
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd };
}
