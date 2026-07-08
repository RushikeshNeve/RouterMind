import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  EvaluationScoringMode,
  EvaluationService,
} from "../infrastructure/evaluation-service.js";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

const createDatasetSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  taskType: z.string().min(1),
});

const addCaseSchema = z.object({
  inputMessagesJson: z.array(chatMessageSchema).min(1),
  expectedOutput: z.string(),
  gradingRubric: z.enum(["exact_match", "contains", "llm_judge"]).default("contains"),
  metadataJson: z.record(z.string(), z.unknown()).optional(),
});

const createRunSchema = z.object({
  datasetId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});

const datasetParamsSchema = z.object({
  datasetId: z.string().min(1),
});

const runParamsSchema = z.object({
  runId: z.string().min(1),
});

export function registerEvaluationRoutes(
  app: FastifyInstance,
  evaluationService: EvaluationService,
): void {
  app.post("/v1/evaluations/datasets", async (request, reply) => {
    const parsed = createDatasetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid evaluation dataset." } });
    }

    return reply.status(201).send(await evaluationService.createDataset(parsed.data));
  });

  app.get("/v1/evaluations/datasets", async () => ({
    datasets: await evaluationService.listDatasets(),
  }));

  app.post("/v1/evaluations/datasets/:datasetId/cases", async (request, reply) => {
    const params = datasetParamsSchema.safeParse(request.params);
    const body = addCaseSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: { message: "Invalid evaluation case." } });
    }

    try {
      return reply.status(201).send(
        await evaluationService.addCase({
          datasetId: params.data.datasetId,
          inputMessagesJson: body.data.inputMessagesJson,
          expectedOutput: body.data.expectedOutput,
          gradingRubric: body.data.gradingRubric as EvaluationScoringMode,
          metadataJson: body.data.metadataJson,
        }),
      );
    } catch (error) {
      return reply.status(404).send({ error: { message: getErrorMessage(error) } });
    }
  });

  app.get("/v1/evaluations/datasets/:datasetId/cases", async (request, reply) => {
    const params = datasetParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { message: "Invalid evaluation dataset." } });
    }

    try {
      return { cases: await evaluationService.listCases(params.data.datasetId) };
    } catch (error) {
      return reply.status(404).send({ error: { message: getErrorMessage(error) } });
    }
  });

  app.post("/v1/evaluations/runs", async (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid evaluation run." } });
    }

    try {
      return reply.status(201).send(await evaluationService.createRun(parsed.data));
    } catch (error) {
      return reply.status(404).send({ error: { message: getErrorMessage(error) } });
    }
  });

  app.get("/v1/evaluations/runs", async () => ({
    runs: await evaluationService.listRuns(),
  }));

  app.get("/v1/evaluations/runs/:runId", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { message: "Invalid evaluation run." } });
    }

    const run = await evaluationService.getRun(params.data.runId);
    if (!run) {
      return reply.status(404).send({ error: { message: "Evaluation run not found." } });
    }

    return run;
  });

  app.post("/v1/evaluations/runs/:runId/start", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { message: "Invalid evaluation run." } });
    }

    try {
      return await evaluationService.startRun(params.data.runId);
    } catch (error) {
      return reply.status(404).send({ error: { message: getErrorMessage(error) } });
    }
  });

  app.get("/v1/evaluations/scores", async () => ({
    scores: await evaluationService.scores(),
  }));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Evaluation request failed.";
}
