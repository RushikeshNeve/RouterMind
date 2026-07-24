"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell, PageBanner } from "../../../components/app-shell";
import { Card, CardHeader, EmptyState, LoadingPanel, MetricCard } from "../../../components/ui";
import { permissionRequirementLabel, usePermissions } from "../../../lib/permissions-context";
import {
  createBillingCheckout,
  getActiveWorkspace,
  getBillingOverview,
  listPlans,
  type ActiveWorkspace,
  type BillingOverview,
  type Plan,
} from "../../../lib/workspace-client";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

// Paddle.js has no official types published for a lightweight, no-SDK
// install like this one -- narrowly typed to just what's actually called
// here rather than pulling in @paddle/paddle-js for three method calls.
declare global {
  interface Window {
    Paddle?: {
      Environment: { set(env: "sandbox" | "production"): void };
      Initialize(options: { token: string }): void;
      Checkout: { open(options: { transactionId: string }): void };
    };
  }
}

const PADDLE_JS_URL = "https://cdn.paddle.com/paddle/v2/paddle.js";

function loadPaddleJs(): Promise<void> {
  if (window.Paddle) return Promise.resolve();
  const existing = document.querySelector(`script[src="${PADDLE_JS_URL}"]`);
  if (existing) {
    return new Promise((resolve) => existing.addEventListener("load", () => resolve()));
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PADDLE_JS_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Paddle.js."));
    document.head.appendChild(script);
  });
}

function formatPrice(priceCents: number): string {
  return `$${(priceCents / 100).toFixed(2)}/mo`;
}

function isContactSales(plan: {
  readonly selfServe: boolean;
  readonly featuresJson: unknown;
}): boolean {
  return (
    !plan.selfServe &&
    typeof plan.featuresJson === "object" &&
    plan.featuresJson !== null &&
    (plan.featuresJson as Record<string, unknown>).contactSales === true
  );
}

export default function BillingPage() {
  const { permissions, isLoading: permissionsLoading, organizationId } = usePermissions();
  const canManage = permissionsLoading || permissions.has("billing.manage");
  const manageTitle = canManage ? undefined : permissionRequirementLabel("billing.manage");

  const [workspace, setWorkspace] = useState<ActiveWorkspace | undefined>();
  const [overview, setOverview] = useState<BillingOverview | undefined>();
  const [plans, setPlans] = useState<readonly Plan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [checkoutPlanName, setCheckoutPlanName] = useState<string | undefined>();

  const reload = useCallback((orgId: string) => {
    setIsLoading(true);
    setError(undefined);
    Promise.all([getBillingOverview(orgId), listPlans()])
      .then(([overviewResult, plansResult]) => {
        setOverview(overviewResult);
        setPlans(plansResult.plans);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load billing information.");
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    setWorkspace(getActiveWorkspace());
  }, []);

  useEffect(() => {
    if (!organizationId) return;
    reload(organizationId);
  }, [organizationId, reload]);

  async function handleUpgrade(plan: Plan) {
    if (!organizationId) return;
    setCheckoutPlanName(plan.name);
    setError(undefined);
    try {
      const checkout = await createBillingCheckout(organizationId, plan.name);
      await loadPaddleJs();
      if (!window.Paddle) {
        throw new Error("Paddle.js did not load.");
      }
      if (checkout.environment === "sandbox") {
        window.Paddle.Environment.set("sandbox");
      }
      if (!checkout.clientToken) {
        throw new Error(
          "No Paddle client token was returned -- billing isn't fully configured yet.",
        );
      }
      window.Paddle.Initialize({ token: checkout.clientToken });
      window.Paddle.Checkout.open({ transactionId: checkout.transactionId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start checkout.");
    } finally {
      setCheckoutPlanName(undefined);
    }
  }

  return (
    <AppShell
      title="Billing"
      description={workspace ? `Plan and usage for ${workspace.name}` : "Plan and usage"}
      isDemo={false}
      apiBaseUrl={apiBaseUrl}
    >
      <PageBanner message={error} />
      {!workspace ? (
        <EmptyState label="No active workspace. Accept a workspace invite to get started." />
      ) : isLoading || !overview ? (
        <LoadingPanel />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <MetricCard
              label="Current plan"
              value={overview.plan.name}
              detail={
                isContactSales(overview.plan)
                  ? "Custom pricing -- contact sales"
                  : formatPrice(overview.plan.priceCents)
              }
            />
            <MetricCard
              label="Requests this period"
              value={overview.usage.requestCount.toLocaleString("en-US")}
              detail={
                overview.plan.includedRequests === null
                  ? "Unlimited"
                  : `of ${overview.plan.includedRequests.toLocaleString("en-US")} included`
              }
              tone={
                overview.plan.includedRequests !== null &&
                overview.usage.requestCount >= overview.plan.includedRequests
                  ? "warn"
                  : "neutral"
              }
            />
            <MetricCard
              label="Subscription status"
              value={overview.subscription?.status ?? "n/a"}
              detail={overview.subscription ? undefined : "No active subscription (Free tier)"}
            />
          </div>

          <Card>
            <CardHeader
              title="Payment method & invoices"
              description="Paddle is our merchant of record and hosts your receipts and payment details directly -- there's nothing of ours to show here."
            />
          </Card>

          <Card>
            <CardHeader
              title="Available plans"
              description="Upgrading opens Paddle's secure checkout. Downgrades take effect at the end of the current billing period."
            />
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
              {plans.map((plan) => {
                const isCurrent = plan.name === overview.plan.name;
                const contactSales = isContactSales(plan);
                return (
                  <div
                    key={plan.id}
                    className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
                  >
                    <p className="text-sm font-semibold text-slate-950 dark:text-white">
                      {plan.name}
                    </p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {contactSales ? "Custom pricing" : formatPrice(plan.priceCents)}
                    </p>
                    <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                      {plan.includedRequests === null
                        ? "Unlimited requests"
                        : `${plan.includedRequests.toLocaleString("en-US")} requests/mo`}
                    </p>
                    {isCurrent ? (
                      <p className="mt-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        Current plan
                      </p>
                    ) : contactSales ? (
                      <a
                        href="mailto:sales@routemind.example"
                        className="mt-3 inline-block text-xs font-medium text-slate-700 underline dark:text-slate-300"
                      >
                        Contact sales
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled={!canManage || checkoutPlanName !== undefined}
                        title={manageTitle}
                        onClick={() => {
                          void handleUpgrade(plan);
                        }}
                        className="mt-3 rounded-md bg-slate-950 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
                      >
                        {checkoutPlanName === plan.name
                          ? "Starting checkout…"
                          : `Switch to ${plan.name}`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
