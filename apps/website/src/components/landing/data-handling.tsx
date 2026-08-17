import { Database, KeyRound, ScrollText, ShieldCheck } from "lucide-react";
import { FadeIn } from "./motion";
import { Section } from "./section";

const commitments = [
  {
    title: "Prompt logging is a workspace toggle",
    description:
      "On by default. Turn it off from a workspace's Data Retention settings or the API, and RouteMind skips response caching entirely for that workspace -- no prompt text or response body gets stored, full stop.",
    icon: Database,
  },
  {
    title: "Your provider keys stay in your workspace",
    description:
      "Provider credentials are encrypted at rest and scoped to the workspace that added them -- never shared across workspaces, and only ever decrypted to make the call you asked for.",
    icon: KeyRound,
  },
  {
    title: "Every admin action is audited",
    description:
      "Role changes, credential edits, and policy changes each write an audit event in the same database transaction as the change itself, so there's no window where a mutation can happen without a record.",
    icon: ScrollText,
  },
  {
    title: "Limits are enforced, not just monitored",
    description:
      "Budgets, per-model restrictions, and plan limits are evaluated by one declarative policy engine on every request -- the same engine that decided your last blocked or allowed call, not a chart you have to take on faith.",
    icon: ShieldCheck,
  },
] as const;

export function DataHandling() {
  return (
    <Section
      id="data-handling"
      eyebrow="Data & Trust"
      title="What we log, what we don't, and who's in control"
      description="Every claim below maps to a feature that's live in the product today, backed by real tests -- not a policy document."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {commitments.map((item, index) => {
          const Icon = item.icon;
          return (
            <FadeIn key={item.title} delay={Math.min(index * 0.05, 0.15)}>
              <article className="h-full rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-base font-semibold text-slate-950">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{item.description}</p>
              </article>
            </FadeIn>
          );
        })}
      </div>
    </Section>
  );
}
