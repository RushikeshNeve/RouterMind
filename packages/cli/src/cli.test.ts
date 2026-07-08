import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BASE_URL, loadConfig, maskApiKey, saveConfig } from "./config.js";
import { createProgram, type OutputWriter, type RouteMindClient } from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("RouteMind CLI config", () => {
  it("loads default config when no config file exists", async () => {
    const dir = await makeTempDir();
    const config = await loadConfig(join(dir, ".routemind", "config.json"));

    expect(config).toEqual({ baseUrl: DEFAULT_BASE_URL });
  });

  it("saves and loads config", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, ".routemind", "config.json");

    await saveConfig({ apiKey: "rm_test_123456789", baseUrl: "http://localhost:4000" }, configPath);

    await expect(readFile(configPath, "utf8")).resolves.toContain("rm_test_123456789");
    await expect(loadConfig(configPath)).resolves.toEqual({
      apiKey: "rm_test_123456789",
      baseUrl: "http://localhost:4000",
    });
  });

  it("masks API keys", () => {
    expect(maskApiKey("rm_test_abcdefghijklmnopqrstuvwxyz")).toBe("rm_test...wxyz");
    expect(maskApiKey()).toBe("not set");
  });
});

describe("RouteMind CLI commands", () => {
  it("prints chat command JSON output", async () => {
    const dir = await makeTempDir();
    const output = createOutput();
    const client = createMockClient();
    const program = createProgram({
      stdout: output,
      configPath: await writeTempConfig(dir),
      createClient: () => client,
      spinner: createSilentSpinner,
    });

    await program.parseAsync(["node", "routemind", "--json", "chat", "debug this code"], {
      from: "node",
    });

    const body = JSON.parse(output.value) as { readonly choices: readonly unknown[] };

    expect(body.choices).toHaveLength(1);
    expect(client.chat.completions.create).toHaveBeenCalledWith({
      model: "auto",
      messages: [{ role: "user", content: "debug this code" }],
      stream: false,
      routing: {
        strategy: "balanced",
        mode: undefined,
        maxCostTier: undefined,
        maxEstimatedCostUsd: undefined,
      },
    });
  });

  it("prints health command output", async () => {
    const dir = await makeTempDir();
    const output = createOutput();
    const program = createProgram({
      stdout: output,
      configPath: await writeTempConfig(dir),
      createClient: createMockClient,
      spinner: createSilentSpinner,
    });

    await program.parseAsync(["node", "routemind", "health"], { from: "node" });

    expect(output.value).toContain("Provider Health");
    expect(output.value).toContain("openai");
    expect(output.value).toContain("gpt-4o");
    expect(output.value).toContain("healthy");
  });

  it("prints streaming chat output", async () => {
    const dir = await makeTempDir();
    const output = createOutput();
    const client = createMockClient();
    const program = createProgram({
      stdout: output,
      configPath: await writeTempConfig(dir),
      createClient: () => client,
      spinner: createSilentSpinner,
    });

    await program.parseAsync(["node", "routemind", "chat", "debug this code", "--stream"], {
      from: "node",
    });

    expect(output.value).toContain("Answer:");
    expect(output.value).toContain("Streaming works");
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true }),
    );
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "routemind-cli-"));
  tempDirs.push(dir);
  return dir;
}

async function writeTempConfig(dir: string): Promise<string> {
  const configPath = join(dir, ".routemind", "config.json");
  await saveConfig({ apiKey: "rm_test_123456789", baseUrl: "http://localhost:3000" }, configPath);
  return configPath;
}

function createOutput(): OutputWriter & { value: string } {
  return {
    value: "",
    write(chunk: string) {
      this.value += chunk;
    },
  };
}

function createSilentSpinner() {
  return {
    start() {
      return this;
    },
    succeed() {
      return this;
    },
    fail() {
      return this;
    },
  };
}

function createMockClient(): RouteMindClient {
  const completion = {
    id: "chatcmpl_cli_test",
    object: "chat.completion" as const,
    created: 123,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: "Use a narrower type." },
        finish_reason: "stop" as const,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 6,
      total_tokens: 16,
    },
    metadata: {
      requestedModel: "auto",
      selectedModel: "gpt-4o",
      provider: "openai",
      inputTokens: 10,
      outputTokens: 6,
      actualCostUsd: 0.0021,
      latencyMs: 1320,
      routingReason: "quality fit",
    },
  };

  return {
    chat: {
      completions: {
        create: vi.fn((request: { readonly stream?: boolean }) => {
          if (request.stream) {
            return createMockStream();
          }

          return Promise.resolve(completion);
        }) as RouteMindClient["chat"]["completions"]["create"],
      },
    },
    health: {
      providers: {
        list: vi.fn(async () => ({
          providers: [
            {
              provider: "openai",
              models: [
                {
                  model: "gpt-4o",
                  status: "healthy",
                  avgLatencyMs: 1320,
                  p95LatencyMs: 1900,
                  successRate: 0.99,
                  errorRate: 0.01,
                  timeoutRate: 0,
                  rateLimitRate: 0,
                  sampleSize: 100,
                  lastCheckedAt: "2026-07-07T00:00:00.000Z",
                  updatedAt: "2026-07-07T00:00:00.000Z",
                },
              ],
            },
          ],
        })),
      },
    },
    analytics: {
      summary: vi.fn(async () => ({
        range: {},
        requests: { total: 10, success: 9, failed: 1, successRate: 0.9 },
        cost: { totalSpendUsd: 1.23, averageCostPerRequest: 0.123 },
        tokens: { input: 100, output: 50, total: 150 },
        latency: { averageMs: 1000, p95Ms: 1800 },
        routing: { fallbackUsed: 1, llmAssisted: 8, scoreBased: 1, ruleBased: 1 },
        guardrails: { budgetBlocked: 0, quotaBlocked: 0 },
      })),
    },
    resilience: {
      circuitBreakers: {
        list: vi.fn(async () => ({ circuitBreakers: [] })),
      },
    },
  };
}

async function* createMockStream() {
  yield {
    id: "chatcmpl_cli_stream",
    object: "chat.completion.chunk" as const,
    created: 123,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: { content: "Streaming " },
        finish_reason: null,
      },
    ],
  };
  yield {
    id: "chatcmpl_cli_stream",
    object: "chat.completion.chunk" as const,
    created: 123,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: { content: "works" },
        finish_reason: null,
      },
    ],
  };
}
