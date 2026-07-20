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

describe("provider credential routes", () => {
  const apps: Array<{ readonly app: FastifyInstance }> = [];
  const fixturePrisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const fixtures: WorkspaceRoleFixture[] = [];
  const providerCredentialIds: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
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

  it.each(["Owner", "Admin"] as const)(
    "lists a workspace's provider credentials, without leaking encryptedApiKey, when caller has role=%s",
    async (role) => {
      const { app, fixture } = await setupForRole(role);
      const credential = await fixturePrisma.providerCredential.create({
        data: {
          userId: fixture.userId,
          workspaceId: fixture.workspaceId,
          provider: "openai",
          encryptedApiKey: encryptCredential("secret-key", testConfig.CREDENTIAL_ENCRYPTION_KEY),
          isEnabled: true,
        },
      });
      providerCredentialIds.push(credential.id);

      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/provider-credentials`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = parse<{ credentials: ReadonlyArray<Record<string, unknown>> }>(response);
      expect(body.credentials).toHaveLength(1);
      expect(body.credentials[0]).toMatchObject({ id: credential.id, provider: "openai" });
      expect(body.credentials[0]).not.toHaveProperty("encryptedApiKey");
    },
  );

  it.each(["Developer", "Viewer"] as const)(
    "rejects listing provider credentials from role=%s",
    async (role) => {
      const { app, fixture } = await setupForRole(role);

      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/provider-credentials`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(403);
    },
  );

  it("rejects cross-workspace credential listing", async () => {
    const { app, fixture: ownerInA } = await setupForRole("Owner");
    const { fixture: workspaceB } = await setupForRole("Owner");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceB.workspaceId}/provider-credentials`,
      headers: { "x-api-key": ownerInA.apiKey },
    });

    expect(response.statusCode).toBe(403);
  });

  it("excludes disabled credentials", async () => {
    const { app, fixture } = await setupForRole("Owner");
    const credential = await fixturePrisma.providerCredential.create({
      data: {
        userId: fixture.userId,
        workspaceId: fixture.workspaceId,
        provider: "anthropic",
        encryptedApiKey: encryptCredential("secret-key", testConfig.CREDENTIAL_ENCRYPTION_KEY),
        isEnabled: false,
      },
    });
    providerCredentialIds.push(credential.id);

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/provider-credentials`,
      headers: { "x-api-key": fixture.apiKey },
    });

    expect(response.statusCode).toBe(200);
    expect(parse<{ credentials: readonly unknown[] }>(response).credentials).toHaveLength(0);
  });
});
