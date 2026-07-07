export type ProviderErrorCode =
  | "missing_api_key"
  | "invalid_api_key"
  | "timeout"
  | "rate_limit"
  | "provider_bad_request"
  | "provider_unavailable"
  | "malformed_response"
  | "unsupported_model";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}
