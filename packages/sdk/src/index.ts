export type ChatRole = "system" | "user" | "assistant";
export type ProviderId = "openai" | "anthropic" | "gemini" | "groq" | string;
export type RoutingMode = "rule_based" | "score_based" | "llm_assisted";
export type RoutingStrategy = "cost_optimized" | "speed_optimized" | "quality_optimized" | "balanced" | string;
export type ExecutionPlanType =
  | "auto"
  | "single_model"
  | "cheap_first"
  | "summarize_then_reason"
  | "quality_first";
export type CacheMode = "disabled" | "exact" | "semantic";

export interface RouteMindClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly headers?: HeaderMap;
  readonly fetch?: FetchLike;
  readonly requestId?: string | (() => string);
}

export interface RequestOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly headers?: HeaderMap;
  readonly requestId?: string;
}

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly stream?: boolean;
  readonly routing?: ChatRoutingOptions;
  readonly cache?: ChatCacheOptions;
}

export interface ChatCacheOptions {
  readonly mode?: CacheMode;
  readonly ttlSeconds?: number;
  readonly similarityThreshold?: number;
  readonly bypass?: boolean;
}

export interface ChatRoutingOptions {
  readonly mode?: RoutingMode;
  readonly strategy?: RoutingStrategy;
  readonly executionPlan?: ExecutionPlanType;
  readonly maxCostTier?: "low" | "medium" | "high";
  readonly maxEstimatedCostUsd?: number;
  readonly blockedProviders?: readonly string[];
  readonly blockedModels?: readonly string[];
  readonly requireHealthyProviders?: boolean;
  readonly allowUnhealthyProviders?: boolean;
}

export interface ChatCompletionResponse {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatCompletionChoice[];
  readonly usage: ChatCompletionUsage;
  readonly metadata?: ChatCompletionMetadata;
  readonly routingMetadata?: RoutingMetadata;
  readonly resilience?: ResilienceMetadata;
  readonly executionPlan?: ExecutionPlanMetadata;
}

export type ChatCompletionCreate = {
  (
    request: ChatCompletionRequest & { readonly stream: true },
    options?: RequestOptions,
  ): ChatCompletionStream;
  (
    request: ChatCompletionRequest & { readonly stream?: false | undefined },
    options?: RequestOptions,
  ): Promise<ChatCompletionResponse>;
  (
    request: ChatCompletionRequest,
    options?: RequestOptions,
  ): Promise<ChatCompletionResponse> | ChatCompletionStream;
};

export type ChatCompletionStream = AsyncIterable<ChatCompletionChunk | RouteMindStreamMetadata>;

export interface ChatCompletionChunk {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly delta: {
      readonly role?: ChatRole;
      readonly content?: string;
    };
    readonly finish_reason: "stop" | "length" | "content_filter" | null | string;
  }[];
}

export interface RouteMindStreamMetadata {
  readonly routemind: {
    readonly routing?: unknown;
    readonly resilience?: unknown;
    readonly costGuardrails?: unknown;
    readonly executionPlan?: unknown;
  };
}

export interface ChatCompletionChoice {
  readonly index: number;
  readonly message: ChatMessage;
  readonly finish_reason: "stop" | "length" | "content_filter" | string;
}

export interface ChatCompletionUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export interface ChatCompletionMetadata {
  readonly requestedModel: string;
  readonly selectedModel: string;
  readonly provider: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost?: number;
  readonly actualCostUsd?: number;
  readonly latencyMs: number;
  readonly routingReason: string;
  readonly cache?: CacheMetadata;
}

export interface CacheMetadata {
  readonly hit: boolean;
  readonly mode: CacheMode | string;
  readonly costSavedUsd?: number;
  readonly originalModel?: string;
  readonly originalProvider?: string;
  readonly semanticFallback?: boolean;
}

export interface RoutingMetadata {
  readonly idealModel?: string;
  readonly selectedModel?: string;
  readonly selectedProvider?: string;
  readonly availableModels?: readonly string[];
  readonly unavailableReason?: string;
  readonly routingStrategy?: string;
  readonly routingMode?: RoutingMode | string;
  readonly fallbackUsed?: boolean;
  readonly candidates?: readonly RoutingCandidate[];
  readonly reason?: string;
}

export interface RoutingCandidate {
  readonly provider: string;
  readonly model: string;
  readonly score?: number;
  readonly reason?: string;
}

export interface ResilienceMetadata {
  readonly attempts: readonly ProviderAttemptMetadata[];
  readonly fallbackUsed: boolean;
  readonly totalAttempts: number;
  readonly finalProvider?: string;
  readonly finalModel?: string;
}

export interface ProviderAttemptMetadata {
  readonly provider: string;
  readonly model: string;
  readonly attemptNumber: number;
  readonly status: "success" | "failed" | string;
  readonly latencyMs?: number;
  readonly errorType?: string;
  readonly errorMessage?: string;
}

export interface ExecutionPlanMetadata {
  readonly planType: ExecutionPlanType | string;
  readonly steps: readonly ExecutionPlanStep[];
  readonly estimatedCostUsd: number;
  readonly actualCostUsd?: number | null;
  readonly confidence: number;
  readonly reason: string;
  readonly executed: boolean;
}

export interface ExecutionPlanStep {
  readonly step: number;
  readonly purpose: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reason: string;
}

export interface AnalyticsFilters {
  readonly userId?: string;
  readonly from?: string | Date;
  readonly to?: string | Date;
}

export interface AnalyticsSummary {
  readonly range: {
    readonly from?: string;
    readonly to?: string;
  };
  readonly requests: {
    readonly total: number;
    readonly success: number;
    readonly failed: number;
    readonly successRate: number;
  };
  readonly cost: {
    readonly totalSpendUsd: number;
    readonly averageCostPerRequest: number;
  };
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly latency: {
    readonly averageMs: number;
    readonly p95Ms: number;
  };
  readonly routing: {
    readonly fallbackUsed: number;
    readonly llmAssisted: number;
    readonly scoreBased: number;
    readonly ruleBased: number;
  };
  readonly guardrails: {
    readonly budgetBlocked: number;
    readonly quotaBlocked: number;
  };
  readonly cache?: {
    readonly cacheHits: number;
    readonly cacheMisses: number;
    readonly estimatedCostSavedUsd: number;
    readonly cacheHitRate: number;
  };
}

export interface ProviderHealthMetric {
  readonly model: string;
  readonly status: "healthy" | "degraded" | "down" | string;
  readonly avgLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly successRate: number;
  readonly errorRate: number;
  readonly timeoutRate: number;
  readonly rateLimitRate: number;
  readonly sampleSize: number;
  readonly lastErrorCode?: string | null;
  readonly lastErrorMessage?: string | null;
  readonly lastCheckedAt: string;
  readonly updatedAt: string;
}

export interface ProviderHealthGroup {
  readonly provider: string;
  readonly models: readonly ProviderHealthMetric[];
}

export interface ProviderHealthResponse {
  readonly providers: readonly ProviderHealthGroup[];
}

export interface CircuitBreaker {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly state: "closed" | "open" | "half_open" | string;
  readonly failureCount: number;
  readonly openedAt?: string;
  readonly halfOpenAt?: string;
  readonly lastFailureAt?: string;
  readonly lastSuccessAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CircuitBreakerListResponse {
  readonly circuitBreakers: readonly CircuitBreaker[];
}

export interface CreateUserRequest {
  readonly name: string;
  readonly email: string;
}

export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly createdAt: string;
}

export interface CreateApiKeyRequest {
  readonly userId: string;
  readonly name: string;
}

export interface ApiKeyResponse {
  readonly apiKey: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface CreateProviderCredentialRequest {
  readonly userId: string;
  readonly provider: ProviderId;
  readonly apiKey: string;
}

export interface ProviderCredentialResponse {
  readonly id: string;
  readonly provider: string;
  readonly isEnabled: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface CreateModelAccessRequest {
  readonly userId: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly isEnabled?: boolean;
}

export interface ModelAccessResponse {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly isEnabled: boolean;
}

type HeaderMap = Record<string, string>;
type QueryValue = string | number | boolean | Date | undefined;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ApiErrorBody {
  readonly error?: {
    readonly message?: string;
    readonly code?: string;
    readonly type?: string;
    readonly errorType?: string;
    readonly issues?: unknown;
  };
  readonly requestId?: string;
}

interface RequestConfig {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly query?: Record<string, QueryValue>;
  readonly options?: RequestOptions;
}

export class RouteMindError extends Error {
  readonly statusCode?: number;
  readonly code: string;
  readonly requestId?: string;
  readonly responseBody?: unknown;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message);
    this.name = "RouteMindError";
    this.statusCode = options.statusCode;
    this.code = options.code ?? "routemind_error";
    this.requestId = options.requestId;
    this.responseBody = options.responseBody;
  }
}

export class AuthenticationError extends RouteMindError {
  constructor(message = "RouteMind authentication failed.", options: ErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "authentication_error" });
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends RouteMindError {
  constructor(message = "RouteMind rate limit exceeded.", options: ErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "rate_limit_error" });
    this.name = "RateLimitError";
  }
}

export class BudgetExceededError extends RouteMindError {
  constructor(message = "RouteMind budget limit exceeded.", options: ErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "budget_exceeded" });
    this.name = "BudgetExceededError";
  }
}

export class QuotaExceededError extends RouteMindError {
  constructor(message = "RouteMind quota limit exceeded.", options: ErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "quota_exceeded" });
    this.name = "QuotaExceededError";
  }
}

export class ProviderError extends RouteMindError {
  constructor(message = "RouteMind provider request failed.", options: ErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "provider_error" });
    this.name = "ProviderError";
  }
}

export class ValidationError extends RouteMindError {
  constructor(message = "RouteMind request validation failed.", options: ErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "validation_error" });
    this.name = "ValidationError";
  }
}

export class NetworkError extends RouteMindError {
  constructor(message = "RouteMind network request failed.", options: ErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "network_error" });
    this.name = "NetworkError";
  }
}

interface ErrorOptions {
  readonly statusCode?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly responseBody?: unknown;
}

export class RouteMind {
  readonly chat: {
    readonly completions: {
      readonly create: ChatCompletionCreate;
    };
  };

  readonly health: {
    readonly providers: {
      readonly list: (options?: RequestOptions) => Promise<ProviderHealthResponse>;
    };
  };

  readonly analytics: {
    readonly summary: (
      filters?: AnalyticsFilters,
      options?: RequestOptions,
    ) => Promise<AnalyticsSummary>;
  };

  readonly resilience: {
    readonly circuitBreakers: {
      readonly list: (options?: RequestOptions) => Promise<CircuitBreakerListResponse>;
    };
  };

  readonly users: {
    readonly create: (request: CreateUserRequest, options?: RequestOptions) => Promise<User>;
  };

  readonly apiKeys: {
    readonly create: (
      request: CreateApiKeyRequest,
      options?: RequestOptions,
    ) => Promise<ApiKeyResponse>;
  };

  readonly providerCredentials: {
    readonly create: (
      request: CreateProviderCredentialRequest,
      options?: RequestOptions,
    ) => Promise<ProviderCredentialResponse>;
  };

  readonly modelAccess: {
    readonly create: (
      request: CreateModelAccessRequest,
      options?: RequestOptions,
    ) => Promise<ModelAccessResponse>;
  };

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly headers: HeaderMap;
  private readonly fetchImpl: FetchLike;
  private readonly requestId?: string | (() => string);

  constructor(options: RouteMindClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://localhost:3000");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? getGlobalFetch();
    this.requestId = options.requestId;

    this.chat = {
      completions: {
        create: ((request: ChatCompletionRequest, requestOptions?: RequestOptions) => {
          if (request.stream) {
            return this.streamRequest("/v1/chat/completions", {
              method: "POST",
              body: request,
              options: requestOptions,
            });
          }

          return this.request<ChatCompletionResponse>("/v1/chat/completions", {
            method: "POST",
            body: { ...request, stream: false },
            options: requestOptions,
          });
        }) as ChatCompletionCreate,
      },
    };

    this.health = {
      providers: {
        list: (requestOptions) =>
          this.request<ProviderHealthResponse>("/v1/health/providers", {
            method: "GET",
            options: requestOptions,
          }),
      },
    };

    this.analytics = {
      summary: (filters, requestOptions) =>
        this.request<AnalyticsSummary>("/v1/analytics/summary", {
          method: "GET",
          query: serializeFilters(filters),
          options: requestOptions,
        }),
    };

    this.resilience = {
      circuitBreakers: {
        list: (requestOptions) =>
          this.request<CircuitBreakerListResponse>("/v1/resilience/circuit-breakers", {
            method: "GET",
            options: requestOptions,
          }),
      },
    };

    this.users = {
      create: (request, requestOptions) =>
        this.request<User>("/v1/users", {
          method: "POST",
          body: request,
          options: requestOptions,
        }),
    };

    this.apiKeys = {
      create: (request, requestOptions) =>
        this.request<ApiKeyResponse>("/v1/api-keys", {
          method: "POST",
          body: request,
          options: requestOptions,
        }),
    };

    this.providerCredentials = {
      create: (request, requestOptions) =>
        this.request<ProviderCredentialResponse>("/v1/provider-credentials", {
          method: "POST",
          body: request,
          options: requestOptions,
        }),
    };

    this.modelAccess = {
      create: (request, requestOptions) =>
        this.request<ModelAccessResponse>("/v1/model-access", {
          method: "POST",
          body: request,
          options: requestOptions,
        }),
    };
  }

  private async request<TResponse>(path: string, config: RequestConfig): Promise<TResponse> {
    const maxRetries = config.options?.maxRetries ?? this.maxRetries;
    let attempt = 0;

    while (true) {
      try {
        return await this.requestOnce<TResponse>(path, config);
      } catch (error) {
        if (!isRetryable(error) || attempt >= maxRetries) {
          throw error;
        }

        await sleep(100 * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  private async requestOnce<TResponse>(path: string, config: RequestConfig): Promise<TResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.options?.timeoutMs ?? this.timeoutMs);
    const url = buildUrl(this.baseUrl, path, config.query);

    try {
      const response = await this.fetchImpl(url, {
        method: config.method,
        signal: controller.signal,
        headers: this.buildHeaders(config.options),
        body: config.body === undefined ? undefined : JSON.stringify(config.body),
      });
      const responseText = await response.text();
      const responseBody = responseText ? (JSON.parse(responseText) as unknown) : undefined;

      if (!response.ok) {
        throw mapApiError(response, responseBody);
      }

      return responseBody as TResponse;
    } catch (error) {
      if (isAbortError(error)) {
        throw new NetworkError("RouteMind request timed out.", { code: "timeout" });
      }

      if (error instanceof RouteMindError) {
        throw error;
      }

      throw new NetworkError("RouteMind network request failed.", {
        responseBody: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async *streamRequest(
    path: string,
    config: RequestConfig,
  ): ChatCompletionStream {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.options?.timeoutMs ?? this.timeoutMs);
    const url = buildUrl(this.baseUrl, path, config.query);

    try {
      const response = await this.fetchImpl(url, {
        method: config.method,
        signal: controller.signal,
        headers: this.buildHeaders(config.options),
        body: config.body === undefined ? undefined : JSON.stringify(config.body),
      });

      if (!response.ok) {
        const responseText = await response.text();
        const responseBody = responseText ? (JSON.parse(responseText) as unknown) : undefined;
        throw mapApiError(response, responseBody);
      }
      if (!response.body) {
        throw new NetworkError("RouteMind streaming response had no body.");
      }

      for await (const event of readSseEvents(response.body)) {
        if (event === "[DONE]") {
          return;
        }

        yield JSON.parse(event) as ChatCompletionChunk | RouteMindStreamMetadata;
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw new NetworkError("RouteMind request timed out.", { code: "timeout" });
      }

      if (error instanceof RouteMindError) {
        throw error;
      }

      throw new NetworkError("RouteMind streaming request failed.", {
        responseBody: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildHeaders(options?: RequestOptions): HeaderMap {
    const headers: HeaderMap = {
      accept: "application/json",
      "content-type": "application/json",
      ...this.headers,
      ...options?.headers,
    };
    const requestId = options?.requestId ?? resolveRequestId(this.requestId);

    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    if (requestId) {
      headers["x-request-id"] = requestId;
    }

    return headers;
  }
}

function mapApiError(response: Response, body: unknown): RouteMindError {
  const parsed = parseApiError(body);
  const message = parsed.message ?? `RouteMind API request failed with status ${response.status}.`;
  const options: ErrorOptions = {
    statusCode: response.status,
    code: parsed.code,
    requestId: parsed.requestId,
    responseBody: body,
  };
  const code = parsed.code.toLowerCase();
  const type = parsed.type.toLowerCase();

  if (code.includes("budget") || message.toLowerCase().includes("budget")) {
    return new BudgetExceededError(message, options);
  }
  if (code.includes("quota") || message.toLowerCase().includes("quota")) {
    return new QuotaExceededError(message, options);
  }
  if (response.status === 401 || response.status === 403) {
    return new AuthenticationError(message, options);
  }
  if (response.status === 429 || code.includes("rate_limit")) {
    return new RateLimitError(message, options);
  }
  if (response.status === 400 || response.status === 422 || code.includes("validation")) {
    return new ValidationError(message, options);
  }
  if (response.status >= 500 || type.includes("provider") || code.includes("provider")) {
    return new ProviderError(message, options);
  }

  return new RouteMindError(message, options);
}

function parseApiError(body: unknown): {
  readonly message?: string;
  readonly code: string;
  readonly type: string;
  readonly requestId?: string;
} {
  if (isRecord(body)) {
    const apiError = body as ApiErrorBody;
    return {
      message: apiError.error?.message,
      code: apiError.error?.code ?? "",
      type: apiError.error?.type ?? apiError.error?.errorType ?? "",
      requestId: apiError.requestId,
    };
  }

  return { code: "", type: "" };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimitError) {
    return true;
  }
  if (error instanceof ProviderError) {
    return (error.statusCode ?? 0) >= 500;
  }
  if (error instanceof NetworkError) {
    return error.code === "timeout" || error.statusCode === undefined;
  }

  return false;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path, `${baseUrl}/`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, value instanceof Date ? value.toISOString() : String(value));
  }

  return url.toString();
}

function serializeFilters(filters?: AnalyticsFilters): Record<string, QueryValue> | undefined {
  if (!filters) {
    return undefined;
  }

  return {
    userId: filters.userId,
    from: filters.from,
    to: filters.to,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveRequestId(requestId?: string | (() => string)): string | undefined {
  if (typeof requestId === "function") {
    return requestId();
  }

  return requestId;
}

function getGlobalFetch(): FetchLike {
  if (typeof fetch === "undefined") {
    throw new NetworkError("RouteMind SDK requires a fetch implementation.");
  }

  return fetch;
}

function isAbortError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.name === "AbortError" ||
      error.code === "ABORT_ERR" ||
      error.message === "This operation was aborted")
  );
}

function isRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null;
}

async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";

      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");

        if (data.length > 0) {
          yield data;
        }
      }
    }

    const remaining = buffer.trim();
    if (remaining.length > 0) {
      const data = remaining
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");

      if (data.length > 0) {
        yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
