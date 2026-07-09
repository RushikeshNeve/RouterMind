"use client";

import { CheckCircle2, CircleDashed } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

export const routingStepLabels = [
  "Prompt Analysis",
  "Model Availability Check",
  "Cost + Latency Evaluation",
  "Provider Health Check",
  "Route Decision",
  "Response Generated",
] as const;

export function RoutingSteps({
  activeStep,
  isRouting,
}: {
  readonly activeStep: number;
  readonly isRouting: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-950">Routing pipeline</h3>
          <p className="mt-1 text-sm text-slate-600">Animated request evaluation sequence.</p>
        </div>
        <span className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600">
          {isRouting ? "Analyzing" : activeStep >= routingStepLabels.length ? "Complete" : "Idle"}
        </span>
      </div>

      <div className="mt-5 space-y-3">
        {routingStepLabels.map((label, index) => {
          const complete = activeStep > index;
          const active = activeStep === index;
          return (
            <motion.div
              key={label}
              initial={false}
              animate={{
                borderColor: active || complete ? "#bfdbfe" : "#e5e7eb",
                backgroundColor: active || complete ? "#eff6ff" : "#ffffff",
              }}
              className="flex items-center gap-3 rounded-xl border px-3 py-3"
            >
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                  complete
                    ? "bg-blue-600 text-white"
                    : active
                      ? "bg-blue-100 text-blue-700"
                      : "bg-slate-50 text-slate-400"
                }`}
              >
                {complete ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <CircleDashed className={`h-4 w-4 ${active ? "animate-spin" : ""}`} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900">{label}</p>
                <AnimatePresence>
                  {active ? (
                    <motion.div
                      initial={{ width: 0, opacity: 0 }}
                      animate={{ width: "100%", opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.45 }}
                      className="mt-2 h-1 rounded-full bg-blue-500"
                    />
                  ) : null}
                </AnimatePresence>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
