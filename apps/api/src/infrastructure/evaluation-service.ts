import { randomUUID } from "node:crypto";
import { estimateCost, estimateTokens } from "@routemind/cost-engine";
import type { ChatMessage, ProviderResponse } from "@routemind/core";
import type { ModelEvaluationScore } from "@routemind/routing";

export type EvaluationRunStatus = "pending" | "running" | "completed" | "failed";
export type EvaluationScoringMode = "exact_match" | "contains" | "llm_judge";

export interface EvaluationDataset {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description?: string;
  readonly taskType: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EvaluationCase {
  readonly id: string;
  readonly datasetId: string;
  readonly inputMessagesJson: readonly ChatMessage[];
  readonly expectedOutput: string;
  readonly gradingRubric: EvaluationScoringMode;
  readonly metadataJson?: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EvaluationRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly datasetId: string;
  readonly model: string;
  readonly provider: string;
  readonly status: EvaluationRunStatus;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly averageScore: number;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt: Date;
}

export interface EvaluationResult {
  readonly id: string;
  readonly runId: string;
  readonly caseId: string;
  readonly modelOutput: string;
  readonly score: number;
  readonly passed: boolean;
  readonly judgeReason: string;
  readonly latencyMs: number;
  readonly costUsd: number;
  readonly createdAt: Date;
}

export interface EvaluationScore {
  readonly taskType: string;
  readonly provider: string;
  readonly model: string;
  readonly averageScore: number;
  readonly runs: number;
  readonly totalCases: number;
}

export interface EvaluationModelRunner {
  run(input: {
    readonly provider: string;
    readonly model: string;
    readonly messages: readonly ChatMessage[];
  }): Promise<ProviderResponse>;
}

// Dataset/run "not found" errors are deliberately identical whether the id
// doesn't exist at all or belongs to a different workspace -- same
// ownership-can't-be-probed pattern as PATCH provider-credentials/:id --
// so every method below takes workspaceId, not just the top-level
// list/create ones.
export interface EvaluationService {
  createDataset(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly description?: string;
    readonly taskType: string;
  }): Promise<EvaluationDataset>;
  listDatasets(workspaceId: string): Promise<readonly EvaluationDataset[]>;
  addCase(input: {
    readonly workspaceId: string;
    readonly datasetId: string;
    readonly inputMessagesJson: readonly ChatMessage[];
    readonly expectedOutput: string;
    readonly gradingRubric: EvaluationScoringMode;
    readonly metadataJson?: Record<string, unknown>;
  }): Promise<EvaluationCase>;
  listCases(workspaceId: string, datasetId: string): Promise<readonly EvaluationCase[]>;
  createRun(input: {
    readonly workspaceId: string;
    readonly datasetId: string;
    readonly provider: string;
    readonly model: string;
  }): Promise<EvaluationRun>;
  listRuns(workspaceId: string): Promise<readonly EvaluationRun[]>;
  getRun(
    workspaceId: string,
    runId: string,
  ): Promise<
    | {
        readonly run: EvaluationRun;
        readonly results: readonly EvaluationResult[];
      }
    | undefined
  >;
  startRun(
    workspaceId: string,
    runId: string,
  ): Promise<{
    readonly run: EvaluationRun;
    readonly results: readonly EvaluationResult[];
  }>;
  scores(workspaceId: string): Promise<readonly EvaluationScore[]>;
  // Optional: the legacy dev-key /v1/chat/completions path (predates
  // workspaces entirely) has no workspaceId to pass -- returns [] rather
  // than mixing in every workspace's evaluation data for that caller.
  routingScores(workspaceId?: string): Promise<readonly ModelEvaluationScore[]>;
}

export class InMemoryEvaluationService implements EvaluationService {
  private readonly datasets: EvaluationDataset[] = [];
  private readonly cases: EvaluationCase[] = [];
  private readonly runs: EvaluationRun[] = [];
  private readonly results: EvaluationResult[] = [];

  constructor(private readonly modelRunner: EvaluationModelRunner) {}

  createDataset(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly description?: string;
    readonly taskType: string;
  }): Promise<EvaluationDataset> {
    const now = new Date();
    const dataset: EvaluationDataset = {
      id: `eval_dataset_${this.datasets.length + 1}`,
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description,
      taskType: input.taskType,
      createdAt: now,
      updatedAt: now,
    };

    this.datasets.push(dataset);
    return Promise.resolve(dataset);
  }

  listDatasets(workspaceId: string): Promise<readonly EvaluationDataset[]> {
    return Promise.resolve(this.datasets.filter((item) => item.workspaceId === workspaceId));
  }

  addCase(input: {
    readonly workspaceId: string;
    readonly datasetId: string;
    readonly inputMessagesJson: readonly ChatMessage[];
    readonly expectedOutput: string;
    readonly gradingRubric: EvaluationScoringMode;
    readonly metadataJson?: Record<string, unknown>;
  }): Promise<EvaluationCase> {
    this.assertDataset(input.workspaceId, input.datasetId);
    const now = new Date();
    const evaluationCase: EvaluationCase = {
      id: `eval_case_${this.cases.length + 1}`,
      datasetId: input.datasetId,
      inputMessagesJson: input.inputMessagesJson,
      expectedOutput: input.expectedOutput,
      gradingRubric: input.gradingRubric,
      metadataJson: input.metadataJson,
      createdAt: now,
      updatedAt: now,
    };

    this.cases.push(evaluationCase);
    return Promise.resolve(evaluationCase);
  }

  listCases(workspaceId: string, datasetId: string): Promise<readonly EvaluationCase[]> {
    this.assertDataset(workspaceId, datasetId);
    return Promise.resolve(this.cases.filter((item) => item.datasetId === datasetId));
  }

  createRun(input: {
    readonly workspaceId: string;
    readonly datasetId: string;
    readonly provider: string;
    readonly model: string;
  }): Promise<EvaluationRun> {
    this.assertDataset(input.workspaceId, input.datasetId);
    const run: EvaluationRun = {
      id: `eval_run_${this.runs.length + 1}`,
      workspaceId: input.workspaceId,
      datasetId: input.datasetId,
      model: input.model,
      provider: input.provider,
      status: "pending",
      totalCases: this.cases.filter((item) => item.datasetId === input.datasetId).length,
      passedCases: 0,
      averageScore: 0,
      createdAt: new Date(),
    };

    this.runs.push(run);
    return Promise.resolve(run);
  }

  listRuns(workspaceId: string): Promise<readonly EvaluationRun[]> {
    return Promise.resolve(
      this.runs
        .filter((item) => item.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }

  getRun(
    workspaceId: string,
    runId: string,
  ): Promise<
    | {
        readonly run: EvaluationRun;
        readonly results: readonly EvaluationResult[];
      }
    | undefined
  > {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId);
    if (!run) {
      return Promise.resolve(undefined);
    }

    return Promise.resolve({
      run,
      results: this.results.filter((item) => item.runId === runId),
    });
  }

  async startRun(
    workspaceId: string,
    runId: string,
  ): Promise<{
    readonly run: EvaluationRun;
    readonly results: readonly EvaluationResult[];
  }> {
    const run = this.assertRun(workspaceId, runId);

    const startedRun = this.replaceRun(run.id, {
      ...run,
      status: "running",
      startedAt: new Date(),
      totalCases: this.cases.filter((item) => item.datasetId === run.datasetId).length,
    });
    const runCases = this.cases.filter((item) => item.datasetId === run.datasetId);
    const runResults: EvaluationResult[] = [];

    try {
      for (const evaluationCase of runCases) {
        const startedAt = Date.now();
        const response = await this.modelRunner.run({
          provider: startedRun.provider,
          model: startedRun.model,
          messages: evaluationCase.inputMessagesJson,
        });
        const latencyMs = Date.now() - startedAt;
        const modelOutput = response.choices[0]?.message.content ?? "";
        const judgment = judgeOutput(evaluationCase, modelOutput);
        const result: EvaluationResult = {
          id: `eval_result_${this.results.length + runResults.length + 1}`,
          runId: startedRun.id,
          caseId: evaluationCase.id,
          modelOutput,
          score: judgment.score,
          passed: judgment.passed,
          judgeReason: judgment.reason,
          latencyMs,
          costUsd: estimateCost(startedRun.model, {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }),
          createdAt: new Date(),
        };

        runResults.push(result);
      }

      this.results.push(...runResults);
      const completedRun = this.replaceRun(startedRun.id, {
        ...startedRun,
        status: "completed",
        totalCases: runCases.length,
        passedCases: runResults.filter((result) => result.passed).length,
        averageScore: average(runResults.map((result) => result.score)),
        completedAt: new Date(),
      });

      return {
        run: completedRun,
        results: runResults,
      };
    } catch {
      const failedRun = this.replaceRun(startedRun.id, {
        ...startedRun,
        status: "failed",
        completedAt: new Date(),
      });

      return {
        run: failedRun,
        results: runResults,
      };
    }
  }

  scores(workspaceId: string): Promise<readonly EvaluationScore[]> {
    const completedRuns = this.runs.filter(
      (run) => run.status === "completed" && run.workspaceId === workspaceId,
    );
    const grouped = new Map<string, EvaluationScore & { readonly totalScore: number }>();

    for (const run of completedRuns) {
      const dataset = this.datasets.find((item) => item.id === run.datasetId);
      if (!dataset) {
        continue;
      }

      const key = `${dataset.taskType}:${run.provider}:${run.model}`;
      const existing = grouped.get(key);
      const totalCases = existing ? existing.totalCases + run.totalCases : run.totalCases;
      const runs = existing ? existing.runs + 1 : 1;
      const totalScore =
        (existing?.totalScore ?? 0) + run.averageScore * Math.max(run.totalCases, 1);

      grouped.set(key, {
        taskType: dataset.taskType,
        provider: run.provider,
        model: run.model,
        runs,
        totalCases,
        totalScore,
        averageScore: totalCases === 0 ? 0 : totalScore / totalCases,
      });
    }

    return Promise.resolve(
      [...grouped.values()].map((scoreEntry) => {
        const { totalScore, ...score } = scoreEntry;
        void totalScore;
        return score;
      }),
    );
  }

  async routingScores(workspaceId?: string): Promise<readonly ModelEvaluationScore[]> {
    if (!workspaceId) {
      return [];
    }

    return (await this.scores(workspaceId)).map((score) => ({
      model: score.model,
      score: score.averageScore,
    }));
  }

  private assertDataset(workspaceId: string, datasetId: string): void {
    if (!this.datasets.some((item) => item.id === datasetId && item.workspaceId === workspaceId)) {
      throw new Error("Evaluation dataset not found.");
    }
  }

  private assertRun(workspaceId: string, runId: string): EvaluationRun {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId);
    if (!run) {
      throw new Error("Evaluation run not found.");
    }
    return run;
  }

  private replaceRun(runId: string, next: EvaluationRun): EvaluationRun {
    const index = this.runs.findIndex((item) => item.id === runId);
    if (index === -1) {
      throw new Error("Evaluation run not found.");
    }

    this.runs[index] = next;
    return next;
  }
}

export class EchoEvaluationModelRunner implements EvaluationModelRunner {
  run(input: {
    readonly provider: string;
    readonly model: string;
    readonly messages: readonly ChatMessage[];
  }): Promise<ProviderResponse> {
    const content = input.messages.map((message) => message.content).join("\n");
    const tokenEstimate = estimateTokens(content.length);

    return Promise.resolve({
      id: `eval_${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: input.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: tokenEstimate.inputTokens,
        completion_tokens: tokenEstimate.outputTokens,
        total_tokens: tokenEstimate.inputTokens + tokenEstimate.outputTokens,
      },
    });
  }
}

function judgeOutput(
  evaluationCase: EvaluationCase,
  modelOutput: string,
): { readonly score: number; readonly passed: boolean; readonly reason: string } {
  const expected = evaluationCase.expectedOutput.trim();
  const actual = modelOutput.trim();

  if (evaluationCase.gradingRubric === "exact_match") {
    const passed = actual === expected;
    return {
      score: passed ? 1 : 0,
      passed,
      reason: passed ? "Exact match." : "Output did not exactly match expected output.",
    };
  }

  if (evaluationCase.gradingRubric === "contains") {
    const passed = actual.toLowerCase().includes(expected.toLowerCase());
    return {
      score: passed ? 1 : 0,
      passed,
      reason: passed ? "Output contained expected text." : "Output did not contain expected text.",
    };
  }

  return {
    score: actual.length > 0 ? 0.5 : 0,
    passed: actual.length > 0,
    reason: "Mock llm_judge used for MVP.",
  };
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}
