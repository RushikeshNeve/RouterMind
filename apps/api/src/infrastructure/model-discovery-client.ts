/**
 * Calls each provider's real list-models REST endpoint using a decrypted
 * workspace credential -- native fetch, no SDK, matching this codebase's
 * existing outbound-HTTP style (packages/providers' BaseLiveProvider,
 * infrastructure/paddle-client.ts). Only used in PROVIDER_MODE=live; mock
 * mode reads the static model registry instead (see routes/models.ts) and
 * never reaches this class.
 */
export interface ModelDiscoveryClient {
  listModels(provider: string, apiKey: string): Promise<readonly string[]>;
}

export class ModelDiscoveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}

const DISCOVERY_TIMEOUT_MS = 15_000;

async function fetchJson(url: string, init: RequestInit, providerName: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const rawBody = await response.text();
    const body = rawBody.length > 0 ? (JSON.parse(rawBody) as unknown) : undefined;
    if (!response.ok) {
      throw new ModelDiscoveryError(
        `${providerName} list-models request failed with status ${response.status}.`,
        response.status,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ModelDiscoveryError(`${providerName} list-models request timed out.`, 504);
    }
    throw new ModelDiscoveryError(
      `${providerName} list-models request failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function stripGeminiModelPrefix(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

export class LiveModelDiscoveryClient implements ModelDiscoveryClient {
  async listModels(provider: string, apiKey: string): Promise<readonly string[]> {
    switch (provider) {
      case "openai":
        return this.listOpenAiCompatible("openai", "https://api.openai.com/v1/models", apiKey);
      case "groq":
        return this.listOpenAiCompatible("groq", "https://api.groq.com/openai/v1/models", apiKey);
      case "anthropic":
        return this.listAnthropic(apiKey);
      case "gemini":
        return this.listGemini(apiKey);
      default:
        throw new ModelDiscoveryError(`Unknown provider "${provider}".`, 400);
    }
  }

  private async listOpenAiCompatible(
    providerName: string,
    endpoint: string,
    apiKey: string,
  ): Promise<readonly string[]> {
    const body = await fetchJson(
      endpoint,
      { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
      providerName,
    );
    const data = (body as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data)) {
      throw new ModelDiscoveryError(`${providerName} returned no models list.`, 502);
    }
    return data
      .map((entry) => (entry as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");
  }

  private async listAnthropic(apiKey: string): Promise<readonly string[]> {
    const body = await fetchJson(
      "https://api.anthropic.com/v1/models",
      { method: "GET", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
      "anthropic",
    );
    const data = (body as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data)) {
      throw new ModelDiscoveryError("anthropic returned no models list.", 502);
    }
    return data
      .map((entry) => (entry as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");
  }

  private async listGemini(apiKey: string): Promise<readonly string[]> {
    const body = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { method: "GET" },
      "gemini",
    );
    const models = (body as { models?: unknown } | undefined)?.models;
    if (!Array.isArray(models)) {
      throw new ModelDiscoveryError("gemini returned no models list.", 502);
    }
    return models
      .map((entry) => (entry as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string")
      .map(stripGeminiModelPrefix);
  }
}
