import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  cleanupFixture,
  seedWorkspaceWithRole,
  testConfig,
} from "../routes/workspaces-rbac-fixtures.js";
import { hashApiKey } from "../security/api-key.js";
import { PrismaApiKeyAuthenticator } from "./authenticator.js";

describe("PrismaApiKeyAuthenticator", () => {
  it("falls back to the configured development key when no database record exists", async () => {
    const prisma = {
      apiKey: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaClient;

    const authenticator = new PrismaApiKeyAuthenticator(prisma, "dev-key");

    await expect(authenticator.authenticate("dev-key")).resolves.toEqual({
      id: "dev-user",
      name: "Development User",
      email: "dev@routemind.local",
      apiKey: "dev-key",
    });
  });

  describe("against real Postgres", () => {
    const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it("populates apiKeyId and organizationId for a workspace-scoped key", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      const authenticator = new PrismaApiKeyAuthenticator(prisma);

      const user = await authenticator.authenticate(fixture.apiKey);

      expect(user?.id).toBe(fixture.userId);
      expect(user?.apiKeyId).toBe(fixture.apiKeyId);
      expect(user?.workspaceId).toBe(fixture.workspaceId);
      expect(user?.organizationId).toBe(fixture.organizationId);

      await cleanupFixture(prisma, fixture);
    });

    it("leaves organizationId undefined for a workspace with no organization", async () => {
      const user = await prisma.user.create({
        data: { name: "No Org User", email: `no-org-${Date.now()}@rbac-test.local` },
      });
      const workspace = await prisma.workspace.create({
        data: { name: "No Org Workspace", slug: `no-org-ws-${Date.now()}` },
      });
      const apiKey = "rm_test_no_org_key";
      const apiKeyRecord = await prisma.apiKey.create({
        data: {
          userId: user.id,
          workspaceId: workspace.id,
          name: "No org test key",
          keyHash: hashApiKey(apiKey),
        },
      });
      const authenticator = new PrismaApiKeyAuthenticator(prisma);

      const authenticated = await authenticator.authenticate(apiKey);

      expect(authenticated?.apiKeyId).toBe(apiKeyRecord.id);
      expect(authenticated?.workspaceId).toBe(workspace.id);
      expect(authenticated?.organizationId).toBeUndefined();

      await prisma.apiKey.deleteMany({ where: { id: apiKeyRecord.id } });
      await prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    });
  });
});
