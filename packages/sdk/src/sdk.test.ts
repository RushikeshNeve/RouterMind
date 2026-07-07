import { describe, expect, it, vi } from "vitest";

import { RouteMind } from "./index.js";

describe("RouteMind SDK", () => {
  it("initializes with apiKey and baseUrl", () => {
    const client = new RouteMind({
      apiKey: "dev-key",
      baseUrl: "http://localhost:3000",
    });

    expect(client.chat.completions.create).toBeTypeOf("function");
  });

  it("calls chat completions using the OpenAI-compatible method style", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl_test",
            object: "chat.completion",
            created: 123,
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Hello" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
            metadata: {
              requestedModel: "auto",
              selectedModel: "gpt-4o",
              provider: "openai",
              inputTokens: 1,
              outputTokens: 1,
              estimatedCost: 0.001,
              latencyMs: 10,
              routingReason: "matched architecture/reasoning prompt",
            },
            routingMetadata: {
              idealModel: "gpt-4o",
              selectedModel: "gpt-4o",
              selectedProvider: "openai",
              availableModels: ["gpt-4o"],
              routingStrategy: "reasoning-preference",
              fallbackUsed: false,
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const client = new RouteMind({
      apiKey: "dev-key",
      baseUrl: "http://localhost:3000",
      fetch: fetchMock,
    });

    const response = await client.chat.completions.create({
      model: "auto",
      messages: [{ role: "user", content: "Help me debug this code" }],
      temperature: 0.7,
    });

    const firstCall = fetchMock.mock.calls[0];

    if (!firstCall) {
      throw new Error("Expected SDK to call fetch.");
    }

    const [url, init] = firstCall as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(url).toBe("http://localhost:3000/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(headers["x-api-key"]).toBe("dev-key");
    expect(response.choices[0]?.message.content).toBe("Hello");
  });
});
