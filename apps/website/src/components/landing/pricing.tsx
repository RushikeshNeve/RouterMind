"use client";

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { links } from "./data";
import { FadeIn } from "./motion";
import { ButtonLink, Section } from "./section";

// No NEXT_PUBLIC_ROUTEMIND_API_URL exists in this app yet (it's a purely
// static site today) -- falls back to the same live backend already
// hardcoded in data.ts's `links.backend`, matching the code examples above.
const apiBaseUrl = (process.env.NEXT_PUBLIC_ROUTEMIND_API_URL ?? links.backend).replace(/\/$/, "");

interface Plan {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number;
  readonly includedRequests: number | null;
  readonly featuresJson: Record<string, unknown>;
  readonly selfServe: boolean;
}

const ROUTING_MODE_LABELS: Record<string, string> = {
  rule_based: "Rule-based routing",
  score_based: "Score-based routing",
  llm_assisted: "LLM-assisted routing",
};

const FEATURE_LABELS: Record<string, string> = {
  byoRouterModel: "Bring your own router model",
  promptFirewall: "Prompt firewall",
  multiWorkspace: "Multi-workspace support",
  serviceAccounts: "Service accounts",
  policyEngine: "Declarative policy engine",
  auditLog: "Audit log",
  scopedDashboards: "Workspace-scoped dashboards",
  sso: "SSO / SAML",
  dedicatedInfra: "Dedicated infrastructure",
  compliance: "Compliance support",
  customSla: "Custom SLA",
};

// Falls back to a humanized key for any feature flag added to Plan.featuresJson
// later without this label map being updated -- keeps the page additive-safe
// instead of silently hiding new plan features.
function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function planFeatureList(featuresJson: Record<string, unknown>): readonly string[] {
  const routingModes = Array.isArray(featuresJson.routingModes)
    ? featuresJson.routingModes.filter((mode): mode is string => typeof mode === "string")
    : [];
  const routingLabels = routingModes.map((mode) => ROUTING_MODE_LABELS[mode] ?? mode);

  const flagLabels = Object.entries(featuresJson)
    .filter(([key, value]) => key !== "routingModes" && key !== "contactSales" && value === true)
    .map(([key]) => FEATURE_LABELS[key] ?? humanize(key));

  return [...routingLabels, ...flagLabels];
}

// Driven by featuresJson.contactSales (whether this plan has a public,
// fixed price at all), not plan.selfServe -- selfServe reflects whether a
// live Paddle checkout is wired up (Plan.paddlePriceId), a separate concern
// that shouldn't hide a real, known price for Free/Pro/Team.
function isContactSalesOnly(plan: Plan): boolean {
  return plan.featuresJson.contactSales === true;
}

function formatPrice(plan: Plan): { readonly amount: string; readonly suffix: string } {
  if (isContactSalesOnly(plan)) {
    return { amount: "Custom pricing", suffix: "" };
  }
  if (plan.priceCents === 0) {
    return { amount: "$0", suffix: "/mo" };
  }
  return { amount: `$${(plan.priceCents / 100).toFixed(2)}`, suffix: "/mo" };
}

// GET /v1/plans only orders by priceCents ascending -- Enterprise's
// priceCents is 0, same as Free's, so the API alone can't guarantee Free
// sorts before Enterprise. Re-sort here so contact-sales plans always land
// last regardless of their nominal priceCents value.
function sortPlansForDisplay(plans: readonly Plan[]): readonly Plan[] {
  return [...plans].sort((a, b) => {
    const aIsContactSales = isContactSalesOnly(a) ? 1 : 0;
    const bIsContactSales = isContactSalesOnly(b) ? 1 : 0;
    if (aIsContactSales !== bIsContactSales) {
      return aIsContactSales - bIsContactSales;
    }
    return a.priceCents - b.priceCents;
  });
}

function formatIncludedRequests(includedRequests: number | null): string {
  return includedRequests === null
    ? "Unlimited requests"
    : `${includedRequests.toLocaleString("en-US")} requests/mo`;
}

export function Pricing() {
  const [plans, setPlans] = useState<readonly Plan[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let isMounted = true;

    fetch(`${apiBaseUrl}/v1/plans`, { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`RouteMind API returned ${response.status}.`);
        }
        return response.json() as Promise<{ readonly plans: readonly Plan[] }>;
      })
      .then((body) => {
        if (isMounted) setPlans(body.plans);
      })
      .catch((err: unknown) => {
        if (!isMounted) return;
        setError(
          err instanceof Error
            ? `Couldn't load live pricing. ${err.message}`
            : "Couldn't load live pricing.",
        );
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <Section
      id="pricing"
      eyebrow="Pricing"
      title="Simple, predictable pricing"
      description="Loaded live from RouteMind's own Plan table -- what you see below is exactly what the gateway enforces, not a separate marketing claim."
    >
      {error ? (
        <p className="mx-auto max-w-md text-center text-sm text-red-600">{error}</p>
      ) : !plans ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <div
              key={key}
              className="h-96 animate-pulse rounded-2xl border border-slate-200 bg-slate-50"
            />
          ))}
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {sortPlansForDisplay(plans).map((plan, index) => {
            const price = formatPrice(plan);
            const featureList = planFeatureList(plan.featuresJson);
            return (
              <FadeIn key={plan.id} delay={Math.min(index * 0.05, 0.15)}>
                <article
                  className={
                    "flex h-full flex-col rounded-2xl border p-6 shadow-sm " +
                    (plan.name === "Pro"
                      ? "border-blue-600 ring-1 ring-blue-600"
                      : "border-slate-200 bg-white")
                  }
                >
                  <h3 className="text-base font-semibold text-slate-950">{plan.name}</h3>
                  <p className="mt-4 flex items-baseline gap-1">
                    <span className="text-3xl font-semibold tracking-tight text-slate-950">
                      {price.amount}
                    </span>
                    {price.suffix ? (
                      <span className="text-sm text-slate-500">{price.suffix}</span>
                    ) : null}
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    {formatIncludedRequests(plan.includedRequests)}
                  </p>
                  <ul className="mt-6 flex-1 space-y-3">
                    {featureList.map((feature) => (
                      <li key={feature} className="flex items-start gap-2 text-sm text-slate-700">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-6">
                    <ButtonLink
                      href={
                        isContactSalesOnly(plan)
                          ? "mailto:sales@routemind.example"
                          : links.dashboard
                      }
                      variant={plan.name === "Pro" ? "primary" : "secondary"}
                    >
                      {isContactSalesOnly(plan) ? "Contact sales" : "Get started"}
                    </ButtonLink>
                  </div>
                </article>
              </FadeIn>
            );
          })}
        </div>
      )}
    </Section>
  );
}
