import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { encryptCredential } from "../security/credentials.js";
import {
  cleanupFixture,
  createPrismaWorkspaceTestApp,
  seedWorkspaceWithRole,
  testConfig,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

function parse<T>(response: { payload: string }): T {
  return JSON.parse(response.payload) as T;
}

describe("router config routes", () => {
  const apps: Array<{ readonly app: FastifyInstance }> = [];
  const fixturePrisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const fixtures: WorkspaceRoleFixture[] = [];
  const routerConfigIds: string[] = [];
  const providerCredentialIds: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
    await fixturePrisma.routerConfig.deleteMany({
      where: { id: { in: routerConfigIds.splice(0) } },
    });
    await fixturePrisma.providerCredential.deleteMany({
      where: { id: { in: providerCredentialIds.splice(0) } },
    });
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(fixturePrisma, fixture)));
  });

  afterAll(async () => {
    await fixturePrisma.$disconnect();
  });

  async function setupForRole(role: "Owner" | "Admin" | "Developer" | "Viewer") {
    const { app } = await createPrismaWorkspaceTestApp(fixturePrisma);
    apps.push({ app });
    const fixture = await seedWorkspaceWithRole(fixturePrisma, role);
    fixtures.push(fixture);
    return { app, fixture };
  }

  async function createCredential(workspaceId: string, userId: string, provider = "openai") {
    const credential = await fixturePrisma.providerCredential.create({
      data: {
        userId,
        workspaceId,
        provider,
        encryptedApiKey: encryptCredential("test-key", testConfig.CREDENTIAL_ENCRYPTION_KEY),
        isEnabled: true,
      },
    });
    providerCredentialIds.push(credential.id);
    return credential;
  }

  describe("workspace-scoped", () => {
    it.each(["Owner", "Admin"] as const)(
      "creates a router config when caller has role=%s",
      async (role) => {
        const { app, fixture } = await setupForRole(role);
        const credential = await createCredential(fixture.workspaceId, fixture.userId);

        const response = await app.inject({
          method: "POST",
          url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
          headers: { "x-api-key": fixture.apiKey },
          payload: { provider: "openai", model: "gpt-4o", credentialId: credential.id },
        });

        expect(response.statusCode).toBe(201);
        const body = parse<{ id: string; provider: string; model: string }>(response);
        expect(body.provider).toBe("openai");
        expect(body.model).toBe("gpt-4o");
        routerConfigIds.push(body.id);
      },
    );

    it.each(["Developer", "Viewer"] as const)(
      "rejects router config creation from role=%s",
      async (role) => {
        const { app, fixture } = await setupForRole(role);

        const response = await app.inject({
          method: "POST",
          url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
          headers: { "x-api-key": fixture.apiKey },
          payload: { provider: "openai", model: "gpt-4o" },
        });

        expect(response.statusCode).toBe(403);
      },
    );

    it("rejects cross-workspace router config creation", async () => {
      const { app, fixture: ownerInA } = await setupForRole("Owner");
      const { fixture: workspaceB } = await setupForRole("Owner");

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceB.workspaceId}/router-config`,
        headers: { "x-api-key": ownerInA.apiKey },
        payload: { provider: "openai", model: "gpt-4o" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("rejects a credentialId that doesn't exist, with a clear error", async () => {
      const { app, fixture } = await setupForRole("Owner");

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "openai", model: "gpt-4o", credentialId: "does-not-exist" },
      });

      expect(response.statusCode).toBe(400);
      expect(parse<{ error: { message: string } }>(response).error.message).toMatch(
        /does not reference an existing/i,
      );
    });

    it("rejects a credentialId that belongs to a different workspace", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const { fixture: otherWorkspace } = await setupForRole("Owner");
      const otherCredential = await createCredential(
        otherWorkspace.workspaceId,
        otherWorkspace.userId,
      );

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "openai", model: "gpt-4o", credentialId: otherCredential.id },
      });

      expect(response.statusCode).toBe(400);
      expect(parse<{ error: { message: string } }>(response).error.message).toMatch(
        /does not belong to this workspace/i,
      );
    });

    it("rejects a credentialId whose provider doesn't match the router config's provider", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const credential = await createCredential(fixture.workspaceId, fixture.userId, "anthropic");

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "openai", model: "gpt-4o", credentialId: credential.id },
      });

      expect(response.statusCode).toBe(400);
      expect(parse<{ error: { message: string } }>(response).error.message).toMatch(
        /belongs to provider "anthropic"/i,
      );
    });

    it("gets, updates, and deletes a workspace's router config when caller has role=Owner", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const credential = await createCredential(fixture.workspaceId, fixture.userId);

      const createResponse = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "openai", model: "gpt-4o", credentialId: credential.id },
      });
      const created = parse<{ id: string }>(createResponse);
      routerConfigIds.push(created.id);

      const getResponse = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
      });
      expect(getResponse.statusCode).toBe(200);
      expect(parse<{ model: string }>(getResponse).model).toBe("gpt-4o");

      const patchResponse = await app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { model: "gpt-4o-mini" },
      });
      expect(patchResponse.statusCode).toBe(200);
      const patched = parse<{ model: string; provider: string }>(patchResponse);
      expect(patched.model).toBe("gpt-4o-mini");
      expect(patched.provider).toBe("openai");

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
      });
      expect(deleteResponse.statusCode).toBe(200);

      const afterDelete = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
      });
      expect(afterDelete.statusCode).toBe(404);
    });

    it("rejects creating a second router config for the same workspace", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const first = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "openai", model: "gpt-4o" },
      });
      routerConfigIds.push(parse<{ id: string }>(first).id);

      const second = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "openai", model: "gpt-4o-mini" },
      });
      expect(second.statusCode).toBe(409);
    });
  });

  describe("org-scoped", () => {
    it.each(["Owner", "Admin"] as const)(
      "creates an org router config when caller has role=%s",
      async (role) => {
        const { app, fixture } = await setupForRole(role);
        const credential = await createCredential(fixture.workspaceId, fixture.userId);

        const response = await app.inject({
          method: "POST",
          url: `/v1/organizations/${fixture.organizationId}/router-config`,
          headers: { "x-api-key": fixture.apiKey },
          payload: { provider: "openai", model: "gpt-4o", credentialId: credential.id },
        });

        expect(response.statusCode).toBe(201);
        routerConfigIds.push(parse<{ id: string }>(response).id);
      },
    );

    it.each(["Developer", "Viewer"] as const)(
      "rejects org router config creation from role=%s",
      async (role) => {
        const { app, fixture } = await setupForRole(role);

        const response = await app.inject({
          method: "POST",
          url: `/v1/organizations/${fixture.organizationId}/router-config`,
          headers: { "x-api-key": fixture.apiKey },
          payload: { provider: "openai", model: "gpt-4o" },
        });

        expect(response.statusCode).toBe(403);
      },
    );

    it("rejects a credentialId whose workspace belongs to a different organization", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const { fixture: otherOrgWorkspace } = await setupForRole("Owner");
      const otherCredential = await createCredential(
        otherOrgWorkspace.workspaceId,
        otherOrgWorkspace.userId,
      );

      const response = await app.inject({
        method: "POST",
        url: `/v1/organizations/${fixture.organizationId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "openai", model: "gpt-4o", credentialId: otherCredential.id },
      });

      expect(response.statusCode).toBe(400);
      expect(parse<{ error: { message: string } }>(response).error.message).toMatch(
        /does not belong to a workspace in this organization/i,
      );
    });

    it("gets, updates, and deletes an organization's router config", async () => {
      const { app, fixture } = await setupForRole("Owner");

      const createResponse = await app.inject({
        method: "POST",
        url: `/v1/organizations/${fixture.organizationId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "openai", model: "gpt-4o" },
      });
      const created = parse<{ id: string }>(createResponse);
      routerConfigIds.push(created.id);

      const getResponse = await app.inject({
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
      });
      expect(getResponse.statusCode).toBe(200);

      const patchResponse = await app.inject({
        method: "PATCH",
        url: `/v1/organizations/${fixture.organizationId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { model: "gpt-4o-mini" },
      });
      expect(patchResponse.statusCode).toBe(200);
      expect(parse<{ model: string }>(patchResponse).model).toBe("gpt-4o-mini");

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/v1/organizations/${fixture.organizationId}/router-config`,
        headers: { "x-api-key": fixture.apiKey },
      });
      expect(deleteResponse.statusCode).toBe(200);
    });
  });

  it("router config create/update/delete all show up correctly in the audit log", async () => {
    const { app, fixture } = await setupForRole("Owner");

    const createResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { provider: "openai", model: "gpt-4o" },
    });
    const created = parse<{ id: string }>(createResponse);
    routerConfigIds.push(created.id);

    await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { model: "gpt-4o-mini" },
    });

    await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${fixture.workspaceId}/router-config`,
      headers: { "x-api-key": fixture.apiKey },
    });

    const auditResponse = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/audit-log`,
      headers: { "x-api-key": fixture.apiKey },
    });
    const body = parse<{
      events: Array<{
        action: string;
        targetType: string;
        targetId: string;
        principalId: string;
      }>;
    }>(auditResponse);

    const createEvent = body.events.find(
      (event) => event.action === "router_config.create" && event.targetId === created.id,
    );
    const updateEvent = body.events.find(
      (event) => event.action === "router_config.update" && event.targetId === created.id,
    );
    const deleteEvent = body.events.find(
      (event) => event.action === "router_config.delete" && event.targetId === created.id,
    );

    expect(createEvent).toBeDefined();
    expect(updateEvent).toBeDefined();
    expect(deleteEvent).toBeDefined();
    expect(createEvent?.targetType).toBe("RouterConfig");
    expect(createEvent?.principalId).toBe(fixture.principalId);
  });
});
