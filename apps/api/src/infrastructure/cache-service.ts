import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type CacheMode = "disabled" | "exact" | "semantic";

export interface CacheRequestOptions {
  readonly mode?: CacheMode;
  readonly ttlSeconds?: number;
  readonly similarityThreshold?: number;
  readonly bypass?: boolean;
}

export interface CacheKeyInput {
  readonly userId: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly requestedModel: string;
  readonly routingStrategy: string;
  readonly temperature?: number;
}

export interface LLMResponseCacheEntry {
  readonly id: string;
  readonly userId: string;
  readonly cacheKey: string;
  readonly normalizedPromptHash: string;
  readonly promptText: string;
  readonly responseJson: unknown;
  readonly model: string;
  readonly provider: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costSavedUsd: number;
  readonly hitCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CacheStats {
  readonly totalEntries: number;
  readonly totalHits: number;
  readonly estimatedCostSavedUsd: number;
  readonly topModelsCached: readonly {
    readonly model: string;
    readonly provider: string;
    readonly entries: number;
    readonly hits: number;
    readonly estimatedCostSavedUsd: number;
  }[];
}

export interface EmbeddingProvider {
  embed(input: string): Promise<readonly number[]>;
}

export interface SimilaritySearchProvider {
  findSimilar(input: {
    readonly userId: string;
    readonly embedding: readonly number[];
    readonly threshold: number;
  }): Promise<LLMResponseCacheEntry | undefined>;
}

export interface CacheService {
  buildCacheKey(input: CacheKeyInput): {
    readonly cacheKey: string;
    readonly normalizedPromptHash: string;
    readonly promptText: string;
  };
  getExactCache(cacheKey: string): Promise<LLMResponseCacheEntry | undefined>;
  setExactCache(input: {
    readonly userId: string;
    readonly cacheKey: string;
    readonly normalizedPromptHash: string;
    readonly promptText: string;
    readonly responseJson: unknown;
    readonly model: string;
    readonly provider: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd: number;
    readonly ttlSeconds: number;
  }): Promise<LLMResponseCacheEntry>;
  recordCacheHit(cacheKey: string, estimatedCostSavedUsd: number): Promise<void>;
  invalidateUserCache(userId?: string): Promise<number>;
  entries(userId?: string): Promise<readonly LLMResponseCacheEntry[]>;
  stats(userId?: string): Promise<CacheStats>;
}

export class InMemoryCacheService implements CacheService {
  private readonly items = new Map<string, LLMResponseCacheEntry>();

  buildCacheKey(input: CacheKeyInput) {
    return buildCacheKey(input);
  }

  getExactCache(cacheKey: string): Promise<LLMResponseCacheEntry | undefined> {
    const entry = this.items.get(cacheKey);
    if (!entry) {
      return Promise.resolve(undefined);
    }

    if (entry.expiresAt.getTime() <= Date.now()) {
      this.items.delete(cacheKey);
      return Promise.resolve(undefined);
    }

    return Promise.resolve(entry);
  }

  setExactCache(input: {
    readonly userId: string;
    readonly cacheKey: string;
    readonly normalizedPromptHash: string;
    readonly promptText: string;
    readonly responseJson: unknown;
    readonly model: string;
    readonly provider: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd: number;
    readonly ttlSeconds: number;
  }): Promise<LLMResponseCacheEntry> {
    const now = new Date();
    const entry: LLMResponseCacheEntry = {
      id: this.items.get(input.cacheKey)?.id ?? `cache_${this.items.size + 1}`,
      userId: input.userId,
      cacheKey: input.cacheKey,
      normalizedPromptHash: input.normalizedPromptHash,
      promptText: input.promptText,
      responseJson: input.responseJson,
      model: input.model,
      provider: input.provider,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costSavedUsd: this.items.get(input.cacheKey)?.costSavedUsd ?? 0,
      hitCount: this.items.get(input.cacheKey)?.hitCount ?? 0,
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
      createdAt: this.items.get(input.cacheKey)?.createdAt ?? now,
      updatedAt: now,
    };

    this.items.set(input.cacheKey, entry);
    return Promise.resolve(entry);
  }

  recordCacheHit(cacheKey: string, estimatedCostSavedUsd: number): Promise<void> {
    const entry = this.items.get(cacheKey);
    if (!entry) {
      return;
    }

    this.items.set(cacheKey, {
      ...entry,
      hitCount: entry.hitCount + 1,
      costSavedUsd: Number((entry.costSavedUsd + estimatedCostSavedUsd).toFixed(6)),
      updatedAt: new Date(),
    });

    return Promise.resolve();
  }

  invalidateUserCache(userId?: string): Promise<number> {
    const entries = [...this.items.values()].filter((entry) => !userId || entry.userId === userId);
    for (const entry of entries) {
      this.items.delete(entry.cacheKey);
    }

    return Promise.resolve(entries.length);
  }

  entries(userId?: string): Promise<readonly LLMResponseCacheEntry[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter((entry) => entry.expiresAt.getTime() > Date.now())
        .filter((entry) => !userId || entry.userId === userId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    );
  }

  async stats(userId?: string): Promise<CacheStats> {
    return buildStats(await this.entries(userId));
  }
}

export class PrismaCacheService implements CacheService {
  constructor(private readonly prisma: PrismaClient) {}

  buildCacheKey(input: CacheKeyInput) {
    return buildCacheKey(input);
  }

  async getExactCache(cacheKey: string): Promise<LLMResponseCacheEntry | undefined> {
    const [entry] = await this.prisma.$queryRaw<LLMResponseCacheEntry[]>`
      SELECT * FROM "LLMResponseCache"
      WHERE "cacheKey" = ${cacheKey} AND "expiresAt" > ${new Date()}
      LIMIT 1
    `;

    return entry ? normalizeCacheRow(entry) : undefined;
  }

  async setExactCache(input: {
    readonly userId: string;
    readonly cacheKey: string;
    readonly normalizedPromptHash: string;
    readonly promptText: string;
    readonly responseJson: unknown;
    readonly model: string;
    readonly provider: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd: number;
    readonly ttlSeconds: number;
  }): Promise<LLMResponseCacheEntry> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);

    await this.prisma.$executeRaw`
      INSERT INTO "LLMResponseCache" (
        "id",
        "userId",
        "cacheKey",
        "normalizedPromptHash",
        "promptText",
        "responseJson",
        "model",
        "provider",
        "inputTokens",
        "outputTokens",
        "expiresAt",
        "updatedAt"
      )
      VALUES (
        ${randomUUID()},
        ${input.userId},
        ${input.cacheKey},
        ${input.normalizedPromptHash},
        ${input.promptText},
        ${JSON.stringify(input.responseJson)}::jsonb,
        ${input.model},
        ${input.provider},
        ${input.inputTokens},
        ${input.outputTokens},
        ${expiresAt},
        ${now}
      )
      ON CONFLICT ("cacheKey") DO UPDATE SET
        "responseJson" = EXCLUDED."responseJson",
        "model" = EXCLUDED."model",
        "provider" = EXCLUDED."provider",
        "inputTokens" = EXCLUDED."inputTokens",
        "outputTokens" = EXCLUDED."outputTokens",
        "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = EXCLUDED."updatedAt"
    `;

    const entry = await this.getExactCache(input.cacheKey);
    if (!entry) {
      throw new Error("Cache write failed.");
    }

    return entry;
  }

  async recordCacheHit(cacheKey: string, estimatedCostSavedUsd: number): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "LLMResponseCache"
      SET
        "hitCount" = "hitCount" + 1,
        "costSavedUsd" = "costSavedUsd" + ${estimatedCostSavedUsd},
        "updatedAt" = ${new Date()}
      WHERE "cacheKey" = ${cacheKey}
    `;
  }

  async invalidateUserCache(userId?: string): Promise<number> {
    const result = userId
      ? await this.prisma.$executeRaw`
          DELETE FROM "LLMResponseCache"
          WHERE "userId" = ${userId}
        `
      : await this.prisma.$executeRaw`
          DELETE FROM "LLMResponseCache"
        `;

    return Number(result);
  }

  async entries(userId?: string): Promise<readonly LLMResponseCacheEntry[]> {
    const rows = userId
      ? await this.prisma.$queryRaw<LLMResponseCacheEntry[]>`
          SELECT * FROM "LLMResponseCache"
          WHERE "userId" = ${userId} AND "expiresAt" > ${new Date()}
          ORDER BY "updatedAt" DESC
        `
      : await this.prisma.$queryRaw<LLMResponseCacheEntry[]>`
          SELECT * FROM "LLMResponseCache"
          WHERE "expiresAt" > ${new Date()}
          ORDER BY "updatedAt" DESC
        `;

    return rows.map(normalizeCacheRow);
  }

  async stats(userId?: string): Promise<CacheStats> {
    return buildStats(await this.entries(userId));
  }
}

function buildCacheKey(input: CacheKeyInput): {
  readonly cacheKey: string;
  readonly normalizedPromptHash: string;
  readonly promptText: string;
} {
  const promptText = normalizeMessages(input.messages);
  const normalizedPromptHash = hash(promptText);
  const cacheKey = hash(
    JSON.stringify({
      userId: input.userId,
      normalizedPromptHash,
      requestedModel: input.requestedModel,
      routingStrategy: input.routingStrategy,
      temperature: input.temperature ?? 0,
    }),
  );

  return {
    cacheKey,
    normalizedPromptHash,
    promptText,
  };
}

function normalizeMessages(
  messages: readonly { readonly role: string; readonly content: string }[],
): string {
  return messages
    .map((message) => `${message.role}:${normalizePrompt(message.content)}`)
    .join("\n");
}

function normalizePrompt(prompt: string): string {
  return prompt
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) =>
      index % 2 === 1 ? part.trim() : part.trim().replace(/\s+/g, " ").toLowerCase(),
    )
    .join("\n");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildStats(entries: readonly LLMResponseCacheEntry[]): CacheStats {
  const grouped = new Map<
    string,
    {
      readonly model: string;
      readonly provider: string;
      readonly entries: number;
      readonly hits: number;
      readonly estimatedCostSavedUsd: number;
    }
  >();

  for (const entry of entries) {
    const key = `${entry.provider}:${entry.model}`;
    const existing = grouped.get(key);
    grouped.set(key, {
      model: entry.model,
      provider: entry.provider,
      entries: (existing?.entries ?? 0) + 1,
      hits: (existing?.hits ?? 0) + entry.hitCount,
      estimatedCostSavedUsd: Number(
        ((existing?.estimatedCostSavedUsd ?? 0) + entry.costSavedUsd).toFixed(6),
      ),
    });
  }

  return {
    totalEntries: entries.length,
    totalHits: entries.reduce((total, entry) => total + entry.hitCount, 0),
    estimatedCostSavedUsd: Number(
      entries.reduce((total, entry) => total + entry.costSavedUsd, 0).toFixed(6),
    ),
    topModelsCached: [...grouped.values()]
      .sort((a, b) => b.hits - a.hits || b.entries - a.entries)
      .slice(0, 5),
  };
}

function normalizeCacheRow(row: LLMResponseCacheEntry): LLMResponseCacheEntry {
  return {
    ...row,
    expiresAt: new Date(row.expiresAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}
