"use client";

import { ArrowRight, GitBranch, LayoutDashboard } from "lucide-react";
import { links, providers } from "./data";
import { FadeIn, MotionDiv } from "./motion";
import { ButtonLink } from "./section";

export function Hero() {
  return (
    <section className="relative overflow-hidden px-6 pb-20 pt-32 sm:pb-24 sm:pt-36 lg:px-8">
      <div className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,#e5e7eb_1px,transparent_1px),linear-gradient(to_bottom,#e5e7eb_1px,transparent_1px)] bg-[size:80px_80px] opacity-30" />
      <div className="absolute inset-x-0 top-0 -z-10 h-96 bg-gradient-to-b from-blue-50 via-white to-white" />

      <div className="mx-auto grid max-w-7xl items-center gap-14 lg:grid-cols-[1fr_0.92fr]">
        <FadeIn>
          <div className="max-w-3xl">
            <h1 className="text-5xl font-semibold tracking-tight text-slate-950 sm:text-6xl lg:text-7xl">
              One API.
              <br />
              Every Model.
              <br />
              Intelligent Routing.
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-slate-600 sm:text-xl">
              RouteMind is an enterprise AI Gateway that intelligently routes requests across
              OpenAI, Anthropic, Gemini and Groq based on cost, latency, provider health and model
              capabilities.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <ButtonLink href="#get-started">
                Get Started
                <ArrowRight className="ml-2 h-4 w-4" />
              </ButtonLink>
              <ButtonLink href={links.github} variant="secondary">
                <GitBranch className="mr-2 h-4 w-4" />
                GitHub
              </ButtonLink>
              <ButtonLink href={links.dashboard} variant="secondary">
                <LayoutDashboard className="mr-2 h-4 w-4" />
                Dashboard
              </ButtonLink>
            </div>
          </div>
        </FadeIn>

        <FadeIn delay={0.12}>
          <div className="relative mx-auto w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_24px_80px_rgba(15,23,42,0.10)]">
            <div className="mb-5 flex items-center justify-between border-b border-slate-100 pb-4">
              <div>
                <p className="text-sm font-semibold text-slate-950">Routing plan</p>
                <p className="text-xs text-slate-500">cost + latency + health</p>
              </div>
              <span className="rounded-md bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                auto
              </span>
            </div>

            <div className="space-y-4">
              <Node label="Application" tone="muted" />
              <FlowLine />
              <Node label="RouteMind" tone="accent" />
              <FlowLine />
              <div className="grid grid-cols-2 gap-3">
                {providers.map((provider, index) => (
                  <MotionDiv
                    key={provider}
                    className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                    animate={{ y: [0, -3, 0] }}
                    transition={{
                      duration: 3.4,
                      repeat: Infinity,
                      delay: index * 0.25,
                      ease: "easeInOut",
                    }}
                  >
                    <p className="text-sm font-semibold text-slate-950">{provider}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {index === 0
                        ? "fast"
                        : index === 1
                          ? "quality"
                          : index === 2
                            ? "low cost"
                            : "latency"}
                    </p>
                  </MotionDiv>
                ))}
              </div>
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

function Node({ label, tone }: { readonly label: string; readonly tone: "muted" | "accent" }) {
  return (
    <div
      className={`mx-auto flex h-14 w-full max-w-xs items-center justify-center rounded-xl border text-sm font-semibold ${
        tone === "accent"
          ? "border-blue-200 bg-blue-600 text-white shadow-lg shadow-blue-600/20"
          : "border-slate-200 bg-slate-50 text-slate-950"
      }`}
    >
      {label}
    </div>
  );
}

function FlowLine() {
  return (
    <div className="relative mx-auto h-12 w-px bg-slate-200">
      <MotionDiv
        className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full bg-blue-600"
        animate={{ y: [0, 40, 0], opacity: [0, 1, 0] }}
        transition={{ duration: 2.1, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}
