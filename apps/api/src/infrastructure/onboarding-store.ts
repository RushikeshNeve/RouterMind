import type { PrismaClient } from "@prisma/client";
import { modelRegistry, type ModelRegistryEntry, type ProviderId } from "@routemind/providers";

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
  createProviderCredential(input: {
    userId: string;
    provider: ProviderId;
    apiKey: string;
    encryptionKey: string;
  }): Promise<ProviderCredentialRecord>;
  updateProviderCredential(input: {
    id: string;
    isEnabled: boolean;
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

  async createUser(input: { name: string; email: string }): Promise<UserRecord> {
    return this.prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
      },
    });
  }

  async createApiKey(input: {
    userId: string;
    name: string;
    rawApiKey: string;
  }): Promise<ApiKeyRecord> {
    return this.prisma.apiKey.create({
      data: {
        userId: input.userId,
        name: input.name,
        keyHash: hashApiKey(input.rawApiKey),
      },
    });
  }

  async createProviderCredential(input: {
    userId: string;
    provider: ProviderId;
    apiKey: string;
    encryptionKey: string;
  }): Promise<ProviderCredentialRecord> {
    return this.prisma.providerCredential.upsert({
      where: {
        userId_provider: {
          userId: input.userId,
          provider: input.provider,
        },
      },
      create: {
        userId: input.userId,
        provider: input.provider,
        encryptedApiKey: encryptCredential(input.apiKey, input.encryptionKey),
        isEnabled: true,
      },
      update: {
        encryptedApiKey: encryptCredential(input.apiKey, input.encryptionKey),
        isEnabled: true,
      },
    });
  }

  async updateProviderCredential(input: {
    id: string;
    isEnabled: boolean;
  }): Promise<ProviderCredentialRecord | undefined> {
    try {
      return await this.prisma.providerCredential.update({
        where: { id: input.id },
        data: { isEnabled: input.isEnabled },
      });
    } catch {
      return undefined;
    }
  }

  async upsertModelAccess(input: {
    userId: string;
    provider: ProviderId;
    model: string;
    isEnabled: boolean;
  }): Promise<UserModelAccessRecord> {
    return this.prisma.userModelAccess.upsert({
      where: {
        userId_provider_model: {
          userId: input.userId,
          provider: input.provider,
          model: input.model,
        },
      },
      create: input,
      update: {
        isEnabled: input.isEnabled,
      },
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
  }): Promise<ProviderCredentialRecord | undefined> {
    const credential = this.providerCredentials.find((item) => item.id === input.id);
    if (!credential) {
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
