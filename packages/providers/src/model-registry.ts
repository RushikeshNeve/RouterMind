import type { ProviderId } from "./index.js";

export interface ModelRegistryEntry {
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly providerModelId: string;
  readonly supportsCode: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsSummarization: boolean;
  readonly supportsFastResponse: boolean;
  readonly costTier: "low" | "medium" | "high";
  readonly latencyTier: "low" | "medium" | "high";
  readonly qualityTier: "standard" | "strong" | "premium";
}

type ModelRegistrySeed = Omit<ModelRegistryEntry, "modelId" | "providerModelId"> & {
  readonly providerModelId?: string;
};

function model(modelId: string, seed: ModelRegistrySeed): ModelRegistryEntry {
  return {
    modelId,
    providerModelId: seed.providerModelId ?? modelId,
    provider: seed.provider,
    supportsCode: seed.supportsCode,
    supportsReasoning: seed.supportsReasoning,
    supportsSummarization: seed.supportsSummarization,
    supportsFastResponse: seed.supportsFastResponse,
    costTier: seed.costTier,
    latencyTier: seed.latencyTier,
    qualityTier: seed.qualityTier,
  };
}

const openAiStandard: ModelRegistrySeed = {
  provider: "openai",
  supportsCode: true,
  supportsReasoning: true,
  supportsSummarization: true,
  supportsFastResponse: false,
  costTier: "high",
  latencyTier: "medium",
  qualityTier: "premium",
};

const openAiMini: ModelRegistrySeed = {
  provider: "openai",
  supportsCode: true,
  supportsReasoning: true,
  supportsSummarization: true,
  supportsFastResponse: true,
  costTier: "low",
  latencyTier: "low",
  qualityTier: "strong",
};

const openAiNano: ModelRegistrySeed = {
  provider: "openai",
  supportsCode: true,
  supportsReasoning: false,
  supportsSummarization: true,
  supportsFastResponse: true,
  costTier: "low",
  latencyTier: "low",
  qualityTier: "standard",
};

const openAiReasoning: ModelRegistrySeed = {
  provider: "openai",
  supportsCode: true,
  supportsReasoning: true,
  supportsSummarization: true,
  supportsFastResponse: false,
  costTier: "high",
  latencyTier: "high",
  qualityTier: "premium",
};

const openAiSearch: ModelRegistrySeed = {
  provider: "openai",
  supportsCode: false,
  supportsReasoning: true,
  supportsSummarization: true,
  supportsFastResponse: false,
  costTier: "medium",
  latencyTier: "medium",
  qualityTier: "strong",
};

export const modelRegistry = {
  "claude-3-5-sonnet": {
    modelId: "claude-3-5-sonnet",
    provider: "anthropic",
    providerModelId: "claude-3-5-sonnet-latest",
    supportsCode: true,
    supportsReasoning: true,
    supportsSummarization: true,
    supportsFastResponse: false,
    costTier: "high",
    latencyTier: "medium",
    qualityTier: "premium",
  },
  "chat-latest": model("chat-latest", openAiMini),
  "gpt-3.5-turbo": model("gpt-3.5-turbo", openAiMini),
  "gpt-3.5-turbo-0125": model("gpt-3.5-turbo-0125", openAiMini),
  "gpt-3.5-turbo-1106": model("gpt-3.5-turbo-1106", openAiMini),
  "gpt-3.5-turbo-16k": model("gpt-3.5-turbo-16k", openAiMini),
  "gpt-4": model("gpt-4", openAiStandard),
  "gpt-4-0613": model("gpt-4-0613", openAiStandard),
  "gpt-4-turbo": model("gpt-4-turbo", openAiStandard),
  "gpt-4-turbo-2024-04-09": model("gpt-4-turbo-2024-04-09", openAiStandard),
  "gpt-4.1": model("gpt-4.1", openAiStandard),
  "gpt-4.1-2025-04-14": model("gpt-4.1-2025-04-14", openAiStandard),
  "gpt-4.1-mini": model("gpt-4.1-mini", openAiMini),
  "gpt-4.1-mini-2025-04-14": model("gpt-4.1-mini-2025-04-14", openAiMini),
  "gpt-4.1-nano": model("gpt-4.1-nano", openAiNano),
  "gpt-4.1-nano-2025-04-14": model("gpt-4.1-nano-2025-04-14", openAiNano),
  "gpt-4o": model("gpt-4o", openAiStandard),
  "gpt-4o-2024-05-13": model("gpt-4o-2024-05-13", openAiStandard),
  "gpt-4o-2024-08-06": model("gpt-4o-2024-08-06", openAiStandard),
  "gpt-4o-2024-11-20": model("gpt-4o-2024-11-20", openAiStandard),
  "gpt-4o-mini": model("gpt-4o-mini", openAiNano),
  "gpt-4o-mini-2024-07-18": model("gpt-4o-mini-2024-07-18", openAiNano),
  "gpt-4o-mini-search-preview": model("gpt-4o-mini-search-preview", openAiSearch),
  "gpt-4o-mini-search-preview-2025-03-11": model(
    "gpt-4o-mini-search-preview-2025-03-11",
    openAiSearch,
  ),
  "gpt-4o-search-preview": model("gpt-4o-search-preview", openAiSearch),
  "gpt-4o-search-preview-2025-03-11": model("gpt-4o-search-preview-2025-03-11", openAiSearch),
  "gpt-5": model("gpt-5", openAiStandard),
  "gpt-5-2025-08-07": model("gpt-5-2025-08-07", openAiStandard),
  "gpt-5-chat-latest": model("gpt-5-chat-latest", openAiStandard),
  "gpt-5-codex": model("gpt-5-codex", openAiReasoning),
  "gpt-5-mini": model("gpt-5-mini", openAiMini),
  "gpt-5-mini-2025-08-07": model("gpt-5-mini-2025-08-07", openAiMini),
  "gpt-5-nano": model("gpt-5-nano", openAiNano),
  "gpt-5-nano-2025-08-07": model("gpt-5-nano-2025-08-07", openAiNano),
  "gpt-5-pro": model("gpt-5-pro", openAiReasoning),
  "gpt-5-pro-2025-10-06": model("gpt-5-pro-2025-10-06", openAiReasoning),
  "gpt-5-search-api": model("gpt-5-search-api", openAiSearch),
  "gpt-5-search-api-2025-10-14": model("gpt-5-search-api-2025-10-14", openAiSearch),
  "gpt-5.1": model("gpt-5.1", openAiStandard),
  "gpt-5.1-2025-11-13": model("gpt-5.1-2025-11-13", openAiStandard),
  "gpt-5.1-chat-latest": model("gpt-5.1-chat-latest", openAiStandard),
  "gpt-5.1-codex": model("gpt-5.1-codex", openAiReasoning),
  "gpt-5.1-codex-max": model("gpt-5.1-codex-max", openAiReasoning),
  "gpt-5.1-codex-mini": model("gpt-5.1-codex-mini", openAiMini),
  "gpt-5.2": model("gpt-5.2", openAiStandard),
  "gpt-5.2-2025-12-11": model("gpt-5.2-2025-12-11", openAiStandard),
  "gpt-5.2-chat-latest": model("gpt-5.2-chat-latest", openAiStandard),
  "gpt-5.2-codex": model("gpt-5.2-codex", openAiReasoning),
  "gpt-5.2-pro": model("gpt-5.2-pro", openAiReasoning),
  "gpt-5.2-pro-2025-12-11": model("gpt-5.2-pro-2025-12-11", openAiReasoning),
  "gpt-5.3-chat-latest": model("gpt-5.3-chat-latest", openAiStandard),
  "gpt-5.3-codex": model("gpt-5.3-codex", openAiReasoning),
  "gpt-5.4": model("gpt-5.4", openAiStandard),
  "gpt-5.4-2026-03-05": model("gpt-5.4-2026-03-05", openAiStandard),
  "gpt-5.4-mini": model("gpt-5.4-mini", openAiMini),
  "gpt-5.4-mini-2026-03-17": model("gpt-5.4-mini-2026-03-17", openAiMini),
  "gpt-5.4-nano": model("gpt-5.4-nano", openAiNano),
  "gpt-5.4-nano-2026-03-17": model("gpt-5.4-nano-2026-03-17", openAiNano),
  "gpt-5.4-pro": model("gpt-5.4-pro", openAiReasoning),
  "gpt-5.4-pro-2026-03-05": model("gpt-5.4-pro-2026-03-05", openAiReasoning),
  "gpt-5.5": model("gpt-5.5", openAiStandard),
  "gpt-5.5-2026-04-23": model("gpt-5.5-2026-04-23", openAiStandard),
  "gpt-5.5-pro": model("gpt-5.5-pro", openAiReasoning),
  "gpt-5.5-pro-2026-04-23": model("gpt-5.5-pro-2026-04-23", openAiReasoning),
  o1: model("o1", openAiReasoning),
  "o1-2024-12-17": model("o1-2024-12-17", openAiReasoning),
  "o1-pro": model("o1-pro", openAiReasoning),
  "o1-pro-2025-03-19": model("o1-pro-2025-03-19", openAiReasoning),
  o3: model("o3", openAiReasoning),
  "o3-2025-04-16": model("o3-2025-04-16", openAiReasoning),
  "o3-mini": model("o3-mini", openAiMini),
  "o3-mini-2025-01-31": model("o3-mini-2025-01-31", openAiMini),
  "o4-mini": model("o4-mini", openAiMini),
  "o4-mini-2025-04-16": model("o4-mini-2025-04-16", openAiMini),
  "gemini-1.5-flash": {
    modelId: "gemini-1.5-flash",
    provider: "gemini",
    providerModelId: "gemini-1.5-flash",
    supportsCode: true,
    supportsReasoning: false,
    supportsSummarization: true,
    supportsFastResponse: true,
    costTier: "low",
    latencyTier: "low",
    qualityTier: "standard",
  },
  "gemini-1.5-pro": {
    modelId: "gemini-1.5-pro",
    provider: "gemini",
    providerModelId: "gemini-1.5-pro",
    supportsCode: true,
    supportsReasoning: true,
    supportsSummarization: true,
    supportsFastResponse: false,
    costTier: "medium",
    latencyTier: "medium",
    qualityTier: "strong",
  },
  "llama-3.1-70b-versatile": {
    modelId: "llama-3.1-70b-versatile",
    provider: "groq",
    providerModelId: "llama-3.1-70b-versatile",
    supportsCode: true,
    supportsReasoning: true,
    supportsSummarization: true,
    supportsFastResponse: true,
    costTier: "low",
    latencyTier: "low",
    qualityTier: "strong",
  },
} as const satisfies Record<string, ModelRegistryEntry>;

export type RegisteredModelId = keyof typeof modelRegistry;

export function getModelRegistryEntry(modelId: string): ModelRegistryEntry | undefined {
  return modelRegistry[modelId as RegisteredModelId];
}

export function listModelsForProvider(provider: ProviderId): readonly string[] {
  return Object.values(modelRegistry)
    .filter((entry) => entry.provider === provider)
    .map((entry) => entry.modelId);
}
