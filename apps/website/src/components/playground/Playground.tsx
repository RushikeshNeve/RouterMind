"use client";

import { useState } from "react";
import { Section } from "../landing/section";
import { PromptInput } from "./PromptInput";
import { RoutingResult } from "./RoutingResult";
import { RoutingSteps, routingStepLabels } from "./RoutingSteps";
import {
  simulateRouting,
  type PlaygroundModel,
  type RoutingResultData,
  type RoutingStrategy,
} from "./demoRouter";

const defaultPrompt = "Help me debug this Node.js API timeout issue in production.";

function delay(ms: number) {
  const timer = (
    globalThis as { readonly setTimeout: (callback: () => void, ms: number) => unknown }
  ).setTimeout;
  return new Promise<void>((resolve) => {
    timer(resolve, ms);
  });
}

export function Playground() {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [model, setModel] = useState<PlaygroundModel>("auto");
  const [strategy, setStrategy] = useState<RoutingStrategy>("balanced");
  const [activeStep, setActiveStep] = useState(0);
  const [isRouting, setIsRouting] = useState(false);
  const [result, setResult] = useState<RoutingResultData>();

  const routeRequest = async () => {
    if (isRouting) return;

    setIsRouting(true);
    setResult(undefined);
    setActiveStep(0);

    for (let index = 0; index < routingStepLabels.length; index += 1) {
      setActiveStep(index);
      await delay(360);
    }

    const simulatedResult = simulateRouting({ prompt, model, strategy });
    setResult(simulatedResult);
    setActiveStep(routingStepLabels.length);
    setIsRouting(false);
  };

  return (
    <Section
      id="playground"
      className="bg-slate-50"
      title="Try RouteMind Routing"
      description="Enter a prompt and watch RouteMind analyze it, select a model, estimate cost, and return a response."
    >
      <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <PromptInput
          prompt={prompt}
          model={model}
          strategy={strategy}
          isRouting={isRouting}
          onPromptChange={setPrompt}
          onModelChange={setModel}
          onStrategyChange={setStrategy}
          onRoute={routeRequest}
        />

        <div className="grid gap-5 xl:grid-cols-[0.86fr_1fr]">
          <RoutingSteps activeStep={activeStep} isRouting={isRouting} />
          <RoutingResult result={result} />
        </div>
      </div>
    </Section>
  );
}
