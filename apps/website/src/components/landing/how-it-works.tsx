import { ArrowDown, CheckCircle2, MousePointer2, Radar, Route } from "lucide-react";
import { FadeIn } from "./motion";
import { Section } from "./section";

const steps = [
  {
    title: "Request",
    description: "Your app sends one OpenAI-compatible request.",
    icon: MousePointer2,
  },
  {
    title: "RouteMind analyzes prompt",
    description: "The gateway checks model access, policy, budget, and prompt shape.",
    icon: Radar,
  },
  {
    title: "Selects best provider",
    description: "Routing weighs cost, latency, health, and model capabilities.",
    icon: Route,
  },
  {
    title: "Returns response",
    description: "The app receives a familiar completion shape with RouteMind metadata.",
    icon: CheckCircle2,
  },
];

export function HowItWorks() {
  return (
    <Section
      title="How it works"
      description="Keep the application integration simple while RouteMind handles model decisions."
    >
      <div className="grid gap-4 lg:grid-cols-4">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <FadeIn key={step.title} delay={index * 0.06}>
              <article className="relative h-full rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                  <Icon className="h-5 w-5" />
                </div>
                <p className="mt-6 text-sm font-semibold text-blue-600">0{index + 1}</p>
                <h3 className="mt-2 text-lg font-semibold text-slate-950">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{step.description}</p>
                {index < steps.length - 1 ? (
                  <ArrowDown className="absolute -bottom-7 left-1/2 h-5 w-5 -translate-x-1/2 text-slate-300 lg:-right-7 lg:bottom-auto lg:left-auto lg:top-1/2 lg:-translate-y-1/2 lg:rotate-[-90deg]" />
                ) : null}
              </article>
            </FadeIn>
          );
        })}
      </div>
    </Section>
  );
}
