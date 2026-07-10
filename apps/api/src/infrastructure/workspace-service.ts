import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { hashApiKey } from "../security/api-key.js";

export type WorkspaceRole = "owner" | "admin" | "developer" | "viewer";
export type WorkspacePermission =
  | "manage_billing"
  | "manage_members"
  | "manage_provider_credentials"
  | "manage_api_keys"
  | "view_analytics"
  | "manage_firewall_rules"
  | "use_api_keys";

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkspaceMemberRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkspaceApiKeyRecord {
  readonly apiKey: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface WorkspaceService {
  createWorkspace(input: {
    readonly name: string;
    readonly slug?: string;
    readonly ownerUserId: string;
  }): Promise<WorkspaceRecord>;
  listWorkspaces(userId?: string): Promise<readonly WorkspaceRecord[]>;
  getWorkspace(workspaceId: string): Promise<WorkspaceRecord | undefined>;
  updateWorkspace(
    workspaceId: string,
    input: { readonly name?: string; readonly slug?: string },
  ): Promise<WorkspaceRecord | undefined>;
  addMember(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly role: WorkspaceRole;
  }): Promise<WorkspaceMemberRecord>;
  listMembers(workspaceId: string): Promise<readonly WorkspaceMemberRecord[]>;
  updateMember(memberId: string, role: WorkspaceRole): Promise<WorkspaceMemberRecord | undefined>;
  removeMember(memberId: string): Promise<boolean>;
  getMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | undefined>;
  getMemberById(memberId: string): Promise<WorkspaceMemberRecord | undefined>;
  countOwners(workspaceId: string): Promise<number>;
  createApiKey(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly name: string;
    readonly nodeEnv: "development" | "test" | "production";
  }): Promise<WorkspaceApiKeyRecord>;
}

export function hasWorkspacePermission(
  role: WorkspaceRole | undefined,
  permission: WorkspacePermission,
): boolean {
  if (!role) {
    return false;
  }
  const permissions: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
    owner: [
      "manage_billing",
      "manage_members",
      "manage_provider_credentials",
      "manage_api_keys",
      "view_analytics",
      "manage_firewall_rules",
      "use_api_keys",
    ],
    admin: [
      "manage_provider_credentials",
      "manage_api_keys",
      "view_analytics",
      "manage_firewall_rules",
      "use_api_keys",
    ],
    developer: ["use_api_keys", "view_analytics"],
    viewer: ["view_analytics"],
  };
  return permissions[role].includes(permission);
}

export class InMemoryWorkspaceService implements WorkspaceService {
  readonly workspaces: WorkspaceRecord[] = [];
  readonly members: WorkspaceMemberRecord[] = [];
  readonly apiKeys: Array<{
    readonly id: string;
    readonly keyHash: string;
    readonly userId: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly createdAt: Date;
    readonly isActive: boolean;
  }> = [];

  async createWorkspace(input: {
    readonly name: string;
    readonly slug?: string;
    readonly ownerUserId: string;
  }): Promise<WorkspaceRecord> {
    const now = new Date();
    const workspace = {
      id: `workspace_${this.workspaces.length + 1}`,
      name: input.name,
      slug: input.slug ?? slugify(input.name),
      createdAt: now,
      updatedAt: now,
    };
    this.workspaces.push(workspace);
    await this.addMember({
      workspaceId: workspace.id,
      userId: input.ownerUserId,
      role: "owner",
    });
    return workspace;
  }

  listWorkspaces(userId?: string): Promise<readonly WorkspaceRecord[]> {
    if (!userId) {
      return Promise.resolve([...this.workspaces]);
    }
    const ids = new Set(
      this.members.filter((member) => member.userId === userId).map((member) => member.workspaceId),
    );
    return Promise.resolve(this.workspaces.filter((workspace) => ids.has(workspace.id)));
  }

  getWorkspace(workspaceId: string): Promise<WorkspaceRecord | undefined> {
    return Promise.resolve(this.workspaces.find((workspace) => workspace.id === workspaceId));
  }

  updateWorkspace(
    workspaceId: string,
    input: { readonly name?: string; readonly slug?: string },
  ): Promise<WorkspaceRecord | undefined> {
    const index = this.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (index < 0) {
      return Promise.resolve(undefined);
    }
    const updated = {
      ...this.workspaces[index]!,
      ...input,
      updatedAt: new Date(),
    };
    this.workspaces[index] = updated;
    return Promise.resolve(updated);
  }

  addMember(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly role: WorkspaceRole;
  }): Promise<WorkspaceMemberRecord> {
    const existing = this.members.find(
      (member) => member.workspaceId === input.workspaceId && member.userId === input.userId,
    );
    const now = new Date();
    if (existing) {
      const updated = { ...existing, role: input.role, updatedAt: now };
      this.members.splice(this.members.indexOf(existing), 1, updated);
      return Promise.resolve(updated);
    }
    const member = {
      id: `workspace_member_${this.members.length + 1}`,
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    };
    this.members.push(member);
    return Promise.resolve(member);
  }

  listMembers(workspaceId: string): Promise<readonly WorkspaceMemberRecord[]> {
    return Promise.resolve(this.members.filter((member) => member.workspaceId === workspaceId));
  }

  updateMember(memberId: string, role: WorkspaceRole): Promise<WorkspaceMemberRecord | undefined> {
    const existing = this.members.find((member) => member.id === memberId);
    if (!existing) {
      return Promise.resolve(undefined);
    }
    const updated = { ...existing, role, updatedAt: new Date() };
    this.members.splice(this.members.indexOf(existing), 1, updated);
    return Promise.resolve(updated);
  }

  removeMember(memberId: string): Promise<boolean> {
    const index = this.members.findIndex((member) => member.id === memberId);
    if (index < 0) {
      return Promise.resolve(false);
    }
    this.members.splice(index, 1);
    return Promise.resolve(true);
  }

  getMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | undefined> {
    return Promise.resolve(
      this.members.find((member) => member.workspaceId === workspaceId && member.userId === userId),
    );
  }

  getMemberById(memberId: string): Promise<WorkspaceMemberRecord | undefined> {
    return Promise.resolve(this.members.find((member) => member.id === memberId));
  }

  countOwners(workspaceId: string): Promise<number> {
    return Promise.resolve(
      this.members.filter((member) => member.workspaceId === workspaceId && member.role === "owner")
        .length,
    );
  }

  createApiKey(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly name: string;
    readonly nodeEnv: "development" | "test" | "production";
  }): Promise<WorkspaceApiKeyRecord> {
    const apiKey = generateRouteMindApiKey(input.nodeEnv);
    const createdAt = new Date();
    this.apiKeys.push({
      id: randomUUID(),
      keyHash: hashApiKey(apiKey),
      userId: input.userId,
      workspaceId: input.workspaceId,
      name: input.name,
      createdAt,
      isActive: true,
    });
    return Promise.resolve({
      apiKey,
      workspaceId: input.workspaceId,
      name: input.name,
      createdAt,
    });
  }
}

export class PrismaWorkspaceService implements WorkspaceService {
  constructor(private readonly prisma: PrismaClient) {}

  async createWorkspace(input: {
    readonly name: string;
    readonly slug?: string;
    readonly ownerUserId: string;
  }): Promise<WorkspaceRecord> {
    const workspace = await this.insertWorkspace({
      name: input.name,
      slug: input.slug ?? slugify(input.name),
    });
    await this.addMember({ workspaceId: workspace.id, userId: input.ownerUserId, role: "owner" });
    return workspace;
  }

  async listWorkspaces(userId?: string): Promise<readonly WorkspaceRecord[]> {
    const rows = userId
      ? await this.prisma.$queryRaw<WorkspaceRecord[]>`
          SELECT w.* FROM "Workspace" w
          JOIN "WorkspaceMember" m ON m."workspaceId" = w."id"
          WHERE m."userId" = ${userId}
          ORDER BY w."createdAt" DESC
        `
      : await this.prisma.$queryRaw<WorkspaceRecord[]>`
          SELECT * FROM "Workspace"
          ORDER BY "createdAt" DESC
        `;
    return rows.map(normalizeWorkspace);
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | undefined> {
    const [row] = await this.prisma.$queryRaw<WorkspaceRecord[]>`
      SELECT * FROM "Workspace"
      WHERE "id" = ${workspaceId}
      LIMIT 1
    `;
    return row ? normalizeWorkspace(row) : undefined;
  }

  async updateWorkspace(
    workspaceId: string,
    input: { readonly name?: string; readonly slug?: string },
  ): Promise<WorkspaceRecord | undefined> {
    const existing = await this.getWorkspace(workspaceId);
    if (!existing) {
      return undefined;
    }
    const [row] = await this.prisma.$queryRaw<WorkspaceRecord[]>`
      UPDATE "Workspace"
      SET "name" = ${input.name ?? existing.name},
          "slug" = ${input.slug ?? existing.slug},
          "updatedAt" = ${new Date()}
      WHERE "id" = ${workspaceId}
      RETURNING *
    `;
    return row ? normalizeWorkspace(row) : undefined;
  }

  async addMember(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly role: WorkspaceRole;
  }): Promise<WorkspaceMemberRecord> {
    const [row] = await this.prisma.$queryRaw<WorkspaceMemberRecord[]>`
      INSERT INTO "WorkspaceMember" ("id", "workspaceId", "userId", "role", "updatedAt")
      VALUES (${randomUUID()}, ${input.workspaceId}, ${input.userId}, ${input.role}, ${new Date()})
      ON CONFLICT ("workspaceId", "userId") DO UPDATE SET
        "role" = EXCLUDED."role",
        "updatedAt" = EXCLUDED."updatedAt"
      RETURNING *
    `;
    if (!row) {
      throw new Error("Workspace member creation failed.");
    }
    return normalizeMember(row);
  }

  async listMembers(workspaceId: string): Promise<readonly WorkspaceMemberRecord[]> {
    const rows = await this.prisma.$queryRaw<WorkspaceMemberRecord[]>`
      SELECT * FROM "WorkspaceMember"
      WHERE "workspaceId" = ${workspaceId}
      ORDER BY "createdAt" ASC
    `;
    return rows.map(normalizeMember);
  }

  async updateMember(
    memberId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMemberRecord | undefined> {
    const [row] = await this.prisma.$queryRaw<WorkspaceMemberRecord[]>`
      UPDATE "WorkspaceMember"
      SET "role" = ${role}, "updatedAt" = ${new Date()}
      WHERE "id" = ${memberId}
      RETURNING *
    `;
    return row ? normalizeMember(row) : undefined;
  }

  async removeMember(memberId: string): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      DELETE FROM "WorkspaceMember"
      WHERE "id" = ${memberId}
    `;
    return Number(count) > 0;
  }

  async getMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | undefined> {
    const [row] = await this.prisma.$queryRaw<WorkspaceMemberRecord[]>`
      SELECT * FROM "WorkspaceMember"
      WHERE "workspaceId" = ${workspaceId} AND "userId" = ${userId}
      LIMIT 1
    `;
    return row ? normalizeMember(row) : undefined;
  }

  async getMemberById(memberId: string): Promise<WorkspaceMemberRecord | undefined> {
    const [row] = await this.prisma.$queryRaw<WorkspaceMemberRecord[]>`
      SELECT * FROM "WorkspaceMember"
      WHERE "id" = ${memberId}
      LIMIT 1
    `;
    return row ? normalizeMember(row) : undefined;
  }

  async countOwners(workspaceId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM "WorkspaceMember"
      WHERE "workspaceId" = ${workspaceId} AND "role" = 'owner'
    `;
    return Number(row?.count ?? 0);
  }

  async createApiKey(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly name: string;
    readonly nodeEnv: "development" | "test" | "production";
  }): Promise<WorkspaceApiKeyRecord> {
    const apiKey = generateRouteMindApiKey(input.nodeEnv);
    const createdAt = new Date();
    await this.prisma.$executeRaw`
      INSERT INTO "ApiKey" ("id", "keyHash", "userId", "workspaceId", "name", "createdAt", "isActive")
      VALUES (${randomUUID()}, ${hashApiKey(apiKey)}, ${input.userId}, ${input.workspaceId}, ${input.name}, ${createdAt}, true)
    `;
    return {
      apiKey,
      workspaceId: input.workspaceId,
      name: input.name,
      createdAt,
    };
  }

  private async insertWorkspace(input: { readonly name: string; readonly slug: string }) {
    const [row] = await this.prisma.$queryRaw<WorkspaceRecord[]>`
      INSERT INTO "Workspace" ("id", "name", "slug", "updatedAt")
      VALUES (${randomUUID()}, ${input.name}, ${input.slug}, ${new Date()})
      RETURNING *
    `;
    if (!row) {
      throw new Error("Workspace creation failed.");
    }
    return normalizeWorkspace(row);
  }
}

function normalizeWorkspace(row: WorkspaceRecord): WorkspaceRecord {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

function normalizeMember(row: WorkspaceMemberRecord): WorkspaceMemberRecord {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function generateRouteMindApiKey(nodeEnv: "development" | "test" | "production"): string {
  const prefix = nodeEnv === "production" ? "rm_live" : "rm_test";
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}
