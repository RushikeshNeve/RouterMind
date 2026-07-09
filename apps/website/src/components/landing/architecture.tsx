import { BarChart3, Code2, KeyRound, Settings2 } from "lucide-react";
import { FadeIn } from "./motion";
import { Section } from "./section";

const requestFlow = [
  "Send AI Request",
  "Authenticate API Key",
  "Check Prompt Firewall",
  "Check Cache",
  "Route to Best Model",
];

const routingUseCases = [
  "Apply Cost & Budget Rules",
  "Retry / Fallback Provider",
  "Call LLM Provider",
];

const adminUseCases = ["View Analytics", "Manage Provider Keys", "Monitor Provider Health"];
const providerUseCases = ["OpenAI", "Anthropic", "Gemini", "Groq"];

function UseCasePill({ children }: { readonly children: string }) {
  return (
    <div className="flex min-h-12 items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-center text-xs font-semibold leading-snug text-[#061B49] shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-[#0B5FFF]/45 hover:shadow-md">
      {children}
    </div>
  );
}

function ActorCard({
  title,
  subtitle,
  variant = "client",
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly variant?: "client" | "admin";
}) {
  const Icon = variant === "client" ? Code2 : Settings2;

  return (
    <div className="rounded-2xl border border-blue-100 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#061B49] text-white">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-5 text-[#061B49]">{title}</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}

function DesktopConnectors() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full text-[#0B5FFF]"
      preserveAspectRatio="none"
      viewBox="0 0 1200 640"
    >
      <defs>
        <marker
          id="architecture-arrow"
          markerHeight="8"
          markerWidth="8"
          orient="auto"
          refX="7"
          refY="4"
          viewBox="0 0 8 8"
        >
          <path d="M0 0 L8 4 L0 8 Z" fill="currentColor" />
        </marker>
      </defs>
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.5">
        <path d="M180 292 C210 292 215 165 245 165" markerEnd="url(#architecture-arrow)" />
        <path d="M365 165 H378" markerEnd="url(#architecture-arrow)" />
        <path d="M493 165 H506" markerEnd="url(#architecture-arrow)" />
        <path d="M621 165 H634" markerEnd="url(#architecture-arrow)" />
        <path d="M749 165 H762" markerEnd="url(#architecture-arrow)" />

        <path d="M820 190 C820 245 368 245 368 290" markerEnd="url(#architecture-arrow)" />
        <path d="M820 190 C820 245 588 245 588 290" markerEnd="url(#architecture-arrow)" />
        <path d="M690 290 H763" markerEnd="url(#architecture-arrow)" />
        <path d="M870 290 C930 290 965 236 1024 236" markerEnd="url(#architecture-arrow)" />
        <path d="M870 290 C930 290 970 292 1024 292" markerEnd="url(#architecture-arrow)" />
        <path d="M870 290 C930 290 965 348 1024 348" markerEnd="url(#architecture-arrow)" />
        <path d="M870 290 C930 290 955 405 1024 405" markerEnd="url(#architecture-arrow)" />

        <path d="M920 548 C850 548 820 462 745 462" markerEnd="url(#architecture-arrow)" />
        <path d="M920 548 C850 548 642 462 567 462" markerEnd="url(#architecture-arrow)" />
        <path d="M920 548 C820 548 465 462 390 462" markerEnd="url(#architecture-arrow)" />
      </g>
    </svg>
  );
}

function MobileConnector() {
  return (
    <div className="flex justify-center py-2" aria-hidden="true">
      <svg className="h-10 w-5 text-[#0B5FFF]" viewBox="0 0 20 40">
        <path d="M10 2 V31" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        <path d="M5 26 L10 34 L15 26" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
    </div>
  );
}

export function Architecture() {
  return (
    <Section
      id="architecture"
      className="bg-slate-50"
      title="A clean control layer between your app and every model"
      description="RouteMind keeps provider decisions, guardrails, resilience, and telemetry outside application code."
    >
      <FadeIn>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6 lg:p-8">
          <div className="hidden lg:block">
            <div className="relative min-h-[640px] overflow-hidden rounded-2xl border border-blue-100 bg-[linear-gradient(180deg,#ffffff_0%,#f7fbff_100%)]">
              <DesktopConnectors />

              <div className="absolute left-6 top-[248px] w-[176px]">
                <ActorCard title="Developer / Client App" subtitle="Initiates requests" />
              </div>

              <div className="absolute left-[230px] top-8 w-[670px] rounded-2xl border border-blue-100 bg-white/95 p-5 shadow-sm">
                <div className="mb-5 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-[#0B5FFF]">RouteMind AI Gateway</p>
                    <h3 className="mt-1 text-xl font-semibold tracking-tight text-[#061B49]">
                      Request, routing, and operations use cases
                    </h3>
                  </div>
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-blue-100 bg-blue-50 text-[#0B5FFF]">
                    <KeyRound className="h-5 w-5" />
                  </span>
                </div>

                <div className="grid grid-cols-5 gap-3">
                  {requestFlow.map((useCase) => (
                    <UseCasePill key={useCase}>{useCase}</UseCasePill>
                  ))}
                </div>

                <div className="mt-12 grid grid-cols-3 gap-4 px-12">
                  {routingUseCases.map((useCase) => (
                    <UseCasePill key={useCase}>{useCase}</UseCasePill>
                  ))}
                </div>

                <div className="mt-12 border-t border-slate-200 pt-6">
                  <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    <BarChart3 className="h-4 w-4 text-[#0B5FFF]" />
                    Operator console
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    {adminUseCases.map((useCase) => (
                      <UseCasePill key={useCase}>{useCase}</UseCasePill>
                    ))}
                  </div>
                </div>
              </div>

              <div className="absolute right-8 top-[132px] w-[240px] rounded-2xl border border-blue-100 bg-blue-50/80 p-5 shadow-sm">
                <p className="mb-4 text-sm font-semibold text-[#061B49]">LLM Providers</p>
                <div className="grid gap-3">
                  {providerUseCases.map((provider) => (
                    <UseCasePill key={provider}>{provider}</UseCasePill>
                  ))}
                </div>
              </div>

              <div className="absolute bottom-8 right-8 w-[240px]">
                <ActorCard
                  title="Admin / Operator"
                  subtitle="Manages keys, health, and analytics"
                  variant="admin"
                />
              </div>
            </div>
          </div>

          <div className="lg:hidden">
            <div className="rounded-2xl border border-blue-100 bg-[linear-gradient(180deg,#ffffff_0%,#f7fbff_100%)] p-4">
              <ActorCard title="Developer / Client App" subtitle="Initiates requests" />
              <MobileConnector />

              <div className="rounded-2xl border border-blue-100 bg-white p-4 shadow-sm">
                <p className="text-sm font-semibold text-[#0B5FFF]">RouteMind AI Gateway</p>
                <div className="mt-4 grid gap-3">
                  {requestFlow.map((useCase, index) => (
                    <div key={useCase}>
                      <UseCasePill>{useCase}</UseCasePill>
                      {index < requestFlow.length - 1 ? <MobileConnector /> : null}
                    </div>
                  ))}
                </div>

                <div className="mt-5 grid gap-3 border-t border-slate-200 pt-5">
                  {routingUseCases.map((useCase, index) => (
                    <div key={useCase}>
                      <UseCasePill>{useCase}</UseCasePill>
                      {index < routingUseCases.length - 1 ? <MobileConnector /> : null}
                    </div>
                  ))}
                </div>

                <div className="mt-5 border-t border-slate-200 pt-5">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Operator console
                  </p>
                  <div className="grid gap-3">
                    {adminUseCases.map((useCase) => (
                      <UseCasePill key={useCase}>{useCase}</UseCasePill>
                    ))}
                  </div>
                </div>
              </div>

              <MobileConnector />
              <div className="rounded-2xl border border-blue-100 bg-blue-50/80 p-4 shadow-sm">
                <p className="mb-3 text-sm font-semibold text-[#061B49]">LLM Providers</p>
                <div className="grid gap-3">
                  {providerUseCases.map((provider) => (
                    <UseCasePill key={provider}>{provider}</UseCasePill>
                  ))}
                </div>
              </div>

              <MobileConnector />
              <ActorCard
                title="Admin / Operator"
                subtitle="Manages keys, health, and analytics"
                variant="admin"
              />
            </div>
          </div>
        </div>
      </FadeIn>
    </Section>
  );
}
