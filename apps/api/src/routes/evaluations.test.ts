import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderResponse } from "@routemind/core";

import {
  InMemoryEvaluationService,
  type EvaluationModelRunner,
  type EvaluationService,
} from "../infrastructure/evaluation-service.js";
import {
  cleanupFixture,
  createPrismaWorkspaceTestApp,
  seedWorkspaceWithRole,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

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

describe("evaluation routes (workspace-scoped)", () => {
  const prisma = new PrismaClient({
    datasourceUrl: "postgresql://routemind:routemind@localhost:5432/routemind?schema=public",
  });
  const apps: Array<Awaited<ReturnType<typeof createPrismaWorkspaceTestApp>>["app"]> = [];
  const fixtures: WorkspaceRoleFixture[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(prisma, fixture)));
  });

  async function setup(roleName: string, output = "ok") {
    const fixture = await seedWorkspaceWithRole(prisma, roleName);
    fixtures.push(fixture);
    const evaluationService = new InMemoryEvaluationService(new StaticEvaluationRunner(output));
    const { app } = await createPrismaWorkspaceTestApp(prisma, { evaluationService });
    apps.push(app);
    return { app, fixture, evaluationService };
  }

  it("creates datasets and adds evaluation cases within the caller's own workspace", async () => {
    const { app, fixture } = await setup("Owner");

    const datasetResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/evaluations/datasets`,
      headers: { "x-api-key": fixture.apiKey },
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
      url: `/v1/workspaces/${fixture.workspaceId}/evaluations/datasets/${dataset.id}/cases`,
      headers: { "x-api-key": fixture.apiKey },
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
    const { app, fixture, evaluationService } = await setup("Owner", "Hello");
    const dataset = await evaluationService.createDataset({
      workspaceId: fixture.workspaceId,
      name: "Exact",
      taskType: "simple_chat",
    });
    await evaluationService.addCase({
      workspaceId: fixture.workspaceId,
      datasetId: dataset.id,
      inputMessagesJson: [{ role: "user", content: "Say Hello" }],
      expectedOutput: "Hello",
      gradingRubric: "exact_match",
    });
    const run = await evaluationService.createRun({
      workspaceId: fixture.workspaceId,
      datasetId: dataset.id,
      provider: "openai",
      model: "gpt-4o",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/evaluations/runs/${run.id}/start`,
      headers: { "x-api-key": fixture.apiKey },
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
    const { app, fixture, evaluationService } = await setup(
      "Owner",
      "The answer contains alpha only.",
    );
    const dataset = await evaluationService.createDataset({
      workspaceId: fixture.workspaceId,
      name: "Contains",
      taskType: "summary",
    });
    await evaluationService.addCase({
      workspaceId: fixture.workspaceId,
      datasetId: dataset.id,
      inputMessagesJson: [{ role: "user", content: "Case one" }],
      expectedOutput: "alpha",
      gradingRubric: "contains",
    });
    await evaluationService.addCase({
      workspaceId: fixture.workspaceId,
      datasetId: dataset.id,
      inputMessagesJson: [{ role: "user", content: "Case two" }],
      expectedOutput: "beta",
      gradingRubric: "contains",
    });
    const run = await evaluationService.createRun({
      workspaceId: fixture.workspaceId,
      datasetId: dataset.id,
      provider: "openai",
      model: "gpt-4o",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/evaluations/runs/${run.id}/start`,
      headers: { "x-api-key": fixture.apiKey },
    });
    const body = parseResponse<{
      readonly run: { readonly passedCases: number; readonly averageScore: number };
    }>(response);

    expect(body.run.passedCases).toBe(1);
    expect(body.run.averageScore).toBe(0.5);
  });

  it("returns model evaluation scores scoped to the caller's own workspace", async () => {
    const { app, fixture, evaluationService } = await setup("Owner");
    const dataset = await evaluationService.createDataset({
      workspaceId: fixture.workspaceId,
      name: "Scores",
      taskType: "simple_chat",
    });
    await evaluationService.addCase({
      workspaceId: fixture.workspaceId,
      datasetId: dataset.id,
      inputMessagesJson: [{ role: "user", content: "ok" }],
      expectedOutput: "ok",
      gradingRubric: "exact_match",
    });
    const run = await evaluationService.createRun({
      workspaceId: fixture.workspaceId,
      datasetId: dataset.id,
      provider: "openai",
      model: "gpt-4o",
    });
    await evaluationService.startRun(fixture.workspaceId, run.id);

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/evaluations/scores`,
      headers: { "x-api-key": fixture.apiKey },
    });
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

  it("threads the caller's own workspaceId into routingScores() on every chat completion, not another workspace's", async () => {
    // dependencies.evaluationService.routingScores(user.workspaceId) runs on
    // every /v1/chat/completions request regardless of routing mode -- what
    // changed for this item is that it now receives the *caller's own*
    // workspaceId instead of nothing at all, so a spy on routingScores is a
    // more precise proof of the fix than re-exercising llm_assisted routing's
    // full mechanics (already covered by decide-llm-route.test.ts).
    const fixtureA = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(fixtureA);
    const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(fixtureB);
    const inner = new InMemoryEvaluationService(new StaticEvaluationRunner("ok"));
    const observedWorkspaceIds: Array<string | undefined> = [];
    const spyEvaluationService: EvaluationService = {
      createDataset: inner.createDataset.bind(inner),
      listDatasets: inner.listDatasets.bind(inner),
      addCase: inner.addCase.bind(inner),
      listCases: inner.listCases.bind(inner),
      createRun: inner.createRun.bind(inner),
      listRuns: inner.listRuns.bind(inner),
      getRun: inner.getRun.bind(inner),
      startRun: inner.startRun.bind(inner),
      scores: inner.scores.bind(inner),
      routingScores: (workspaceId?: string) => {
        observedWorkspaceIds.push(workspaceId);
        return inner.routingScores(workspaceId);
      },
    };
    const { app } = await createPrismaWorkspaceTestApp(prisma, {
      evaluationService: spyEvaluationService,
    });
    apps.push(app);

    const responseA = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": fixtureA.apiKey },
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] },
    });
    const responseB = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": fixtureB.apiKey },
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] },
    });

    expect(responseA.statusCode).toBe(200);
    expect(responseB.statusCode).toBe(200);
    expect(observedWorkspaceIds).toEqual([fixtureA.workspaceId, fixtureB.workspaceId]);
  });

  it("rejects an unauthenticated request", async () => {
    const { app, fixture } = await setup("Owner");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/evaluations/scores`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a caller whose key belongs to a different workspace", async () => {
    const { fixture: fixtureA } = await setup("Owner");
    const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(fixtureB);
    const { app } = await createPrismaWorkspaceTestApp(prisma);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixtureA.workspaceId}/evaluations/datasets`,
      headers: { "x-api-key": fixtureB.apiKey },
    });

    expect(response.statusCode).toBe(403);
  });

  it("isolates datasets, runs, and scores between two workspaces", async () => {
    const evaluationService = new InMemoryEvaluationService(new StaticEvaluationRunner("ok"));
    const fixtureA = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(fixtureA);
    const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(fixtureB);
    const { app } = await createPrismaWorkspaceTestApp(prisma, { evaluationService });
    apps.push(app);

    const datasetA = await evaluationService.createDataset({
      workspaceId: fixtureA.workspaceId,
      name: "A's dataset",
      taskType: "simple_chat",
    });
    await evaluationService.addCase({
      workspaceId: fixtureA.workspaceId,
      datasetId: datasetA.id,
      inputMessagesJson: [{ role: "user", content: "ok" }],
      expectedOutput: "ok",
      gradingRubric: "exact_match",
    });
    const runA = await evaluationService.createRun({
      workspaceId: fixtureA.workspaceId,
      datasetId: datasetA.id,
      provider: "openai",
      model: "gpt-4o",
    });
    await evaluationService.startRun(fixtureA.workspaceId, runA.id);

    // Workspace B lists datasets/scores -- must never see workspace A's data.
    const datasetsB = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixtureB.workspaceId}/evaluations/datasets`,
      headers: { "x-api-key": fixtureB.apiKey },
    });
    expect(parseResponse<{ datasets: unknown[] }>(datasetsB).datasets).toHaveLength(0);

    const scoresB = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixtureB.workspaceId}/evaluations/scores`,
      headers: { "x-api-key": fixtureB.apiKey },
    });
    expect(parseResponse<{ scores: unknown[] }>(scoresB).scores).toHaveLength(0);

    // Workspace B cannot reach workspace A's dataset via its own workspace path.
    const crossDatasetCases = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixtureB.workspaceId}/evaluations/datasets/${datasetA.id}/cases`,
      headers: { "x-api-key": fixtureB.apiKey },
    });
    expect(crossDatasetCases.statusCode).toBe(404);

    // Workspace A still sees its own data.
    const datasetsA = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixtureA.workspaceId}/evaluations/datasets`,
      headers: { "x-api-key": fixtureA.apiKey },
    });
    expect(parseResponse<{ datasets: unknown[] }>(datasetsA).datasets).toHaveLength(1);
  });
});
