import type { ApiConfig } from "../config.js";

export interface PaddleTransaction {
  readonly id: string;
  readonly status: string;
}

export interface PaddleClient {
  createTransaction(input: {
    readonly priceId: string;
    readonly customData: Record<string, string>;
  }): Promise<PaddleTransaction>;
}

export class PaddleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PaddleApiError";
  }
}

const PADDLE_TIMEOUT_MS = 15_000;

function paddleApiBaseUrl(environment: ApiConfig["PADDLE_ENVIRONMENT"]): string {
  // Deliberately derived from config, never hardcoded to one environment --
  // sandbox and production are entirely separate Paddle accounts/data sets.
  return environment === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
}

/**
 * Real Paddle Billing REST API client (native fetch, matching this
 * codebase's existing packages/providers style -- no SDK dependency).
 * Only implements what checkout needs: creating a transaction that the
 * frontend's Paddle.js overlay opens by id (Phase 1 item 5, not this
 * slice). Paddle is the merchant of record, so nothing here calculates
 * tax or generates invoices -- Paddle owns both at checkout time and via
 * its own hosted receipts.
 */
export class LivePaddleClient implements PaddleClient {
  constructor(private readonly config: ApiConfig) {}

  async createTransaction(input: {
    readonly priceId: string;
    readonly customData: Record<string, string>;
  }): Promise<PaddleTransaction> {
    if (!this.config.PADDLE_API_KEY) {
      throw new PaddleApiError("Paddle is not configured (missing PADDLE_API_KEY).", 503);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PADDLE_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${paddleApiBaseUrl(this.config.PADDLE_ENVIRONMENT)}/transactions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.PADDLE_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            items: [{ price_id: input.priceId, quantity: 1 }],
            custom_data: input.customData,
          }),
          signal: controller.signal,
        },
      );
      const rawBody = await response.text();
      const body = rawBody.length > 0 ? (JSON.parse(rawBody) as unknown) : undefined;

      if (!response.ok) {
        const message =
          body &&
          typeof body === "object" &&
          "error" in body &&
          body.error &&
          typeof body.error === "object" &&
          "detail" in body.error &&
          typeof body.error.detail === "string"
            ? body.error.detail
            : `Paddle transaction creation failed with status ${response.status}.`;
        throw new PaddleApiError(message, response.status);
      }

      const data =
        body && typeof body === "object" && "data" in body
          ? (body as { data: { id: string; status: string } }).data
          : undefined;
      if (!data?.id) {
        throw new PaddleApiError("Paddle response was missing a transaction id.", 502);
      }
      return { id: data.id, status: data.status };
    } catch (error) {
      if (error instanceof PaddleApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new PaddleApiError("Paddle transaction request timed out.", 504);
      }
      throw new PaddleApiError(
        `Paddle transaction request failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
