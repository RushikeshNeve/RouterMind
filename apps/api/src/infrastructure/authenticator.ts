import type { PrismaClient } from "@prisma/client";

import { hashApiKey } from "../security/api-key.js";

export interface AuthenticatedUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly apiKey: string;
  readonly apiKeyId?: string;
  readonly workspaceId?: string;
  readonly workspaceRole?: "owner" | "admin" | "developer" | "viewer";
  readonly organizationId?: string;
}

export interface ApiKeyAuthenticator {
  authenticate(apiKey: string): Promise<AuthenticatedUser | undefined>;
}

export class PrismaApiKeyAuthenticator implements ApiKeyAuthenticator {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly fallbackApiKey?: string,
  ) {}

  async authenticate(apiKey: string): Promise<AuthenticatedUser | undefined> {
    if (this.fallbackApiKey && apiKey === this.fallbackApiKey) {
      return {
        id: "dev-user",
        name: "Development User",
        email: "dev@routemind.local",
        apiKey,
      };
    }

    const [record] = await this.prisma.$queryRaw<
      {
        readonly userId: string;
        readonly name: string;
        readonly email: string;
        readonly apiKeyId: string;
        readonly workspaceId: string | null;
        readonly organizationId: string | null;
        readonly workspaceRole: "owner" | "admin" | "developer" | "viewer" | null;
      }[]
    >`
      SELECT
        u."id" AS "userId",
        u."name",
        u."email",
        a."id" AS "apiKeyId",
        a."workspaceId",
        w."organizationId",
        m."role" AS "workspaceRole"
      FROM "ApiKey" a
      JOIN "User" u ON u."id" = a."userId"
      LEFT JOIN "Workspace" w ON w."id" = a."workspaceId"
      LEFT JOIN "WorkspaceMember" m
        ON m."workspaceId" = a."workspaceId" AND m."userId" = a."userId"
      WHERE a."keyHash" = ${hashApiKey(apiKey)}
        AND a."isActive" = true
      LIMIT 1
    `;

    if (record) {
      return {
        id: record.userId,
        name: record.name,
        email: record.email,
        apiKey,
        apiKeyId: record.apiKeyId,
        workspaceId: record.workspaceId ?? undefined,
        workspaceRole: record.workspaceRole ?? undefined,
        organizationId: record.organizationId ?? undefined,
      };
    }

    return undefined;
  }
}

export class StaticApiKeyAuthenticator implements ApiKeyAuthenticator {
  constructor(
    private readonly apiKey: string,
    private readonly user: Omit<AuthenticatedUser, "apiKey"> = {
      id: "test-user",
      name: "Test User",
      email: "test@routemind.local",
    },
  ) {}

  authenticate(apiKey: string): Promise<AuthenticatedUser | undefined> {
    if (apiKey !== this.apiKey) {
      return Promise.resolve(undefined);
    }

    return Promise.resolve({
      ...this.user,
      apiKey,
    });
  }
}
