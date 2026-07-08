import type { ChatCompletionRequest, ProviderResponse } from "@routemind/core";

import { ProviderError } from "./errors.js";
import { getModelRegistryEntry, listModelsForProvider } from "./model-registry.js";

export type ProviderId = string;

export interface ProviderCapability {
  readonly name: string;
  readonly supported: boolean;
}

export interface ProviderModel {
  readonly id: string;
  readonly capabilities: readonly ProviderCapability[];
}

export interface ProviderHealth {
  readonly providerId: ProviderId;
  readonly status: "available" | "degraded" | "unavailable";
  readonly checkedAt: Date;
}

export interface LlmProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  listModels(): Promise<readonly ProviderModel[]>;
  getHealth(): Promise<ProviderHealth>;
  execute(request: ChatCompletionRequest): Promise<ProviderResponse>;
}

export interface ProviderAdapter {
  readonly providerName: string;
  readonly supportedModels: readonly string[];
  chatCompletion(request: ChatCompletionRequest): Promise<ProviderResponse>;
  streamChatCompletion?(request: ChatCompletionRequest): AsyncIterable<ProviderStreamChunk>;
}

export interface ProviderStreamChunk {
  readonly content: string;
}

export interface ProviderFactoryOptions {
  readonly mode: "mock" | "live";
  readonly timeoutMs: number;
  readonly apiKeys: {
    readonly openai?: string | undefined;
    readonly anthropic?: string | undefined;
    readonly gemini?: string | undefined;
    readonly groq?: string | undefined;
  };
}

abstract class MockProviderAdapter implements ProviderAdapter {
  abstract readonly providerName: string;

  get supportedModels(): readonly string[] {
    return listModelsForProvider(this.providerName);
  }

  chatCompletion(request: ChatCompletionRequest): Promise<ProviderResponse> {
    const selectedModel = request.model;
    const created = Math.floor(Date.now() / 1000);

    return Promise.resolve({
      id: `chatcmpl_mock_${crypto.randomUUID()}`,
      object: "chat.completion",
      created,
      model: selectedModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: `Mock ${this.providerName} response for ${selectedModel}. RouteMind selected this provider during MVP routing.`,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: request.estimatedUsage.inputTokens,
        completion_tokens: request.estimatedUsage.outputTokens,
        total_tokens: request.estimatedUsage.inputTokens + request.estimatedUsage.outputTokens,
      },
    });
  }

  async *streamChatCompletion(request: ChatCompletionRequest): AsyncIterable<ProviderStreamChunk> {
    const response = await this.chatCompletion(request);
    const content = response.choices[0]?.message.content ?? "";

    for (const chunk of splitContent(content)) {
      yield { content: chunk };
    }
  }
}

export class OpenAIProvider extends MockProviderAdapter {
  readonly providerName = "openai";
}

export class AnthropicProvider extends MockProviderAdapter {
  readonly providerName = "anthropic";
}

export class GeminiProvider extends MockProviderAdapter {
  readonly providerName = "gemini";
}

export class GroqProvider extends MockProviderAdapter {
  readonly providerName = "groq";
}

export function createMockProviderRegistry(): Map<string, ProviderAdapter> {
  const providers: ProviderAdapter[] = [
    new OpenAIProvider(),
    new AnthropicProvider(),
    new GeminiProvider(),
    new GroqProvider(),
  ];

  return new Map(providers.map((provider) => [provider.providerName, provider]));
}

export function createProviderRegistry(
  options: ProviderFactoryOptions,
): Map<string, ProviderAdapter> {
  if (options.mode === "mock") {
    return createMockProviderRegistry();
  }

  const providers: ProviderAdapter[] = [
    new OpenAILiveProvider(options.apiKeys.openai, options.timeoutMs),
    new AnthropicLiveProvider(options.apiKeys.anthropic, options.timeoutMs),
    new GeminiLiveProvider(options.apiKeys.gemini, options.timeoutMs),
    new GroqLiveProvider(options.apiKeys.groq, options.timeoutMs),
  ];

  return new Map(providers.map((provider) => [provider.providerName, provider]));
}

abstract class BaseLiveProvider implements ProviderAdapter {
  abstract readonly providerName: string;

  constructor(
    protected readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  abstract readonly supportedModels: readonly string[];
  abstract chatCompletion(request: ChatCompletionRequest): Promise<ProviderResponse>;

  async *streamChatCompletion(request: ChatCompletionRequest): AsyncIterable<ProviderStreamChunk> {
    const response = await this.chatCompletion({ ...request, stream: false });
    const content = response.choices[0]?.message.content ?? "";

    for (const chunk of splitContent(content)) {
      yield { content: chunk };
    }
  }

  protected assertApiKey(): asserts this is this & { readonly apiKey: string } {
    if (!this.apiKey) {
      throw new ProviderError(
        "missing_api_key",
        `Missing API key for provider ${this.providerName}.`,
        500,
      );
    }
  }

  protected getModelEntry(modelId: string) {
    const entry = getModelRegistryEntry(modelId);

    if (!entry || entry.provider !== this.providerName) {
      throw new ProviderError(
        "unsupported_model",
        `Model ${modelId} is not supported by provider ${this.providerName}.`,
        400,
      );
    }

    return entry;
  }

  protected async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const rawBody = await response.text();
      const body = rawBody.length > 0 ? (JSON.parse(rawBody) as unknown) : undefined;

      if (!response.ok) {
        throw mapProviderHttpError(response.status, this.providerName, body);
      }

      return body;
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ProviderError("timeout", `${this.providerName} request timed out.`, 504);
      }

      if (error instanceof SyntaxError) {
        throw new ProviderError(
          "malformed_response",
          `${this.providerName} returned malformed JSON.`,
          502,
        );
      }

      throw new ProviderError(
        "provider_unavailable",
        `${this.providerName} provider is unavailable.`,
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

abstract class OpenAICompatibleLiveProvider extends BaseLiveProvider {
  constructor(
    readonly providerName: string,
    private readonly endpoint: string,
    apiKey: string | undefined,
    timeoutMs: number,
  ) {
    super(apiKey, timeoutMs);
  }

  get supportedModels(): readonly string[] {
    return listModelsForProvider(this.providerName);
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ProviderResponse> {
    this.assertApiKey();
    const modelEntry = this.getModelEntry(request.model);
    const response = await this.fetchJson(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelEntry.providerModelId,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        temperature: request.temperature,
        stream: false,
      }),
    });

    return normalizeOpenAICompatibleResponse(response, request.model, request.estimatedUsage);
  }
}

export class OpenAILiveProvider extends OpenAICompatibleLiveProvider {
  constructor(apiKey: string | undefined, timeoutMs: number) {
    super("openai", "https://api.openai.com/v1/chat/completions", apiKey, timeoutMs);
  }
}

export class GroqLiveProvider extends OpenAICompatibleLiveProvider {
  constructor(apiKey: string | undefined, timeoutMs: number) {
    super("groq", "https://api.groq.com/openai/v1/chat/completions", apiKey, timeoutMs);
  }
}

export class AnthropicLiveProvider extends BaseLiveProvider {
  readonly providerName = "anthropic";

  get supportedModels(): readonly string[] {
    return listModelsForProvider(this.providerName);
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ProviderResponse> {
    this.assertApiKey();
    const modelEntry = this.getModelEntry(request.model);
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));

    const response = await this.fetchJson("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        model: modelEntry.providerModelId,
        max_tokens: request.estimatedUsage.outputTokens,
        messages,
        ...(system.length > 0 ? { system } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      }),
    });

    return normalizeAnthropicResponse(response, request.model, request.estimatedUsage);
  }
}

export class GeminiLiveProvider extends BaseLiveProvider {
  readonly providerName = "gemini";

  get supportedModels(): readonly string[] {
    return listModelsForProvider(this.providerName);
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ProviderResponse> {
    this.assertApiKey();
    const modelEntry = this.getModelEntry(request.model);
    const providerModelId = await this.resolveGenerateContentModel(
      modelEntry.providerModelId,
      this.apiKey,
    );
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${providerModelId}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const contents = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));
    const systemInstruction = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");

    const response = await this.fetchJson(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: request.estimatedUsage.outputTokens,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        ...(systemInstruction.length > 0
          ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
          : {}),
      }),
    });

    return normalizeGeminiResponse(response, request.model, request.estimatedUsage);
  }

  private async resolveGenerateContentModel(
    requestedModelId: string,
    apiKey: string,
  ): Promise<string> {
    const response = await this.fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      {
        method: "GET",
      },
    );
    const generateContentModels = parseGeminiModels(response).filter((model) =>
      model.supportedGenerationMethods.includes("generateContent"),
    );
    const requestedNames = new Set([requestedModelId, `models/${requestedModelId}`]);
    const exactMatch = generateContentModels.find((model) => requestedNames.has(model.name));

    if (exactMatch) {
      return stripGeminiModelPrefix(exactMatch.name);
    }

    const requestedFamily = requestedModelId.includes("pro") ? "pro" : "flash";
    const familyMatch = generateContentModels.find((model) =>
      model.name.toLowerCase().includes(requestedFamily),
    );

    if (familyMatch) {
      return stripGeminiModelPrefix(familyMatch.name);
    }

    const availableModels = generateContentModels.map((model) => model.name).join(", ");

    throw new ProviderError(
      "unsupported_model",
      `Gemini model ${requestedModelId} is not available for generateContent. Available generateContent models: ${availableModels || "none"}.`,
      400,
    );
  }
}

interface GeminiModelMetadata {
  readonly name: string;
  readonly supportedGenerationMethods: readonly string[];
}

function parseGeminiModels(response: unknown): readonly GeminiModelMetadata[] {
  if (typeof response !== "object" || response === null) {
    throw new ProviderError("malformed_response", "Gemini ListModels returned no models.", 502);
  }

  const models = (response as { models?: unknown }).models;

  if (!Array.isArray(models)) {
    throw new ProviderError("malformed_response", "Gemini ListModels returned no models.", 502);
  }

  return models
    .map((model): GeminiModelMetadata | undefined => {
      const candidate = model as {
        name?: unknown;
        supportedGenerationMethods?: unknown;
      };

      if (typeof candidate.name !== "string") {
        return undefined;
      }

      return {
        name: candidate.name,
        supportedGenerationMethods: Array.isArray(candidate.supportedGenerationMethods)
          ? candidate.supportedGenerationMethods.filter(
              (method): method is string => typeof method === "string",
            )
          : [],
      };
    })
    .filter((model): model is GeminiModelMetadata => model !== undefined);
}

function stripGeminiModelPrefix(modelName: string): string {
  return modelName.startsWith("models/") ? modelName.slice("models/".length) : modelName;
}

function mapProviderHttpError(status: number, providerName: string, body: unknown): ProviderError {
  const providerMessage = extractProviderErrorMessage(body);

  if (status === 401 || status === 403) {
    return new ProviderError(
      "invalid_api_key",
      providerMessage ?? `Invalid API key for provider ${providerName}.`,
      502,
    );
  }

  if (
    status === 400 &&
    providerMessage &&
    /\b(api key|authentication|credential|permission_denied)\b/i.test(providerMessage)
  ) {
    return new ProviderError("invalid_api_key", providerMessage, 502);
  }

  if (status === 429) {
    return new ProviderError(
      "rate_limit",
      providerMessage ?? `${providerName} rate limit exceeded.`,
      429,
    );
  }

  if (status === 408 || status === 504) {
    return new ProviderError("timeout", `${providerName} request timed out.`, 504);
  }

  if (status >= 500) {
    return new ProviderError(
      "provider_unavailable",
      providerMessage ?? `${providerName} is unavailable.`,
      503,
    );
  }

  return new ProviderError(
    "provider_bad_request",
    providerMessage ?? `${providerName} request failed.`,
    502,
  );
}

function extractProviderErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const error = (body as { error?: unknown }).error;

  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? sanitizeProviderMessage(message) : undefined;
  }

  return undefined;
}

function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/key=([^&\s]+)/gi, "key=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

function normalizeOpenAICompatibleResponse(
  response: unknown,
  model: string,
  fallbackUsage: ChatCompletionRequest["estimatedUsage"],
): ProviderResponse {
  const value = response as {
    id?: unknown;
    created?: unknown;
    model?: unknown;
    choices?: unknown;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
    };
  };
  const choices = Array.isArray(value.choices) ? value.choices : undefined;
  const firstChoice = choices?.[0] as
    | {
        message?: { content?: unknown };
        finish_reason?: unknown;
      }
    | undefined;
  const content = firstChoice?.message?.content;

  if (typeof content !== "string") {
    throw new ProviderError("malformed_response", "Provider returned no assistant content.", 502);
  }

  const promptTokens = numberOrFallback(value.usage?.prompt_tokens, fallbackUsage.inputTokens);
  const completionTokens = numberOrFallback(
    value.usage?.completion_tokens,
    fallbackUsage.outputTokens,
  );

  return {
    id: typeof value.id === "string" ? value.id : `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: typeof value.created === "number" ? value.created : Math.floor(Date.now() / 1000),
    model: typeof value.model === "string" ? value.model : model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: normalizeFinishReason(firstChoice?.finish_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: numberOrFallback(value.usage?.total_tokens, promptTokens + completionTokens),
    },
  };
}

function normalizeAnthropicResponse(
  response: unknown,
  model: string,
  fallbackUsage: ChatCompletionRequest["estimatedUsage"],
): ProviderResponse {
  const value = response as {
    id?: unknown;
    model?: unknown;
    content?: unknown;
    stop_reason?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
    };
  };
  const blocks = Array.isArray(value.content) ? value.content : [];
  const content = blocks
    .map((block) => {
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .join("")
    .trim();

  if (content.length === 0) {
    throw new ProviderError("malformed_response", "Anthropic returned no assistant content.", 502);
  }

  const promptTokens = numberOrFallback(value.usage?.input_tokens, fallbackUsage.inputTokens);
  const completionTokens = numberOrFallback(value.usage?.output_tokens, fallbackUsage.outputTokens);

  return {
    id: typeof value.id === "string" ? value.id : `msg_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof value.model === "string" ? value.model : model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: normalizeFinishReason(value.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function normalizeGeminiResponse(
  response: unknown,
  model: string,
  fallbackUsage: ChatCompletionRequest["estimatedUsage"],
): ProviderResponse {
  const value = response as {
    candidates?: unknown;
    usageMetadata?: {
      promptTokenCount?: unknown;
      candidatesTokenCount?: unknown;
      totalTokenCount?: unknown;
    };
  };
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const firstCandidate = candidates[0] as
    | {
        content?: { parts?: unknown };
        finishReason?: unknown;
      }
    | undefined;
  const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];
  const content = parts
    .map((part) => {
      const candidate = part as { text?: unknown };
      return typeof candidate.text === "string" ? candidate.text : "";
    })
    .join("")
    .trim();

  if (content.length === 0) {
    throw new ProviderError("malformed_response", "Gemini returned no assistant content.", 502);
  }

  const promptTokens = numberOrFallback(
    value.usageMetadata?.promptTokenCount,
    fallbackUsage.inputTokens,
  );
  const completionTokens = numberOrFallback(
    value.usageMetadata?.candidatesTokenCount,
    fallbackUsage.outputTokens,
  );

  return {
    id: `gemini_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: normalizeFinishReason(firstCandidate?.finishReason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: numberOrFallback(
        value.usageMetadata?.totalTokenCount,
        promptTokens + completionTokens,
      ),
    },
  };
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeFinishReason(value: unknown): "stop" | "length" | "content_filter" {
  if (value === "length" || value === "max_tokens" || value === "MAX_TOKENS") {
    return "length";
  }

  if (value === "content_filter" || value === "SAFETY" || value === "RECITATION") {
    return "content_filter";
  }

  return "stop";
}

function splitContent(content: string): readonly string[] {
  const chunks = content.match(/.{1,12}(\s|$)|.{1,12}/g);
  return chunks?.filter((chunk) => chunk.length > 0) ?? [];
}

export { ProviderError, isProviderError } from "./errors.js";
export {
  getModelRegistryEntry,
  listModelsForProvider,
  modelRegistry,
  type ModelRegistryEntry,
} from "./model-registry.js";
