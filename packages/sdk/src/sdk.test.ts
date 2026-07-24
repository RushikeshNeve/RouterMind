import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationError,
  BudgetExceededError,
  NetworkError,
  RateLimitError,
  RouteMind,
} from "./index.js";

describe("RouteMind SDK", () => {
  it("performs a successful chat completion", async () => {
    const fetchMock = mockFetch(chatCompletionBody());
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
    const [url, init] = firstFetchCall(fetchMock);

    expect(url).toBe("http://localhost:3000/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(readHeader(init, "x-api-key")).toBe("dev-key");
    expect(readJsonBody(init.body)).toMatchObject({ model: "auto", stream: false });
    expect(response.choices[0]?.message.content).toBe("Hello");
  });

  it("maps authentication errors", async () => {
    const fetchMock = mockFetch({ error: { message: "Invalid API key." } }, 401);
    const client = new RouteMind({ apiKey: "bad-key", fetch: fetchMock, maxRetries: 0 });

    await expect(
      client.chat.completions.create({
        model: "auto",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("maps rate limit errors", async () => {
    const fetchMock = mockFetch({ error: { message: "Too many requests." } }, 429);
    const client = new RouteMind({ apiKey: "dev-key", fetch: fetchMock, maxRetries: 0 });

    await expect(client.analytics.summary("workspace-1")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("maps budget exceeded errors", async () => {
    const fetchMock = mockFetch(
      { error: { message: "Monthly budget exceeded.", code: "BUDGET_EXCEEDED" } },
      403,
    );
    const client = new RouteMind({ apiKey: "dev-key", fetch: fetchMock, maxRetries: 0 });

    await expect(
      client.chat.completions.create({
        model: "auto",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("times out requests", async () => {
    const fetchMock = vi.fn(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortError()));
        }),
    );
    const client = new RouteMind({
      apiKey: "dev-key",
      timeoutMs: 1,
      maxRetries: 0,
      fetch: fetchMock,
    });

    await expect(client.analytics.summary("workspace-1")).rejects.toBeInstanceOf(NetworkError);
  });

  it("supports custom baseUrl", async () => {
    const fetchMock = mockFetch(chatCompletionBody());
    const client = new RouteMind({
      apiKey: "dev-key",
      baseUrl: "https://gateway.example.com/",
      fetch: fetchMock,
    });

    await client.chat.completions.create({
      model: "auto",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(firstFetchCall(fetchMock)[0]).toBe("https://gateway.example.com/v1/chat/completions");
  });

  it("sends custom headers", async () => {
    const fetchMock = mockFetch({ requests: { total: 0 } });
    const client = new RouteMind({
      apiKey: "dev-key",
      fetch: fetchMock,
      headers: { "x-workspace-id": "workspace-1" },
    });

    await client.analytics.summary("workspace-1");

    expect(readHeader(firstFetchCall(fetchMock)[1], "x-workspace-id")).toBe("workspace-1");
  });

  it("sends request id header", async () => {
    const fetchMock = mockFetch({ requests: { total: 0 } });
    const client = new RouteMind({
      apiKey: "dev-key",
      fetch: fetchMock,
      requestId: () => "req_sdk_123",
    });

    await client.analytics.summary("workspace-1");

    expect(readHeader(firstFetchCall(fetchMock)[1], "x-request-id")).toBe("req_sdk_123");
  });

  it("calls analytics summary with filters", async () => {
    const body = analyticsSummaryBody();
    const fetchMock = mockFetch(body);
    const client = new RouteMind({ apiKey: "dev-key", fetch: fetchMock });

    const response = await client.analytics.summary("workspace-1", {
      userId: "user-1",
      from: new Date("2026-07-07T00:00:00.000Z"),
      to: "2026-07-07T23:59:59.999Z",
    });

    expect(firstFetchCall(fetchMock)[0]).toContain(
      "/v1/workspaces/workspace-1/analytics/summary?userId=user-1&from=2026-07-07T00%3A00%3A00.000Z&to=2026-07-07T23%3A59%3A59.999Z",
    );
    expect(response.requests.total).toBe(100);
  });

  it("calls provider health", async () => {
    const body = {
      providers: [
        {
          provider: "openai",
          models: [
            {
              model: "gpt-4o",
              status: "healthy",
              avgLatencyMs: 100,
              p95LatencyMs: 180,
              successRate: 1,
              errorRate: 0,
              timeoutRate: 0,
              rateLimitRate: 0,
              sampleSize: 10,
              lastCheckedAt: "2026-07-07T00:00:00.000Z",
              updatedAt: "2026-07-07T00:00:00.000Z",
            },
          ],
        },
      ],
    };
    const fetchMock = mockFetch(body);
    const client = new RouteMind({ apiKey: "dev-key", fetch: fetchMock });

    const response = await client.health.providers.list();

    expect(firstFetchCall(fetchMock)[0]).toBe("http://localhost:3000/v1/health/providers");
    expect(response.providers[0]?.models[0]?.status).toBe("healthy");
  });

  it("returns an async iterable for streaming chat completions", async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(
        new Response(sseBody(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    });
    const client = new RouteMind({ apiKey: "dev-key", fetch: fetchMock });
    const stream = client.chat.completions.create({
      model: "auto",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const chunks: unknown[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(readJsonBody(firstFetchCall(fetchMock)[1].body)).toMatchObject({ stream: true });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        object: "chat.completion.chunk",
        choices: [
          expect.objectContaining({
            delta: { content: "Hello" },
          }),
        ],
      }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({ routemind: expect.any(Object) as unknown as object }),
    );
  });
});

function mockFetch(body: unknown, status = 200) {
  return vi.fn((input: string, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

function readJsonBody(body: unknown): unknown {
  if (typeof body === "string") {
    return JSON.parse(body);
  }

  return JSON.parse(JSON.stringify(body));
}

function sseBody(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          [
            'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":123,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
            'data: {"routemind":{"routing":{},"resilience":{},"costGuardrails":{},"executionPlan":{}}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        ),
      );
      controller.close();
    },
  });
}

function firstFetchCall(fetchMock: ReturnType<typeof mockFetch>): [string, RequestInit] {
  const call = fetchMock.mock.calls[0];

  if (!call) {
    throw new Error("Expected SDK to call fetch.");
  }

  return call as [string, RequestInit];
}

function readHeader(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string>;
  return headers[name];
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function chatCompletionBody() {
  return {
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
      routingStrategy: "balanced",
      fallbackUsed: false,
    },
  };
}

function analyticsSummaryBody() {
  return {
    range: {
      from: "2026-07-07T00:00:00.000Z",
      to: "2026-07-07T23:59:59.999Z",
    },
    requests: {
      total: 100,
      success: 95,
      failed: 5,
      successRate: 0.95,
    },
    cost: {
      totalSpendUsd: 1.25,
      averageCostPerRequest: 0.0125,
    },
    tokens: {
      input: 1000,
      output: 500,
      total: 1500,
    },
    latency: {
      averageMs: 100,
      p95Ms: 200,
    },
    routing: {
      fallbackUsed: 3,
      llmAssisted: 70,
      scoreBased: 20,
      ruleBased: 10,
    },
    guardrails: {
      budgetBlocked: 1,
      quotaBlocked: 2,
    },
  };
}
