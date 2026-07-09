import { isProviderError } from "@routemind/providers";

export type ProviderErrorType =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "NETWORK_ERROR"
  | "BAD_REQUEST"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";

export class ProviderErrorClassifier {
  classify(error: unknown): ProviderErrorType {
    if (isProviderError(error)) {
      switch (error.code) {
        case "invalid_api_key":
        case "missing_api_key":
          return "AUTH_ERROR";
        case "rate_limit":
          return "RATE_LIMIT";
        case "timeout":
          return "TIMEOUT";
        case "provider_bad_request":
        case "unsupported_model":
        case "malformed_response":
          return "BAD_REQUEST";
        case "provider_unavailable":
          return error.statusCode >= 500 ? "SERVER_ERROR" : "PROVIDER_UNAVAILABLE";
        default:
          return "UNKNOWN";
      }
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      return "TIMEOUT";
    }

    if (error instanceof TypeError) {
      return "NETWORK_ERROR";
    }

    if (typeof error === "object" && error !== null) {
      const statusCode = (error as { statusCode?: unknown; status?: unknown }).statusCode;
      const status =
        typeof statusCode === "number" ? statusCode : (error as { status?: unknown }).status;

      if (status === 401 || status === 403) return "AUTH_ERROR";
      if (status === 429) return "RATE_LIMIT";
      if (status === 408 || status === 504) return "TIMEOUT";
      if (status === 400) return "BAD_REQUEST";
      if (typeof status === "number" && status >= 500) return "SERVER_ERROR";
    }

    return "UNKNOWN";
  }

  isTransient(errorType: ProviderErrorType): boolean {
    return (
      errorType === "TIMEOUT" ||
      errorType === "RATE_LIMIT" ||
      errorType === "SERVER_ERROR" ||
      errorType === "NETWORK_ERROR" ||
      errorType === "PROVIDER_UNAVAILABLE"
    );
  }
}
