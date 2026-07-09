export type PlaygroundModel = "auto" | "gpt-4o-mini" | "gpt-4o" | "gpt-4.1-nano";

export type RoutingStrategy = "balanced" | "cost_first" | "latency_first" | "quality_first";

export type PromptCategory = "debugging" | "summarization" | "system_design" | "default";

export interface PlaygroundRequest {
  readonly prompt: string;
  readonly model: PlaygroundModel;
  readonly strategy: RoutingStrategy;
}

export interface RoutingResultData {
  readonly category: PromptCategory;
  readonly selectedModel: Exclude<PlaygroundModel, "auto">;
  readonly provider: "OpenAI";
  readonly estimatedCost: string;
  readonly latencyMs: number;
  readonly reason: string;
  readonly response: string;
  readonly mode: "Demo Mode" | "Live Mode";
}

const modelCost: Record<RoutingResultData["selectedModel"], string> = {
  "gpt-4.1-nano": "$0.0002",
  "gpt-4o-mini": "$0.0008",
  "gpt-4o": "$0.0045",
};

const modelLatency: Record<RoutingResultData["selectedModel"], number> = {
  "gpt-4.1-nano": 650,
  "gpt-4o-mini": 900,
  "gpt-4o": 1500,
};

export function simulateRouting(request: PlaygroundRequest): RoutingResultData {
  const prompt = request.prompt.toLowerCase();
  const category = detectPromptCategory(prompt);
  const selectedModel = request.model === "auto" ? selectModel(category) : request.model;

  return {
    category,
    selectedModel,
    provider: "OpenAI",
    estimatedCost: modelCost[selectedModel],
    latencyMs: modelLatency[selectedModel],
    reason: getReason(category, selectedModel),
    response: getMockResponse(category),
    mode: "Demo Mode",
  };
}

function detectPromptCategory(prompt: string): PromptCategory {
  if (["debug", "bug", "error", "stack trace"].some((keyword) => prompt.includes(keyword))) {
    return "debugging";
  }

  if (["summarize", "rewrite", "grammar"].some((keyword) => prompt.includes(keyword))) {
    return "summarization";
  }

  if (["architecture", "system design", "reasoning"].some((keyword) => prompt.includes(keyword))) {
    return "system_design";
  }

  return "default";
}

function selectModel(category: PromptCategory): RoutingResultData["selectedModel"] {
  if (category === "debugging" || category === "system_design") {
    return "gpt-4o";
  }

  if (category === "summarization") {
    return "gpt-4.1-nano";
  }

  return "gpt-4o-mini";
}

function getReason(
  category: PromptCategory,
  selectedModel: RoutingResultData["selectedModel"],
): string {
  if (category === "debugging") {
    return "Stronger model selected for debugging and reasoning.";
  }

  if (category === "summarization") {
    return "Low-cost model selected for simple text transformation.";
  }

  if (category === "system_design") {
    return "Higher-quality model selected for complex reasoning.";
  }

  if (selectedModel === "gpt-4o-mini") {
    return "Balanced fast and cost-effective model selected.";
  }

  return `${selectedModel} selected from the requested model preference.`;
}

function getMockResponse(category: PromptCategory): string {
  if (category === "debugging") {
    return "RouteMind selected a stronger reasoning model because debugging usually requires context understanding, code reasoning, and step-by-step analysis.";
  }

  if (category === "summarization") {
    return "RouteMind selected a low-cost model because summarization can often be handled efficiently without premium reasoning.";
  }

  if (category === "system_design") {
    return "RouteMind selected a higher-quality model because architecture questions require tradeoff analysis and deeper reasoning.";
  }

  return "RouteMind selected a balanced model optimized for speed, cost, and quality.";
}
