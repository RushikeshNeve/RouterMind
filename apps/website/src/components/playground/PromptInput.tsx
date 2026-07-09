import { Play, Sparkles } from "lucide-react";
import type { PlaygroundModel, RoutingStrategy } from "./demoRouter";

const modelOptions: readonly PlaygroundModel[] = ["auto", "gpt-4o-mini", "gpt-4o", "gpt-4.1-nano"];
const strategyOptions: readonly RoutingStrategy[] = [
  "balanced",
  "cost_first",
  "latency_first",
  "quality_first",
];

function readEventValue(event: unknown) {
  return (event as { readonly target: { readonly value: string } }).target.value;
}

export function PromptInput({
  prompt,
  model,
  strategy,
  isRouting,
  onPromptChange,
  onModelChange,
  onStrategyChange,
  onRoute,
}: {
  readonly prompt: string;
  readonly model: PlaygroundModel;
  readonly strategy: RoutingStrategy;
  readonly isRouting: boolean;
  readonly onPromptChange: (value: string) => void;
  readonly onModelChange: (value: PlaygroundModel) => void;
  readonly onStrategyChange: (value: RoutingStrategy) => void;
  readonly onRoute: () => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-950">Request input</h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Tune the model and strategy, then watch RouteMind make the routing decision.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
          <Sparkles className="h-3.5 w-3.5" />
          Demo Mode
        </span>
      </div>

      <label
        className="mt-6 block text-sm font-semibold text-slate-800"
        htmlFor="playground-prompt"
      >
        Prompt
      </label>
      <textarea
        id="playground-prompt"
        value={prompt}
        onChange={(event) => onPromptChange(readEventValue(event))}
        placeholder="Help me debug this Node.js API timeout issue..."
        className="mt-2 min-h-40 w-full resize-none rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
      />

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-semibold text-slate-800">Model</span>
          <select
            value={model}
            onChange={(event) => onModelChange(readEventValue(event) as PlaygroundModel)}
            className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 shadow-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
          >
            {modelOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-slate-800">Routing strategy</span>
          <select
            value={strategy}
            onChange={(event) => onStrategyChange(readEventValue(event) as RoutingStrategy)}
            className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 shadow-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
          >
            {strategyOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button
        type="button"
        onClick={onRoute}
        disabled={isRouting}
        className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-lg bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400 sm:w-auto"
      >
        <Play className="mr-2 h-4 w-4" />
        {isRouting ? "Routing..." : "Route Request"}
      </button>
    </div>
  );
}
