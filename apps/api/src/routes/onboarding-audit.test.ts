import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { PrismaApiKeyAuthenticator } from "../infrastructure/authenticator.js";
import { PrismaOnboardingStore } from "../infrastructure/onboarding-store.js";
import { testConfig } from "./workspaces-rbac-fixtures.js";

/**
 * Verifies the onboarding.ts audit/workspace-provisioning behavior that
 * InMemoryOnboardingStore (used by onboarding.test.ts) can't model: real
 * Organization/Workspace/Membership/Principal rows and real AuditEvent rows
 * written in the same transaction as the mutation they record.
 */
describe("onboarding routes: workspace provisioning and audit trail", () => {
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const apps: FastifyInstance[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    const ids = userIds.splice(0);
    if (ids.length === 0) {
      return;
    }
    const users = await prisma.user.findMany({ where: { id: { in: ids } } });
    const principalIds = users.map((u) => u.principalId).filter((id): id is string => id !== null);
    const memberships = await prisma.membership.findMany({
      where: { principalId: { in: principalIds } },
    });
    const workspaceIds = memberships.map((m) => m.workspaceId);
    const workspaces = await prisma.workspace.findMany({ where: { id: { in: workspaceIds } } });
    const organizationIds = workspaces
      .map((w) => w.organizationId)
      .filter((id): id is string => id !== null);

    await prisma.auditEvent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.apiKey.deleteMany({ where: { userId: { in: ids } } });
    await prisma.providerCredential.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userModelAccess.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workspaceMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.membership.deleteMany({ where: { principalId: { in: principalIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.principal.deleteMany({ where: { id: { in: principalIds } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function buildOnboardingTestApp() {
    const onboardingStore = new PrismaOnboardingStore(prisma);
    const authenticator = new PrismaApiKeyAuthenticator(prisma, testConfig.DEV_API_KEY);
    const app = await buildApp({ config: testConfig, prisma, onboardingStore, authenticator });
    apps.push(app);
    return { app, onboardingStore };
  }

  function parse<T>(response: { payload: string }): T {
    return JSON.parse(response.payload) as T;
  }

  it("provisions a real Organization/Workspace/Membership and audits it, on user creation", async () => {
    const { app } = await buildOnboardingTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { name: "Audit Test User", email: `audit-${crypto.randomUUID()}@example.com` },
    });
    expect(response.statusCode).toBe(201);
    const user = parse<{ id: string }>(response);
    userIds.push(user.id);

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(dbUser.principalId).toBeTruthy();

    const membership = await prisma.membership.findFirstOrThrow({
      where: { principalId: dbUser.principalId! },
    });
    expect(membership.role).toBe("owner");

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: membership.workspaceId },
    });
    expect(workspace.slug).toBe(`personal-${user.id}`);
    expect(workspace.organizationId).toBeTruthy();

    const auditEvents = await prisma.auditEvent.findMany({
      where: { workspaceId: workspace.id },
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "member.add",
      targetType: "WorkspaceMember",
      principalId: dbUser.principalId,
    });
    expect(auditEvents[0]?.metadataJson).toMatchObject({ viaOnboarding: true });
  });

  it("writes an apikey.create audit event, scoped to the user's own workspace, on key creation", async () => {
    const { app, onboardingStore } = await buildOnboardingTestApp();
    const user = await onboardingStore.createUser({
      name: "Key Audit User",
      email: `key-audit-${crypto.randomUUID()}@example.com`,
    });
    userIds.push(user.id);

    const response = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      payload: { userId: user.id, name: "First Key" },
    });
    expect(response.statusCode).toBe(201);

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const membership = await prisma.membership.findFirstOrThrow({
      where: { principalId: dbUser.principalId! },
    });
    const apiKeyRow = await prisma.apiKey.findFirstOrThrow({ where: { userId: user.id } });
    expect(apiKeyRow.workspaceId).toBe(membership.workspaceId);
    expect(apiKeyRow.principalId).toBe(dbUser.principalId);

    const auditEvents = await prisma.auditEvent.findMany({
      where: { workspaceId: membership.workspaceId, action: "apikey.create" },
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.targetId).toBe(apiKeyRow.id);
  });

  it("writes provider_credential.upsert and provider_credential.update audit events, and sets workspaceId on the row", async () => {
    const { app, onboardingStore } = await buildOnboardingTestApp();
    const user = await onboardingStore.createUser({
      name: "Credential Audit User",
      email: `cred-audit-${crypto.randomUUID()}@example.com`,
    });
    userIds.push(user.id);
    const apiKeyResponse = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      payload: { userId: user.id, name: "First Key" },
    });
    const apiKey = parse<{ apiKey: string }>(apiKeyResponse).apiKey;

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/provider-credentials",
      headers: { "x-api-key": apiKey },
      payload: { userId: user.id, provider: "openai", apiKey: "sk-test-secret" },
    });
    expect(createResponse.statusCode).toBe(201);
    const credentialId = parse<{ id: string }>(createResponse).id;

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const membership = await prisma.membership.findFirstOrThrow({
      where: { principalId: dbUser.principalId! },
    });
    const credentialRow = await prisma.providerCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    expect(credentialRow.workspaceId).toBe(membership.workspaceId);

    const upsertEvents = await prisma.auditEvent.findMany({
      where: { workspaceId: membership.workspaceId, action: "provider_credential.upsert" },
    });
    expect(upsertEvents).toHaveLength(1);
    expect(upsertEvents[0]?.targetId).toBe(credentialId);

    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/v1/provider-credentials/${credentialId}`,
      headers: { "x-api-key": apiKey },
      payload: { isEnabled: false },
    });
    expect(patchResponse.statusCode).toBe(200);

    const updateEvents = await prisma.auditEvent.findMany({
      where: { workspaceId: membership.workspaceId, action: "provider_credential.update" },
    });
    expect(updateEvents).toHaveLength(1);
    expect(updateEvents[0]?.metadataJson).toMatchObject({ isEnabled: false });
  });

  it("writes a model_access.upsert audit event and sets workspaceId on the row", async () => {
    const { app, onboardingStore } = await buildOnboardingTestApp();
    const user = await onboardingStore.createUser({
      name: "Model Access Audit User",
      email: `model-audit-${crypto.randomUUID()}@example.com`,
    });
    userIds.push(user.id);
    const apiKeyResponse = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      payload: { userId: user.id, name: "First Key" },
    });
    const apiKey = parse<{ apiKey: string }>(apiKeyResponse).apiKey;

    const response = await app.inject({
      method: "POST",
      url: "/v1/model-access",
      headers: { "x-api-key": apiKey },
      payload: { userId: user.id, provider: "openai", model: "gpt-4o", isEnabled: true },
    });
    expect(response.statusCode).toBe(201);
    const modelAccessId = parse<{ id: string }>(response).id;

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const membership = await prisma.membership.findFirstOrThrow({
      where: { principalId: dbUser.principalId! },
    });
    const row = await prisma.userModelAccess.findUniqueOrThrow({ where: { id: modelAccessId } });
    expect(row.workspaceId).toBe(membership.workspaceId);

    const auditEvents = await prisma.auditEvent.findMany({
      where: { workspaceId: membership.workspaceId, action: "model_access.upsert" },
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.targetId).toBe(modelAccessId);
  });
});
