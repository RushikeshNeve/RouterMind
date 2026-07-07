export type GatewayRequestId = string;
export type OrganizationId = string;
export type ProjectId = string;

export interface GatewayRequestContext {
  readonly requestId: GatewayRequestId;
  readonly organizationId?: OrganizationId;
  readonly projectId?: ProjectId;
  readonly receivedAt: Date;
}

export interface AiGatewayRequest {
  readonly model?: string;
  readonly provider?: string;
  readonly payload: unknown;
}

export interface AiGatewayResponse {
  readonly provider: string;
  readonly model: string;
  readonly payload: unknown;
  readonly usage?: TokenUsage;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface GatewayError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly stream?: false;
  readonly estimatedUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface ProviderResponse {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ProviderChoice[];
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

export interface ProviderChoice {
  readonly index: number;
  readonly message: ChatMessage;
  readonly finish_reason: "stop" | "length" | "content_filter";
}
