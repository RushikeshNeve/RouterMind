import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ProviderAdapter } from "@routemind/providers";

import { buildApp } from "../app.js";
import type { ApiConfig } from "../config.js";
import { InMemoryAnalyticsService } from "../infrastructure/analytics-service.js";
import { InMemoryExecutionPlanLogStore } from "../infrastructure/execution-plan-log-store.js";
import { InMemoryProviderAttemptLogStore } from "../infrastructure/provider-attempt-log-store.js";
import { InMemoryRateLimiter } from "../infrastructure/rate-limiter.js";
import { InMemoryRequestLogStore } from "../infrastructure/request-log-store.js";
import { RetryPolicyService } from "../infrastructure/retry-policy-service.js";
import { InMemoryRouterDecisionLogStore } from "../infrastructure/router-decision-log-store.js";
import type { UserAvailabilityStore } from "../infrastructure/user-availability.js";
import {
  InMemoryWorkspaceService,
  PrismaWorkspaceService,
} from "../infrastructure/workspace-service.js";
import { hashApiKey } from "../security/api-key.js";
import { seedRoles } from "../scripts/seed-rbac.js";

export const testConfig: ApiConfig = {
  DATABASE_URL: "postgresql://routemind:routemind@localhost:5432/routemind?schema=public",
  DEV_API_KEY: "dev-key",
  CREDENTIAL_ENCRYPTION_KEY: "development-credential-key-change-me",
  LOG_LEVEL: "silent",
  NODE_ENV: "test",
  PORT: 3000,
  PROVIDER_MODE: "mock",
  PROVIDER_TIMEOUT_MS: 30_000,
  ROUTER_LLM_ENABLED: false,
  ROUTER_LLM_MAX_TOKENS: 300,
  ROUTER_LLM_MODEL: "gpt-4o-mini",
  REDIS_URL: "redis://localhost:6379",
};

export interface WorkspaceRoleFixture {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly apiKeyId: string;
  readonly apiKey: string;
}

export async function seedWorkspaceWithRole(
  prisma: PrismaClient,
  roleName: string,
  workspaceIdOverride?: string,
): Promise<WorkspaceRoleFixture> {
  await seedRoles(prisma);
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });

  const organization = await prisma.organization.create({
    data: { name: `RBAC Test Org ${randomUUID()}` },
  });
  const user = await prisma.user.create({
    data: { name: `RBAC Test User ${randomUUID()}`, email: `${randomUUID()}@rbac-test.local` },
  });
  const workspace = await prisma.workspace.create({
    data: {
      id: workspaceIdOverride,
      name: "RBAC Test Workspace",
      slug: `rbac-test-${randomUUID()}`,
      organizationId: organization.id,
    },
  });
  const principal = await prisma.principal.create({
    data: { type: "user", displayName: user.name },
  });
  await prisma.user.update({ where: { id: user.id }, data: { principalId: principal.id } });
  const membership = await prisma.membership.create({
    data: { workspaceId: workspace.id, principalId: principal.id, role: roleName, roleId: role.id },
  });

  const apiKey = `rm_test_${randomBytes(24).toString("base64url")}`;
  const apiKeyRecord = await prisma.apiKey.create({
    data: {
      userId: user.id,
      workspaceId: workspace.id,
      principalId: principal.id,
      name: "RBAC test key",
      keyHash: hashApiKey(apiKey),
    },
  });

  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    principalId: principal.id,
    userId: user.id,
    membershipId: membership.id,
    apiKeyId: apiKeyRecord.id,
    apiKey,
  };
}

export async function cleanupFixture(
  prisma: PrismaClient,
  fixture: WorkspaceRoleFixture,
): Promise<void> {
  await prisma.apiKey.deleteMany({ where: { id: fixture.apiKeyId } });
  await prisma.membership.deleteMany({ where: { id: fixture.membershipId } });
  await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
  await prisma.organization.deleteMany({ where: { id: fixture.organizationId } });
  await prisma.principal.deleteMany({ where: { id: fixture.principalId } });
  await prisma.user.deleteMany({ where: { id: fixture.userId } });
}

export async function createWorkspaceTestApp(
  options: {
    readonly costGuardrailService?: {
      checkBeforeRequest(input: {
        userId: string;
        workspaceId?: string;
        estimatedCostUsd: number;
        estimatedTokens: number;
        maxEstimatedCostUsd?: number;
      }): Promise<{ allowed: boolean; errorCode?: "BUDGET_EXCEEDED"; message?: string }>;
      recordUsage(input: {
        userId: string;
        workspaceId?: string;
        actualCostUsd: number;
        totalTokens: number;
      }): Promise<void>;
    };
  } = {},
) {
  const workspaceService = new InMemoryWorkspaceService();
  const requestLogStore = new InMemoryRequestLogStore();
  const routerDecisionLogStore = new InMemoryRouterDecisionLogStore();
  const providerAttemptLogStore = new InMemoryProviderAttemptLogStore();
  const executionPlanLogStore = new InMemoryExecutionPlanLogStore();
  const availabilityWorkspaceIds: Array<string | undefined> = [];
  const availabilityStore: UserAvailabilityStore = {
    getAvailability: (user) => {
      availabilityWorkspaceIds.push(user.workspaceId);
      return Promise.resolve({
        enabledProviders: ["openai"],
        enabledModels: ["gpt-4o"],
        providerApiKeys: {},
      });
    },
  };
  const provider: ProviderAdapter = {
    providerName: "openai",
    supportedModels: ["gpt-4o"],
    chatCompletion: (request) =>
      Promise.resolve({
        id: "workspace-chat",
        object: "chat.completion",
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
  };
  const analyticsService = new InMemoryAnalyticsService(
    requestLogStore,
    routerDecisionLogStore,
    providerAttemptLogStore,
    executionPlanLogStore,
  );
  const app = await buildApp({
    config: testConfig,
    workspaceService,
    requestLogStore,
    routerDecisionLogStore,
    providerAttemptLogStore,
    executionPlanLogStore,
    analyticsService,
    availabilityStore,
    rateLimiter: new InMemoryRateLimiter(),
    retryPolicyService: new RetryPolicyService(undefined, undefined, () => Promise.resolve()),
    providers: new Map([["openai", provider]]),
    costGuardrailService: options.costGuardrailService ?? {
      checkBeforeRequest: () => Promise.resolve({ allowed: true }),
      recordUsage: () => Promise.resolve(),
    },
  });

  return {
    app,
    workspaceService,
    requestLogStore,
    availabilityWorkspaceIds,
  };
}

/**
 * Like createWorkspaceTestApp, but backed by PrismaWorkspaceService instead
 * of the in-memory one. Needed for tests that issue a key through a route
 * and then use that same key against another requirePermission-gated route
 * in the same test — requirePermission only ever reads real Postgres, so an
 * in-memory-issued key would never resolve there.
 */
export async function createPrismaWorkspaceTestApp(prisma: PrismaClient) {
  const workspaceService = new PrismaWorkspaceService(prisma);
  const app = await buildApp({
    config: testConfig,
    prisma,
    workspaceService,
  });
  return { app, workspaceService };
}
