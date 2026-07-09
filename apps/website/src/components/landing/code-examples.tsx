"use client";

import { Copy } from "lucide-react";
import { useState } from "react";
import { codeExamples } from "./data";
import { FadeIn } from "./motion";
import { Section } from "./section";

const tabs = Object.keys(codeExamples) as Array<keyof typeof codeExamples>;

type ClipboardGlobal = typeof globalThis & {
  readonly clipboard?: {
    readonly writeText: (text: string) => Promise<void>;
  };
  readonly navigator?: {
    readonly clipboard?: {
      readonly writeText: (text: string) => Promise<void>;
    };
  };
};

export function CodeExamples() {
  const [active, setActive] = useState<(typeof tabs)[number]>("OpenAI SDK");
  const copyActiveExample = () => {
    const clipboardGlobal = globalThis as ClipboardGlobal;
    const clipboard = clipboardGlobal.navigator?.clipboard ?? clipboardGlobal.clipboard;
    void clipboard?.writeText(codeExamples[active]);
  };

  return (
    <Section
      id="sdk"
      className="bg-slate-50"
      title="Use RouteMind from any workflow"
      description="Point your OpenAI client at RouteMind, use the TypeScript SDK, call the REST API, or work from the CLI."
    >
      <FadeIn>
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 p-2">
            {tabs.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActive(tab)}
                className={`shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                  active === tab
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-slate-600 hover:bg-white/70 hover:text-slate-950"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="relative bg-slate-950">
            <button
              type="button"
              className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-slate-300 transition hover:bg-white/10 hover:text-white"
              aria-label="Copy code example"
              onClick={copyActiveExample}
            >
              <Copy className="h-4 w-4" />
            </button>
            <pre className="overflow-x-auto p-6 text-sm leading-7 text-slate-100">
              <code>{codeExamples[active]}</code>
            </pre>
          </div>
        </div>
      </FadeIn>
    </Section>
  );
}
