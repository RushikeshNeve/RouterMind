import type { ChatCompletionRequest } from "@routemind/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GeminiLiveProvider,
  OpenAILiveProvider,
  createProviderRegistry,
  getModelRegistryEntry,
  isProviderError,
} from "./index.js";

const request: ChatCompletionRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
  stream: false,
  estimatedUsage: {
    inputTokens: 2,
    outputTokens: 300,
  },
};

const geminiRequest: ChatCompletionRequest = {
  ...request,
  model: "gemini-1.5-flash",
};

describe("provider factory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns mock providers in mock mode", () => {
    const registry = createProviderRegistry({
      mode: "mock",
      timeoutMs: 30_000,
      apiKeys: {},
    });

    expect(registry.get("openai")?.providerName).toBe("openai");
    expect(registry.get("anthropic")?.supportedModels).toContain("claude-3-5-sonnet");
  });

  it("mock providers stream small content chunks", async () => {
    const registry = createProviderRegistry({
      mode: "mock",
      timeoutMs: 30_000,
      apiKeys: {},
    });
    const provider = registry.get("openai");

    if (!provider?.streamChatCompletion) {
      throw new Error("Expected mock provider to support streaming.");
    }

    const chunks: string[] = [];
    for await (const chunk of provider.streamChatCompletion(request)) {
      chunks.push(chunk.content);
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("Mock openai response");
  });

  it("returns live providers in live mode", () => {
    const registry = createProviderRegistry({
      mode: "live",
      timeoutMs: 30_000,
      apiKeys: {
        openai: "test-openai-key",
        anthropic: "test-anthropic-key",
        gemini: "test-gemini-key",
        groq: "test-groq-key",
      },
    });

    expect(registry.get("openai")).toBeInstanceOf(OpenAILiveProvider);
  });

  it("fails cleanly when a live provider API key is missing", async () => {
    const registry = createProviderRegistry({
      mode: "live",
      timeoutMs: 30_000,
      apiKeys: {},
    });

    await expect(registry.get("openai")?.chatCompletion(request)).rejects.toMatchObject({
      code: "missing_api_key",
    });
  });

  it("looks up registered models", () => {
    expect(getModelRegistryEntry("gpt-4o-mini")).toMatchObject({
      provider: "openai",
      providerModelId: "gpt-4o-mini",
    });
    expect(getModelRegistryEntry("not-real")).toBeUndefined();
  });

  it("normalizes OpenAI-compatible live responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl_test",
              object: "chat.completion",
              created: 123,
              model: "gpt-4o",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Hello from OpenAI" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
              },
            }),
            { status: 200 },
          ),
        );
      }),
    );

    const provider = new OpenAILiveProvider("test-key", 30_000);
    const response = await provider.chatCompletion(request);

    expect(response).toMatchObject({
      id: "chatcmpl_test",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello from OpenAI",
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    });
  });

  it("maps provider rate limits to clean provider errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
          }),
        );
      }),
    );

    const provider = new OpenAILiveProvider("test-key", 30_000);

    try {
      await provider.chatCompletion(request);
      throw new Error("Expected provider to throw");
    } catch (error) {
      expect(isProviderError(error)).toBe(true);
      expect(error).toMatchObject({
        code: "rate_limit",
        statusCode: 429,
      });
    }
  });

  it("calls Gemini ListModels before generateContent and uses an exact generateContent model", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-1.5-flash",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "Hello from Gemini" }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 5,
              candidatesTokenCount: 7,
              totalTokenCount: 12,
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiLiveProvider("test-key", 30_000);
    const response = await provider.chatCompletion(geminiRequest);
    const [, generateContentUrl] = fetchMock.mock.calls.map((call) => call[0] as string);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(generateContentUrl).toContain("/models/gemini-1.5-flash:generateContent");
    expect(response.choices[0]?.message.content).toBe("Hello from Gemini");
  });

  it("falls back to an available Gemini family model from ListModels", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-2.0-flash",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "Hello from fallback Gemini" }],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiLiveProvider("test-key", 30_000);
    await provider.chatCompletion(geminiRequest);
    const [, generateContentUrl] = fetchMock.mock.calls.map((call) => call[0] as string);

    expect(generateContentUrl).toContain("/models/gemini-2.0-flash:generateContent");
  });
});
