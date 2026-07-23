import { afterEach, describe, expect, it } from "vitest";
import type { ProviderResponse } from "@routemind/core";
import type { RouterLLMRequest, RouterLLMService } from "@routemind/routing";

import { buildApp } from "../app.js";
import type { ApiConfig } from "../config.js";
import {
  InMemoryEvaluationService,
  type EvaluationModelRunner,
} from "../infrastructure/evaluation-service.js";

const testConfig: ApiConfig = {
  DATABASE_URL: "postgresql://routemind:routemind@localhost:5432/routemind?schema=public",
  DEV_API_KEY: "dev-key",
  CREDENTIAL_ENCRYPTION_KEY: "development-credential-key-change-me",
  SESSION_SECRET: "development-session-secret-change-me",
  LOG_LEVEL: "silent",
  NODE_ENV: "test",
  PORT: 3000,
  PADDLE_ENVIRONMENT: "sandbox",
  PROVIDER_MODE: "mock",
  PROVIDER_TIMEOUT_MS: 30_000,
  ROUTER_LLM_ENABLED: true,
  ROUTER_LLM_MAX_TOKENS: 300,
  ROUTER_LLM_MODEL: "gpt-4o-mini",
  REDIS_URL: "redis://localhost:6379",
};

function parseResponse<TResponse>(response: { payload: string }): TResponse {
  return JSON.parse(response.payload) as TResponse;
}

class StaticEvaluationRunner implements EvaluationModelRunner {
  constructor(private readonly output: string) {}

  run(input: { readonly model: string }): Promise<ProviderResponse> {
    return Promise.resolve({
      id: "eval_test",
      object: "chat.completion",
      created: 123,
      model: input.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: this.output },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });
  }
}

describe("evaluation routes", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("creates datasets and adds evaluation cases", async () => {
    const app = await buildApp({ config: testConfig });
    apps.push(app);

    const datasetResponse = await app.inject({
      method: "POST",
      url: "/v1/evaluations/datasets",
      payload: {
        name: "JSON extraction",
        description: "Extract structured data",
        taskType: "extraction",
      },
    });
    const dataset = parseResponse<{ readonly id: string; readonly taskType: string }>(
      datasetResponse,
    );
    const caseResponse = await app.inject({
      method: "POST",
      url: `/v1/evaluations/datasets/${dataset.id}/cases`,
      payload: {
        inputMessagesJson: [{ role: "user", content: "Return ok" }],
        expectedOutput: "ok",
        gradingRubric: "contains",
      },
    });

    expect(datasetResponse.statusCode).toBe(201);
    expect(dataset.taskType).toBe("extraction");
    expect(caseResponse.statusCode).toBe(201);
    expect(parseResponse<{ readonly expectedOutput: string }>(caseResponse).expectedOutput).toBe(
      "ok",
    );
  });

  it("scores exact_match runs", async () => {
    const evaluationService = new InMemoryEvaluationService(new StaticEvaluationRunner("Hello"));
    const app = await buildApp({ config: testConfig, evaluationService });
    apps.push(app);
    const dataset = await evaluationService.createDataset({
      name: "Exact",
      taskType: "simple_chat",
    });
    await evaluationService.addCase({
      datasetId: dataset.id,
      inputMessagesJson: [{ role: "user", content: "Say Hello" }],
      expectedOutput: "Hello",
      gradingRubric: "exact_match",
    });
    const run = await evaluationService.createRun({
      datasetId: dataset.id,
      provider: "openai",
      model: "gpt-4o",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/evaluations/runs/${run.id}/start`,
    });
    const body = parseResponse<{
      readonly run: {
        readonly status: string;
        readonly passedCases: number;
        readonly averageScore: number;
      };
      readonly results: readonly { readonly score: number; readonly passed: boolean }[];
    }>(response);

    expect(response.statusCode).toBe(200);
    expect(body.run.status).toBe("completed");
    expect(body.run.passedCases).toBe(1);
    expect(body.run.averageScore).toBe(1);
    expect(body.results[0]).toMatchObject({ score: 1, passed: true });
  });

  it("scores contains runs and calculates average score", async () => {
    const evaluationService = new InMemoryEvaluationService(
      new StaticEvaluationRunner("The answer contains alpha only."),
    );
    const app = await buildApp({ config: testConfig, evaluationService });
    apps.push(app);
    const dataset = await evaluationService.createDataset({
      name: "Contains",
      taskType: "summary",
    });
    await evaluationService.addCase({
      datasetId: dataset.id,
      inputMessagesJson: [{ role: "user", content: "Case one" }],
      expectedOutput: "alpha",
      gradingRubric: "contains",
    });
    await evaluationService.addCase({
      datasetId: dataset.id,
      inputMessagesJson: [{ role: "user", content: "Case two" }],
      expectedOutput: "beta",
      gradingRubric: "contains",
    });
    const run = await evaluationService.createRun({
      datasetId: dataset.id,
      provider: "openai",
      model: "gpt-4o",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/evaluations/runs/${run.id}/start`,
    });
    const body = parseResponse<{
      readonly run: { readonly passedCases: number; readonly averageScore: number };
    }>(response);

    expect(body.run.passedCases).toBe(1);
    expect(body.run.averageScore).toBe(0.5);
  });

  it("returns model evaluation scores", async () => {
    const evaluationService = new InMemoryEvaluationService(new StaticEvaluationRunner("ok"));
    const app = await buildApp({ config: testConfig, evaluationService });
    apps.push(app);
    const dataset = await evaluationService.createDataset({
      name: "Scores",
      taskType: "simple_chat",
    });
    await evaluationService.addCase({
      datasetId: dataset.id,
      inputMessagesJson: [{ role: "user", content: "ok" }],
      expectedOutput: "ok",
      gradingRubric: "exact_match",
    });
    const run = await evaluationService.createRun({
      datasetId: dataset.id,
      provider: "openai",
      model: "gpt-4o",
    });
    await evaluationService.startRun(run.id);

    const response = await app.inject({ method: "GET", url: "/v1/evaluations/scores" });
    const body = parseResponse<{
      readonly scores: readonly {
        readonly taskType: string;
        readonly model: string;
        readonly averageScore: number;
      }[];
    }>(response);

    expect(body.scores).toContainEqual(
      expect.objectContaining({
        taskType: "simple_chat",
        model: "gpt-4o",
        averageScore: 1,
      }),
    );
  });

  it("passes evaluation scores into routing", async () => {
    const evaluationService = new InMemoryEvaluationService(new StaticEvaluationRunner("ok"));
    const dataset = await evaluationService.createDataset({
      name: "Routing",
      taskType: "debugging",
    });
    await evaluationService.addCase({
      datasetId: dataset.id,
      inputMessagesJson: [{ role: "user", content: "ok" }],
      expectedOutput: "ok",
      gradingRubric: "exact_match",
    });
    const run = await evaluationService.createRun({
      datasetId: dataset.id,
      provider: "openai",
      model: "gpt-4o",
    });
    await evaluationService.startRun(run.id);
    let observedRequest: RouterLLMRequest | undefined;
    const routerLLMService: RouterLLMService = {
      decide: (request) => {
        observedRequest = request;
        const candidate = request.candidates.find((item) => item.model === "gpt-4o")!;
        return Promise.resolve({
          detectedTask: "debugging",
          complexity: "medium",
          selectedProvider: candidate.provider,
          selectedModel: candidate.model,
          fallbackModels: [],
          reason: "Use evaluated model.",
          confidence: 0.9,
        });
      },
    };
    const app = await buildApp({
      config: testConfig,
      evaluationService,
      routerLLMServiceFactory: () => routerLLMService,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": "dev-key" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Help me debug this code" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(observedRequest?.evaluationScores).toContainEqual({ model: "gpt-4o", score: 1 });
  });
});
