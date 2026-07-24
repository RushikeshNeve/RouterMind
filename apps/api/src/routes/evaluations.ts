import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import type { EvaluationService } from "../infrastructure/evaluation-service.js";
import { ensureSameWorkspace, requirePermission } from "../infrastructure/rbac.js";

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

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const workspaceDatasetParamsSchema = z.object({
  workspaceId: z.string().min(1),
  datasetId: z.string().min(1),
});

const workspaceRunParamsSchema = z.object({
  workspaceId: z.string().min(1),
  runId: z.string().min(1),
});

export function registerEvaluationRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
    readonly evaluationService: EvaluationService;
  },
): void {
  const { config, prisma, evaluationService } = dependencies;
  const preHandler = requirePermission(prisma, "analytics.read", config);

  app.post(
    "/v1/workspaces/:workspaceId/evaluations/datasets",
    { preHandler },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      const body = createDatasetSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: { message: "Invalid evaluation dataset." } });
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      return reply.status(201).send(
        await evaluationService.createDataset({
          workspaceId: params.data.workspaceId,
          ...body.data,
        }),
      );
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/evaluations/datasets",
    { preHandler },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { message: "Invalid workspace." } });
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      return { datasets: await evaluationService.listDatasets(params.data.workspaceId) };
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/evaluations/datasets/:datasetId/cases",
    { preHandler },
    async (request, reply) => {
      const params = workspaceDatasetParamsSchema.safeParse(request.params);
      const body = addCaseSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: { message: "Invalid evaluation case." } });
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      try {
        return reply.status(201).send(
          await evaluationService.addCase({
            workspaceId: params.data.workspaceId,
            datasetId: params.data.datasetId,
            inputMessagesJson: body.data.inputMessagesJson,
            expectedOutput: body.data.expectedOutput,
            gradingRubric: body.data.gradingRubric,
            metadataJson: body.data.metadataJson,
          }),
        );
      } catch (error) {
        return reply.status(404).send({ error: { message: getErrorMessage(error) } });
      }
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/evaluations/datasets/:datasetId/cases",
    { preHandler },
    async (request, reply) => {
      const params = workspaceDatasetParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { message: "Invalid evaluation dataset." } });
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      try {
        return {
          cases: await evaluationService.listCases(params.data.workspaceId, params.data.datasetId),
        };
      } catch (error) {
        return reply.status(404).send({ error: { message: getErrorMessage(error) } });
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/evaluations/runs",
    { preHandler },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      const body = createRunSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: { message: "Invalid evaluation run." } });
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      try {
        return reply.status(201).send(
          await evaluationService.createRun({
            workspaceId: params.data.workspaceId,
            ...body.data,
          }),
        );
      } catch (error) {
        return reply.status(404).send({ error: { message: getErrorMessage(error) } });
      }
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/evaluations/runs",
    { preHandler },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { message: "Invalid workspace." } });
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      return { runs: await evaluationService.listRuns(params.data.workspaceId) };
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/evaluations/runs/:runId",
    { preHandler },
    async (request, reply) => {
      const params = workspaceRunParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { message: "Invalid evaluation run." } });
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const run = await evaluationService.getRun(params.data.workspaceId, params.data.runId);
      if (!run) {
        return reply.status(404).send({ error: { message: "Evaluation run not found." } });
      }

      return run;
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/evaluations/runs/:runId/start",
    { preHandler },
    async (request, reply) => {
      const params = workspaceRunParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { message: "Invalid evaluation run." } });
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      try {
        return await evaluationService.startRun(params.data.workspaceId, params.data.runId);
      } catch (error) {
        return reply.status(404).send({ error: { message: getErrorMessage(error) } });
      }
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/evaluations/scores",
    { preHandler },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { message: "Invalid workspace." } });
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      return { scores: await evaluationService.scores(params.data.workspaceId) };
    },
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Evaluation request failed.";
}
