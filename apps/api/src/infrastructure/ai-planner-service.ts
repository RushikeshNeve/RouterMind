import { estimateCost } from "@routemind/cost-engine";
import type { ProviderId } from "@routemind/providers";
import type { DetectedTask, RoutingCandidateModel, RouterStrategy } from "@routemind/routing";

export type ExecutionPlanRequest =
  "auto" | "single_model" | "cheap_first" | "summarize_then_reason" | "quality_first";

export type ExecutableExecutionPlan = "single_model" | "quality_first";
export type ExecutionPlanType = Exclude<ExecutionPlanRequest, "auto">;

export interface ExecutionPlanStep {
  readonly step: number;
  readonly purpose:
    | "answer_user_request"
    | "draft_low_cost_answer"
    | "quality_review_or_escalation"
    | "summarize_context"
    | "reason_over_summary";
  readonly provider: ProviderId;
  readonly model: string;
  readonly reason: string;
}

export interface AIPlannerInput {
  readonly requestedExecutionPlan: ExecutionPlanRequest;
  readonly userPrompt: string;
  readonly messages: readonly { readonly content: string }[];
  readonly candidates: readonly RoutingCandidateModel[];
  readonly primaryProvider: ProviderId;
  readonly primaryModel: string;
  readonly approximateInputTokens: number;
  readonly approximateOutputTokens: number;
  readonly routingStrategy: RouterStrategy;
  readonly taskType: DetectedTask;
  readonly complexity: "low" | "medium" | "high";
}

export interface AIPlannerDecision {
  readonly executionPlan: ExecutionPlanType;
  readonly steps: readonly ExecutionPlanStep[];
  readonly estimatedCostUsd: number;
  readonly reason: string;
  readonly confidence: number;
  readonly executable: boolean;
}

export class AIPlannerService {
  plan(input: AIPlannerInput): Promise<AIPlannerDecision> {
    const requested =
      input.requestedExecutionPlan === "auto" ? "single_model" : input.requestedExecutionPlan;

    switch (requested) {
      case "quality_first":
        return Promise.resolve(this.qualityFirst(input));
      case "cheap_first":
        return Promise.resolve(this.cheapFirst(input));
      case "summarize_then_reason":
        return Promise.resolve(this.summarizeThenReason(input));
      case "single_model":
      default:
        return Promise.resolve(this.singleModel(input));
    }
  }

  private singleModel(input: AIPlannerInput): AIPlannerDecision {
    const primary =
      input.candidates.find(
        (candidate) =>
          candidate.provider === input.primaryProvider && candidate.model === input.primaryModel,
      ) ?? input.candidates[0];

    if (!primary) {
      return emptyPlan("single_model", "No valid candidates were available for planning.");
    }

    return {
      executionPlan: "single_model",
      steps: [
        {
          step: 1,
          purpose: "answer_user_request",
          provider: primary.provider,
          model: primary.model,
          reason: `Best fit for ${input.complexity}-complexity ${input.taskType} task.`,
        },
      ],
      estimatedCostUsd: estimateCandidateCost(primary, input),
      reason: "Use the normal routed model as a single-step execution plan.",
      confidence: input.complexity === "high" ? 0.78 : 0.86,
      executable: true,
    };
  }

  private qualityFirst(input: AIPlannerInput): AIPlannerDecision {
    const candidate = [...input.candidates].sort(
      (a, b) =>
        qualityRank[b.capabilities.qualityTier] - qualityRank[a.capabilities.qualityTier] ||
        costRank[b.capabilities.costTier] - costRank[a.capabilities.costTier] ||
        b.metrics.reliabilityScore - a.metrics.reliabilityScore,
    )[0];

    if (!candidate) {
      return emptyPlan("quality_first", "No valid candidates were available for planning.");
    }

    return {
      executionPlan: "quality_first",
      steps: [
        {
          step: 1,
          purpose: "answer_user_request",
          provider: candidate.provider,
          model: candidate.model,
          reason: "Highest quality available model after routing constraints.",
        },
      ],
      estimatedCostUsd: estimateCandidateCost(candidate, input),
      reason: "Prioritize answer quality over cost and latency.",
      confidence: 0.9,
      executable: true,
    };
  }

  private cheapFirst(input: AIPlannerInput): AIPlannerDecision {
    const cheap = [...input.candidates].sort(
      (a, b) =>
        costRank[a.capabilities.costTier] - costRank[b.capabilities.costTier] ||
        a.metrics.latencyMs - b.metrics.latencyMs,
    )[0];
    const strong = [...input.candidates].sort(
      (a, b) => qualityRank[b.capabilities.qualityTier] - qualityRank[a.capabilities.qualityTier],
    )[0];

    if (!cheap || !strong) {
      return emptyPlan("cheap_first", "No valid candidates were available for planning.");
    }

    return {
      executionPlan: "cheap_first",
      steps: [
        {
          step: 1,
          purpose: "draft_low_cost_answer",
          provider: cheap.provider,
          model: cheap.model,
          reason: "Start with the cheapest fast candidate.",
        },
        {
          step: 2,
          purpose: "quality_review_or_escalation",
          provider: strong.provider,
          model: strong.model,
          reason: "Escalate if the draft confidence or quality is weak.",
        },
      ],
      estimatedCostUsd: estimateCandidateCost(cheap, input) + estimateCandidateCost(strong, input),
      reason: "Planned but not executable yet in this MVP.",
      confidence: 0.72,
      executable: false,
    };
  }

  private summarizeThenReason(input: AIPlannerInput): AIPlannerDecision {
    const summarizer =
      input.candidates.find((candidate) => candidate.capabilities.supportsSummarization) ??
      input.candidates[0];
    const reasoner =
      [...input.candidates]
        .filter((candidate) => candidate.capabilities.supportsReasoning)
        .sort(
          (a, b) =>
            qualityRank[b.capabilities.qualityTier] - qualityRank[a.capabilities.qualityTier],
        )[0] ?? input.candidates[0];

    if (!summarizer || !reasoner) {
      return emptyPlan("summarize_then_reason", "No valid candidates were available for planning.");
    }

    return {
      executionPlan: "summarize_then_reason",
      steps: [
        {
          step: 1,
          purpose: "summarize_context",
          provider: summarizer.provider,
          model: summarizer.model,
          reason: "Compress the large context before reasoning.",
        },
        {
          step: 2,
          purpose: "reason_over_summary",
          provider: reasoner.provider,
          model: reasoner.model,
          reason: "Use a stronger reasoning model on compressed context.",
        },
      ],
      estimatedCostUsd:
        estimateCandidateCost(summarizer, input) + estimateCandidateCost(reasoner, input),
      reason: "Planned but not executable yet in this MVP.",
      confidence: 0.74,
      executable: false,
    };
  }
}

const qualityRank = {
  standard: 1,
  strong: 2,
  premium: 3,
};

const costRank = {
  low: 1,
  medium: 2,
  high: 3,
};

function estimateCandidateCost(candidate: RoutingCandidateModel, input: AIPlannerInput): number {
  return estimateCost(candidate.model, {
    inputTokens: input.approximateInputTokens,
    outputTokens: input.approximateOutputTokens,
  });
}

function emptyPlan(planType: ExecutionPlanType, reason: string): AIPlannerDecision {
  return {
    executionPlan: planType,
    steps: [],
    estimatedCostUsd: 0,
    reason,
    confidence: 0,
    executable: planType === "single_model" || planType === "quality_first",
  };
}
