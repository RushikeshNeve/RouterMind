import type { ChatMessage, ProviderResponse } from "@routemind/core";

export interface RouteMindOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: typeof fetch;
}

export interface ChatCompletionCreateParams {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly stream?: false;
}

export interface RouteMindRoutingMetadata {
  readonly idealModel: string;
  readonly selectedModel?: string;
  readonly selectedProvider?: string;
  readonly availableModels: readonly string[];
  readonly unavailableReason?: string;
  readonly routingStrategy: string;
  readonly fallbackUsed: boolean;
}

export interface RouteMindChatCompletion extends ProviderResponse {
  readonly metadata: {
    readonly requestedModel: string;
    readonly selectedModel: string;
    readonly provider: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCost: number;
    readonly latencyMs: number;
    readonly routingReason: string;
  };
  readonly routingMetadata: RouteMindRoutingMetadata;
}

export class RouteMindError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly code = "routemind_error",
  ) {
    super(message);
    this.name = "RouteMindError";
  }
}

export class RouteMindTimeoutError extends RouteMindError {
  constructor(message = "RouteMind request timed out.") {
    super(message, 408, "timeout");
    this.name = "RouteMindTimeoutError";
  }
}

export class RouteMindAPIError extends RouteMindError {
  constructor(
    message: string,
    readonly responseBody: unknown,
    statusCode: number,
  ) {
    super(message, statusCode, "api_error");
    this.name = "RouteMindAPIError";
  }
}

export class RouteMind {
  readonly chat: {
    readonly completions: {
      readonly create: (params: ChatCompletionCreateParams) => Promise<RouteMindChatCompletion>;
    };
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RouteMindOptions) {
    if (!options.apiKey) {
      throw new RouteMindError("RouteMind SDK requires an apiKey.", undefined, "missing_api_key");
    }

    if (!options.baseUrl) {
      throw new RouteMindError("RouteMind SDK requires a baseUrl.", undefined, "missing_base_url");
    }

    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? fetch;
    this.chat = {
      completions: {
        create: (params) => this.createChatCompletion(params),
      },
    };
  }

  private async createChatCompletion(
    params: ChatCompletionCreateParams,
  ): Promise<RouteMindChatCompletion> {
    return this.request<RouteMindChatCompletion>("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        ...params,
        stream: params.stream ?? false,
      }),
    });
  }

  private async request<TResponse>(path: string, init: RequestInit): Promise<TResponse> {
    let attempt = 0;

    while (true) {
      try {
        return await this.requestOnce<TResponse>(path, init);
      } catch (error) {
        if (!shouldRetry(error) || attempt >= this.maxRetries) {
          throw error;
        }

        await sleep(100 * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  private async requestOnce<TResponse>(path: string, init: RequestInit): Promise<TResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          ...init.headers,
        },
      });
      const rawBody = await response.text();
      const body = rawBody.length > 0 ? (JSON.parse(rawBody) as unknown) : undefined;

      if (!response.ok) {
        throw new RouteMindAPIError(extractErrorMessage(body), body, response.status);
      }

      return body as TResponse;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new RouteMindTimeoutError();
      }

      if (error instanceof RouteMindError) {
        throw error;
      }

      throw new RouteMindError("RouteMind request failed.", undefined, "network_error");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof RouteMindTimeoutError) {
    return true;
  }

  if (error instanceof RouteMindAPIError) {
    return error.statusCode === 429 || (error.statusCode ?? 0) >= 500;
  }

  return false;
}

function extractErrorMessage(body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") {
      return error.message;
    }
  }

  return "RouteMind API request failed.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { ChatMessage };
