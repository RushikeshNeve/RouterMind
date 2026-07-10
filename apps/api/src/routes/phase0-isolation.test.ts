import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupFixture,
  createPrismaWorkspaceTestApp,
  seedWorkspaceWithRole,
  testConfig,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

/**
 * Verifies the Phase 0 exit criteria from docs/roadmap.md: two orgs, each
 * with two workspaces, different roles, different router-model credentials,
 * and proof that one workspace's principal cannot see or spend another
 * workspace's budget, read another workspace's audit log, or list another
 * workspace's API keys.
 */
describe("Phase 0 exit criteria: cross-tenant isolation", () => {
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const apps: Array<{ readonly app: FastifyInstance }> = [];
  const fixtures: WorkspaceRoleFixture[] = [];

  let app: FastifyInstance;
  let orgAWorkspace1: WorkspaceRoleFixture; // Org A, Workspace A1, role Admin — the test subject.
  let orgAWorkspace2: WorkspaceRoleFixture; // Org A, Workspace A2, role Owner.
  let orgBWorkspace1: WorkspaceRoleFixture; // Org B, Workspace B1, role Owner.
  let orgBWorkspace2: WorkspaceRoleFixture; // Org B, Workspace B2, role Developer.

  beforeEach(async () => {
    const context = await createPrismaWorkspaceTestApp(prisma);
    apps.push(context);
    app = context.app;

    orgAWorkspace1 = await seedWorkspaceWithRole(prisma, "Admin");
    fixtures.push(orgAWorkspace1);
    orgAWorkspace2 = await seedWorkspaceWithRole(
      prisma,
      "Owner",
      undefined,
      orgAWorkspace1.organizationId,
    );
    fixtures.push(orgAWorkspace2);

    orgBWorkspace1 = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(orgBWorkspace1);
    orgBWorkspace2 = await seedWorkspaceWithRole(
      prisma,
      "Developer",
      undefined,
      orgBWorkspace1.organizationId,
    );
    fixtures.push(orgBWorkspace2);

    // Different router-model credentials per workspace. No workspace-scoped
    // route exists to create these (onboarding.ts's POST /v1/provider-credentials
    // is flat/userId-based and unauthenticated), so seeded directly.
    for (const [fixture, provider] of [
      [orgAWorkspace1, "openai"],
      [orgAWorkspace2, "anthropic"],
      [orgBWorkspace1, "gemini"],
      [orgBWorkspace2, "groq"],
    ] as const) {
      await prisma.providerCredential.create({
        data: {
          userId: fixture.userId,
          workspaceId: fixture.workspaceId,
          provider,
          encryptedApiKey: `placeholder-encrypted-key-for-${fixture.workspaceId}`,
        },
      });
    }

    // A budget per workspace, so spend isolation is provable, not assumed.
    for (const fixture of [orgAWorkspace1, orgAWorkspace2, orgBWorkspace1, orgBWorkspace2]) {
      await prisma.userBudget.create({
        data: {
          userId: fixture.userId,
          workspaceId: fixture.workspaceId,
          period: "monthly",
          maxSpendUsd: 100,
          currentSpendUsd: 0,
          resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
    }
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app: instance }) => instance.close()));
    const workspaceIds = fixtures.map((fixture) => fixture.workspaceId);
    await prisma.userBudget.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.providerCredential.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.auditEvent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.apiKey.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(prisma, fixture)));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("sets up two orgs, each with two workspaces and different roles", async () => {
    expect(orgAWorkspace1.organizationId).toBe(orgAWorkspace2.organizationId);
    expect(orgBWorkspace1.organizationId).toBe(orgBWorkspace2.organizationId);
    expect(orgAWorkspace1.organizationId).not.toBe(orgBWorkspace1.organizationId);

    const memberships = await prisma.membership.findMany({
      where: {
        workspaceId: {
          in: [
            orgAWorkspace1.workspaceId,
            orgAWorkspace2.workspaceId,
            orgBWorkspace1.workspaceId,
            orgBWorkspace2.workspaceId,
          ],
        },
      },
      select: { workspaceId: true, role: true },
    });
    const rolesByWorkspace = Object.fromEntries(
      memberships.map((membership) => [membership.workspaceId, membership.role]),
    );
    expect(rolesByWorkspace[orgAWorkspace1.workspaceId]).toBe("Admin");
    expect(rolesByWorkspace[orgAWorkspace2.workspaceId]).toBe("Owner");
    expect(rolesByWorkspace[orgBWorkspace1.workspaceId]).toBe("Owner");
    expect(rolesByWorkspace[orgBWorkspace2.workspaceId]).toBe("Developer");
  });

  it("gives each workspace its own distinct router-model credential", async () => {
    const credentials = await prisma.providerCredential.findMany({
      where: {
        workspaceId: {
          in: [
            orgAWorkspace1.workspaceId,
            orgAWorkspace2.workspaceId,
            orgBWorkspace1.workspaceId,
            orgBWorkspace2.workspaceId,
          ],
        },
      },
    });
    expect(credentials).toHaveLength(4);
    const providersByWorkspace: Record<string, string> = Object.fromEntries(
      credentials.map((credential): [string, string] => {
        expect(credential.workspaceId).not.toBeNull();
        return [credential.workspaceId!, credential.provider];
      }),
    );
    expect(providersByWorkspace[orgAWorkspace1.workspaceId]).toBe("openai");
    expect(providersByWorkspace[orgAWorkspace2.workspaceId]).toBe("anthropic");
    expect(providersByWorkspace[orgBWorkspace1.workspaceId]).toBe("gemini");
    expect(providersByWorkspace[orgBWorkspace2.workspaceId]).toBe("groq");
    // No two workspaces share a credential row.
    expect(new Set(credentials.map((c) => c.id)).size).toBe(4);
  });

  it("does not let workspace A1's Admin see or spend workspace B's budget", async () => {
    const budgetsBefore = await prisma.userBudget.findMany({
      where: {
        workspaceId: {
          in: [orgAWorkspace2.workspaceId, orgBWorkspace1.workspaceId, orgBWorkspace2.workspaceId],
        },
      },
    });

    // Real HTTP round trip through /v1/chat/completions, authenticated as
    // orgAWorkspace1's Admin — workspaceId for cost-guardrail purposes is
    // derived entirely from the API key at authentication time (see
    // authenticator.ts), never from a request parameter, so there is no
    // "target workspace" field to even attempt to point at workspace B.
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": orgAWorkspace1.apiKey },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        cache: { mode: "disabled" },
      },
    });
    expect(response.statusCode).toBe(200);

    const [ownBudget, ...otherBudgets] = await Promise.all([
      prisma.userBudget.findFirst({ where: { workspaceId: orgAWorkspace1.workspaceId } }),
      ...[orgAWorkspace2, orgBWorkspace1, orgBWorkspace2].map((fixture) =>
        prisma.userBudget.findFirst({ where: { workspaceId: fixture.workspaceId } }),
      ),
    ]);

    // The requesting workspace's own budget moved...
    expect(ownBudget?.currentSpendUsd).toBeGreaterThan(0);

    // ...but every other workspace's budget, including the other workspace
    // in the SAME organization, is untouched.
    for (const budget of otherBudgets) {
      const before = budgetsBefore.find((b) => b.workspaceId === budget?.workspaceId);
      expect(budget?.currentSpendUsd).toBe(before?.currentSpendUsd ?? 0);
    }
  });

  it("does not let workspace A1's Admin read workspace B's audit log", async () => {
    // Positive control: Admin does have audit.read in its own workspace.
    const ownWorkspaceRead = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${orgAWorkspace1.workspaceId}/audit-log`,
      headers: { "x-api-key": orgAWorkspace1.apiKey },
    });
    expect(ownWorkspaceRead.statusCode).toBe(200);

    for (const target of [orgAWorkspace2, orgBWorkspace1, orgBWorkspace2]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${target.workspaceId}/audit-log`,
        headers: { "x-api-key": orgAWorkspace1.apiKey },
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it("does not let workspace A1's Admin list workspace B's api keys", async () => {
    // Positive control: Admin does have apikey.read in its own workspace.
    const ownWorkspaceRead = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${orgAWorkspace1.workspaceId}/api-keys`,
      headers: { "x-api-key": orgAWorkspace1.apiKey },
    });
    expect(ownWorkspaceRead.statusCode).toBe(200);

    for (const target of [orgAWorkspace2, orgBWorkspace1, orgBWorkspace2]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${target.workspaceId}/api-keys`,
        headers: { "x-api-key": orgAWorkspace1.apiKey },
      });
      expect(response.statusCode).toBe(403);
    }
  });
});
