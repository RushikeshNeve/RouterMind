import type { Prisma, PrismaClient } from "@prisma/client";
import { modelRegistry, type ModelRegistryEntry, type ProviderId } from "@routemind/providers";

import { writeAuditEvent } from "./audit.js";
import { PrismaWorkspaceService } from "./workspace-service.js";
import { hashApiKey } from "../security/api-key.js";
import { encryptCredential } from "../security/credentials.js";

export interface UserRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly createdAt: Date;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly keyHash: string;
  readonly userId: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly isActive: boolean;
}

export interface ProviderCredentialRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly encryptedApiKey: string;
  readonly isEnabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UserModelAccessRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly model: string;
  readonly isEnabled: boolean;
}

export interface AvailableModelRecord {
  readonly provider: ProviderId;
  readonly model: string;
  readonly enabled: boolean;
  readonly capabilities: readonly string[];
  readonly costTier: ModelRegistryEntry["costTier"];
  readonly latencyTier: ModelRegistryEntry["latencyTier"];
  readonly qualityTier: ModelRegistryEntry["qualityTier"];
}

export interface OnboardingStore {
  createUser(input: { name: string; email: string }): Promise<UserRecord>;
  createApiKey(input: { userId: string; name: string; rawApiKey: string }): Promise<ApiKeyRecord>;
  /** Whether userId already has at least one active API key -- used to decide whether minting another one requires proof of ownership. */
  hasActiveApiKey(userId: string): Promise<boolean>;
  createProviderCredential(input: {
    userId: string;
    provider: ProviderId;
    apiKey: string;
    encryptionKey: string;
  }): Promise<ProviderCredentialRecord>;
  updateProviderCredential(input: {
    id: string;
    isEnabled: boolean;
    callerUserId: string;
  }): Promise<ProviderCredentialRecord | undefined>;
  upsertModelAccess(input: {
    userId: string;
    provider: ProviderId;
    model: string;
    isEnabled: boolean;
  }): Promise<UserModelAccessRecord>;
  listAvailableModels(userId: string): Promise<readonly AvailableModelRecord[]>;
  findUser(userId: string): Promise<UserRecord | undefined>;
}

export class PrismaOnboardingStore implements OnboardingStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Every mutating onboarding route needs a workspaceId+principalId to
   * attach an AuditEvent to (both are required FKs on AuditEvent). createUser
   * provisions this for every new user; existing users predating this slice
   * already have one via the Phase 0 tenancy backfill.
   */
  private async resolveWorkspaceContext(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ workspaceId: string; principalId: string }> {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.principalId) {
      throw new Error(
        `User ${userId} has no principal -- cannot resolve a workspace to audit against.`,
      );
    }
    const membership = await tx.membership.findFirst({
      where: { principalId: user.principalId },
      orderBy: { createdAt: "asc" },
    });
    if (!membership) {
      throw new Error(
        `User ${userId} has no workspace membership -- cannot resolve a workspace to audit against.`,
      );
    }
    return { workspaceId: membership.workspaceId, principalId: user.principalId };
  }

  async createUser(input: { name: string; email: string }): Promise<UserRecord> {
    return this.prisma.$transaction(async (tx) => {
      const ownerRole = await tx.role.findUnique({ where: { name: "Owner" } });
      if (!ownerRole) {
        throw new Error("Owner role not seeded -- run seed-rbac.ts before allowing onboarding.");
      }

      const principal = await tx.principal.create({
        data: { type: "user", displayName: input.name },
      });
      const user = await tx.user.create({
        data: { name: input.name, email: input.email, principalId: principal.id },
      });
      const organization = await tx.organization.create({
        data: { name: `${input.name}'s Organization` },
      });
      const workspace = await tx.workspace.create({
        data: {
          name: "Default",
          slug: `personal-${user.id}`,
          organizationId: organization.id,
        },
      });
      await tx.membership.create({
        data: {
          workspaceId: workspace.id,
          principalId: principal.id,
          role: "owner",
          roleId: ownerRole.id,
        },
      });
      const workspaceMember = await new PrismaWorkspaceService(tx).addMember({
        workspaceId: workspace.id,
        userId: user.id,
        role: "owner",
      });
      await writeAuditEvent(tx, {
        workspaceId: workspace.id,
        principalId: principal.id,
        action: "member.add",
        targetType: "WorkspaceMember",
        targetId: workspaceMember.id,
        metadata: { email: input.email, role: "owner", viaOnboarding: true },
      });

      return user;
    });
  }

  async hasActiveApiKey(userId: string): Promise<boolean> {
    const count = await this.prisma.apiKey.count({ where: { userId, isActive: true } });
    return count > 0;
  }

  async createApiKey(input: {
    userId: string;
    name: string;
    rawApiKey: string;
  }): Promise<ApiKeyRecord> {
    return this.prisma.$transaction(async (tx) => {
      const context = await this.resolveWorkspaceContext(tx, input.userId);
      const record = await tx.apiKey.create({
        data: {
          userId: input.userId,
          workspaceId: context.workspaceId,
          principalId: context.principalId,
          name: input.name,
          keyHash: hashApiKey(input.rawApiKey),
        },
      });
      await writeAuditEvent(tx, {
        workspaceId: context.workspaceId,
        principalId: context.principalId,
        action: "apikey.create",
        targetType: "ApiKey",
        targetId: record.id,
        metadata: { name: input.name, viaOnboarding: true },
      });
      return record;
    });
  }

  async createProviderCredential(input: {
    userId: string;
    provider: ProviderId;
    apiKey: string;
    encryptionKey: string;
  }): Promise<ProviderCredentialRecord> {
    return this.prisma.$transaction(async (tx) => {
      const context = await this.resolveWorkspaceContext(tx, input.userId);
      const record = await tx.providerCredential.upsert({
        where: {
          userId_provider: {
            userId: input.userId,
            provider: input.provider,
          },
        },
        create: {
          userId: input.userId,
          workspaceId: context.workspaceId,
          provider: input.provider,
          encryptedApiKey: encryptCredential(input.apiKey, input.encryptionKey),
          isEnabled: true,
        },
        update: {
          encryptedApiKey: encryptCredential(input.apiKey, input.encryptionKey),
          isEnabled: true,
          workspaceId: context.workspaceId,
        },
      });
      await writeAuditEvent(tx, {
        workspaceId: context.workspaceId,
        principalId: context.principalId,
        action: "provider_credential.upsert",
        targetType: "ProviderCredential",
        targetId: record.id,
        metadata: { provider: input.provider, viaOnboarding: true },
      });
      return record;
    });
  }

  async updateProviderCredential(input: {
    id: string;
    isEnabled: boolean;
    callerUserId: string;
  }): Promise<ProviderCredentialRecord | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.providerCredential.findUnique({ where: { id: input.id } });
      if (!existing || existing.userId !== input.callerUserId) {
        return undefined;
      }

      const context = await this.resolveWorkspaceContext(tx, input.callerUserId);
      const record = await tx.providerCredential.update({
        where: { id: input.id },
        data: { isEnabled: input.isEnabled },
      });
      await writeAuditEvent(tx, {
        workspaceId: context.workspaceId,
        principalId: context.principalId,
        action: "provider_credential.update",
        targetType: "ProviderCredential",
        targetId: record.id,
        metadata: { isEnabled: input.isEnabled, viaOnboarding: true },
      });
      return record;
    });
  }

  async upsertModelAccess(input: {
    userId: string;
    provider: ProviderId;
    model: string;
    isEnabled: boolean;
  }): Promise<UserModelAccessRecord> {
    return this.prisma.$transaction(async (tx) => {
      const context = await this.resolveWorkspaceContext(tx, input.userId);
      const record = await tx.userModelAccess.upsert({
        where: {
          userId_provider_model: {
            userId: input.userId,
            provider: input.provider,
            model: input.model,
          },
        },
        create: {
          userId: input.userId,
          workspaceId: context.workspaceId,
          provider: input.provider,
          model: input.model,
          isEnabled: input.isEnabled,
        },
        update: {
          isEnabled: input.isEnabled,
          workspaceId: context.workspaceId,
        },
      });
      await writeAuditEvent(tx, {
        workspaceId: context.workspaceId,
        principalId: context.principalId,
        action: "model_access.upsert",
        targetType: "UserModelAccess",
        targetId: record.id,
        metadata: {
          provider: input.provider,
          model: input.model,
          isEnabled: input.isEnabled,
          viaOnboarding: true,
        },
      });
      return record;
    });
  }

  async listAvailableModels(userId: string): Promise<readonly AvailableModelRecord[]> {
    const [credentials, access] = await Promise.all([
      this.prisma.providerCredential.findMany({ where: { userId } }),
      this.prisma.userModelAccess.findMany({ where: { userId } }),
    ]);
    return buildAvailableModels(credentials, access);
  }

  async findUser(userId: string): Promise<UserRecord | undefined> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user ?? undefined;
  }
}

export class InMemoryOnboardingStore implements OnboardingStore {
  readonly users: UserRecord[] = [];
  readonly apiKeys: ApiKeyRecord[] = [];
  readonly providerCredentials: ProviderCredentialRecord[] = [];
  readonly modelAccess: UserModelAccessRecord[] = [];

  createUser(input: { name: string; email: string }): Promise<UserRecord> {
    const existing = this.users.find((user) => user.email === input.email);
    if (existing) {
      throw new Error("User email already exists.");
    }

    const user = {
      id: crypto.randomUUID(),
      name: input.name,
      email: input.email,
      createdAt: new Date(),
    };
    this.users.push(user);
    return Promise.resolve(user);
  }

  createApiKey(input: { userId: string; name: string; rawApiKey: string }): Promise<ApiKeyRecord> {
    const record = {
      id: crypto.randomUUID(),
      keyHash: hashApiKey(input.rawApiKey),
      userId: input.userId,
      name: input.name,
      createdAt: new Date(),
      isActive: true,
    };
    this.apiKeys.push(record);
    return Promise.resolve(record);
  }

  hasActiveApiKey(userId: string): Promise<boolean> {
    return Promise.resolve(this.apiKeys.some((key) => key.userId === userId && key.isActive));
  }

  createProviderCredential(input: {
    userId: string;
    provider: ProviderId;
    apiKey: string;
    encryptionKey: string;
  }): Promise<ProviderCredentialRecord> {
    const existingIndex = this.providerCredentials.findIndex(
      (credential) => credential.userId === input.userId && credential.provider === input.provider,
    );
    const now = new Date();
    const record = {
      id: existingIndex >= 0 ? this.providerCredentials[existingIndex]!.id : crypto.randomUUID(),
      userId: input.userId,
      provider: input.provider,
      encryptedApiKey: encryptCredential(input.apiKey, input.encryptionKey),
      isEnabled: true,
      createdAt: existingIndex >= 0 ? this.providerCredentials[existingIndex]!.createdAt : now,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      this.providerCredentials[existingIndex] = record;
    } else {
      this.providerCredentials.push(record);
    }

    return Promise.resolve(record);
  }

  updateProviderCredential(input: {
    id: string;
    isEnabled: boolean;
    callerUserId: string;
  }): Promise<ProviderCredentialRecord | undefined> {
    const credential = this.providerCredentials.find((item) => item.id === input.id);
    if (!credential || credential.userId !== input.callerUserId) {
      return Promise.resolve(undefined);
    }

    const updated = {
      ...credential,
      isEnabled: input.isEnabled,
      updatedAt: new Date(),
    };
    this.providerCredentials.splice(this.providerCredentials.indexOf(credential), 1, updated);
    return Promise.resolve(updated);
  }

  upsertModelAccess(input: {
    userId: string;
    provider: ProviderId;
    model: string;
    isEnabled: boolean;
  }): Promise<UserModelAccessRecord> {
    const existingIndex = this.modelAccess.findIndex(
      (access) =>
        access.userId === input.userId &&
        access.provider === input.provider &&
        access.model === input.model,
    );
    const record = {
      id: existingIndex >= 0 ? this.modelAccess[existingIndex]!.id : crypto.randomUUID(),
      ...input,
    };

    if (existingIndex >= 0) {
      this.modelAccess[existingIndex] = record;
    } else {
      this.modelAccess.push(record);
    }

    return Promise.resolve(record);
  }

  listAvailableModels(userId: string): Promise<readonly AvailableModelRecord[]> {
    return Promise.resolve(
      buildAvailableModels(
        this.providerCredentials.filter((credential) => credential.userId === userId),
        this.modelAccess.filter((access) => access.userId === userId),
      ),
    );
  }

  findUser(userId: string): Promise<UserRecord | undefined> {
    return Promise.resolve(this.users.find((user) => user.id === userId));
  }
}

function buildAvailableModels(
  credentials: readonly Pick<ProviderCredentialRecord, "provider" | "isEnabled">[],
  access: readonly Pick<UserModelAccessRecord, "provider" | "model" | "isEnabled">[],
): readonly AvailableModelRecord[] {
  const enabledProviders = new Set(
    credentials
      .filter((credential) => credential.isEnabled)
      .map((credential) => credential.provider),
  );

  return access
    .map((item) => {
      const entry = modelRegistry[item.model as keyof typeof modelRegistry];
      if (!entry || entry.provider !== item.provider) {
        return undefined;
      }

      return {
        provider: entry.provider,
        model: entry.modelId,
        enabled: item.isEnabled && enabledProviders.has(item.provider),
        capabilities: capabilitiesForModel(entry),
        costTier: entry.costTier,
        latencyTier: entry.latencyTier,
        qualityTier: entry.qualityTier,
      };
    })
    .filter((item): item is AvailableModelRecord => item !== undefined);
}

function capabilitiesForModel(entry: ModelRegistryEntry): readonly string[] {
  return [
    entry.supportsCode ? "code" : undefined,
    entry.supportsReasoning ? "reasoning" : undefined,
    entry.supportsSummarization ? "summarization" : undefined,
    entry.supportsFastResponse ? "fast_response" : undefined,
  ].filter((capability): capability is string => capability !== undefined);
}
