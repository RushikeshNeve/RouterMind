import { Clock3, Cpu, DollarSign, Server, Sparkles } from "lucide-react";
import type { RoutingResultData } from "./demoRouter";

const emptyCards = [
  { label: "Selected Model", value: "Waiting", icon: Cpu },
  { label: "Provider", value: "Not routed", icon: Server },
  { label: "Estimated Cost", value: "$0.0000", icon: DollarSign },
  { label: "Latency", value: "--", icon: Clock3 },
];

export function RoutingResult({ result }: { readonly result?: RoutingResultData }) {
  const cards = result
    ? [
        { label: "Selected Model", value: result.selectedModel, icon: Cpu },
        { label: "Provider", value: result.provider, icon: Server },
        { label: "Estimated Cost", value: result.estimatedCost, icon: DollarSign },
        { label: "Latency", value: `${(result.latencyMs / 1000).toFixed(1)}s`, icon: Clock3 },
      ]
    : emptyCards;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-950">Routing result</h3>
          <p className="mt-1 text-sm text-slate-600">
            {result ? "OpenAI-compatible response metadata." : "Run a request to see the decision."}
          </p>
        </div>
        <span className="rounded-lg border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
          {result?.mode ?? "Demo Mode"}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <Icon className="h-3.5 w-3.5 text-blue-600" />
                {card.label}
              </div>
              <p className="mt-2 text-base font-semibold text-slate-950">{card.value}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <Sparkles className="h-3.5 w-3.5 text-blue-600" />
          Reason
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          {result?.reason ?? "RouteMind will explain the model selection after the simulated run."}
        </p>
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-950 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Mock response
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-100">
          {result?.response ??
            "Enter a prompt and click Route Request to generate a deterministic demo response."}
        </p>
      </div>
    </div>
  );
}
