"use client";

import {
  Activity,
  CircuitBoard,
  Clock3,
  Coins,
  DatabaseZap,
  Gauge,
  HeartPulse,
  Repeat2,
} from "lucide-react";
import { AppShell, PageBanner } from "./app-shell";
import {
  LatencyChart,
  ModelUsageBars,
  ProviderDistribution,
  RequestsChart,
  SpendChart,
} from "./charts";
import {
  AttemptTable,
  CircuitBreakerTable,
  ErrorTable,
  ModelTable,
  ProviderHealthTable,
  ProviderTable,
  RequestTable,
} from "./tables";
import { LoadingPanel, MetricCard } from "./ui";
import { Card, CardHeader, EmptyState, StatusBadge } from "./ui";
import { useDashboardData } from "../lib/api";
import {
  formatDateTime,
  formatLatency,
  formatMoney,
  formatNumber,
  formatPercent,
} from "../lib/format";

type DashboardPage =
  | "overview"
  | "analytics"
  | "models"
  | "providers"
  | "costs"
  | "resilience"
  | "evaluations"
  | "requests";

const pageMeta: Record<DashboardPage, { readonly title: string; readonly description: string }> = {
  overview: {
    title: "Operations overview",
    description: "Live control surface for RouteMind traffic, spend, reliability, and routing.",
  },
  analytics: {
    title: "Analytics",
    description: "Detailed usage, error, cost, and latency breakdowns from gateway logs.",
  },
  models: {
    title: "Models",
    description: "Model usage, spend, success rate, and routing performance.",
  },
  providers: {
    title: "Providers",
    description: "Provider health, reliability, latency, and model-level status.",
  },
  costs: {
    title: "Costs",
    description: "Spend trends, budget pressure, quota signals, and expensive models.",
  },
  resilience: {
    title: "Resilience",
    description: "Retries, fallback behavior, provider attempts, and circuit breaker state.",
  },
  evaluations: {
    title: "Evaluations",
    description: "Datasets, benchmark runs, and quality scores that influence routing.",
  },
  requests: {
    title: "Requests",
    description: "Recent gateway requests with routing, latency, cost, and status.",
  },
};

export function DashboardView({ page }: { readonly page: DashboardPage }) {
  const { data, isLoading, apiBaseUrl } = useDashboardData();
  const meta = pageMeta[page];

  return (
    <AppShell
      title={meta.title}
      description={meta.description}
      isDemo={data.isDemo}
      apiBaseUrl={apiBaseUrl}
    >
      <PageBanner message={data.isDemo ? data.error : undefined} />
      {isLoading ? <LoadingPanel /> : renderPage(page, data)}
    </AppShell>
  );
}

function renderPage(page: DashboardPage, data: ReturnType<typeof useDashboardData>["data"]) {
  switch (page) {
    case "analytics":
      return <AnalyticsPage data={data} />;
    case "models":
      return <ModelsPage data={data} />;
    case "providers":
      return <ProvidersPage data={data} />;
    case "costs":
      return <CostsPage data={data} />;
    case "resilience":
      return <ResiliencePage data={data} />;
    case "evaluations":
      return <EvaluationsPage data={data} />;
    case "requests":
      return <RequestsPage data={data} />;
    case "overview":
    default:
      return <OverviewPage data={data} />;
  }
}

function OverviewPage({ data }: { readonly data: ReturnType<typeof useDashboardData>["data"] }) {
  const activeProviders = data.health.providers.length || data.providers.length;
  const fallbackRate =
    data.summary.requests.total === 0
      ? 0
      : data.summary.routing.fallbackUsed / data.summary.requests.total;
  const budgetUsage = estimateBudgetUsage(data.summary.cost.totalSpendUsd);

  return (
    <div className="space-y-5">
      <MetricGrid
        metrics={[
          ["Total requests", formatNumber(data.summary.requests.total), "Gateway traffic", "info"],
          [
            "Success rate",
            formatPercent(data.summary.requests.successRate),
            "Completed requests",
            "good",
          ],
          [
            "Total spend",
            formatMoney(data.summary.cost.totalSpendUsd),
            "Estimated cost",
            "neutral",
          ],
          ["Total tokens", formatNumber(data.summary.tokens.total), "Input + output", "neutral"],
          [
            "Avg latency",
            formatLatency(data.summary.latency.averageMs),
            "Request duration",
            "warn",
          ],
          ["Fallback rate", formatPercent(fallbackRate), "Provider failover", "info"],
          ["Active providers", formatNumber(activeProviders), "Configured sources", "good"],
          ["Budget usage", formatPercent(budgetUsage), "Synthetic dashboard gauge", "warn"],
        ]}
      />

      <div className="grid gap-5 xl:grid-cols-2">
        <SpendChart data={data.costs} />
        <RequestsChart data={data.costs} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <ProviderDistribution data={data.providers} />
        <ModelUsageBars data={data.models.slice(0, 6)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {data.health.providers.slice(0, 1).map((provider) => (
          <ProviderHealthTable
            key={provider.provider}
            provider={provider.provider}
            models={provider.models}
          />
        ))}
        <RequestTable requests={data.requests.slice(0, 8)} />
      </div>
    </div>
  );
}

function AnalyticsPage({ data }: { readonly data: ReturnType<typeof useDashboardData>["data"] }) {
  return (
    <div className="space-y-5">
      <MetricGrid
        metrics={[
          ["Requests", formatNumber(data.summary.requests.total), "All statuses", "info"],
          ["Failures", formatNumber(data.summary.requests.failed), "Needs attention", "warn"],
          ["Spend", formatMoney(data.summary.cost.totalSpendUsd), "Estimated", "neutral"],
          ["P95 latency", formatLatency(data.summary.latency.p95Ms), "Tail latency", "warn"],
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <SpendChart data={data.costs} />
        <LatencyChart data={data.latency} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <ModelTable models={data.models} />
        <ProviderTable providers={data.providers} />
      </div>
      <ErrorTable errors={data.errors} />
    </div>
  );
}

function ModelsPage({ data }: { readonly data: ReturnType<typeof useDashboardData>["data"] }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <ModelUsageBars data={data.models} />
        <ProviderDistribution data={data.providers} />
      </div>
      <ModelTable models={data.models} />
    </div>
  );
}

function ProvidersPage({ data }: { readonly data: ReturnType<typeof useDashboardData>["data"] }) {
  return (
    <div className="space-y-5">
      <MetricGrid
        metrics={[
          ["Providers", formatNumber(data.health.providers.length), "Reporting health", "good"],
          ["Avg latency", formatLatency(data.summary.latency.averageMs), "Across traffic", "info"],
          [
            "Success rate",
            formatPercent(data.summary.requests.successRate),
            "All providers",
            "good",
          ],
          ["Error count", formatNumber(data.summary.requests.failed), "Failed requests", "warn"],
        ]}
      />
      <ProviderTable providers={data.providers} />
      <div className="grid gap-5 xl:grid-cols-2">
        {data.health.providers.map((provider) => (
          <ProviderHealthTable
            key={provider.provider}
            provider={provider.provider}
            models={provider.models}
          />
        ))}
      </div>
    </div>
  );
}

function CostsPage({ data }: { readonly data: ReturnType<typeof useDashboardData>["data"] }) {
  return (
    <div className="space-y-5">
      <MetricGrid
        metrics={[
          [
            "Total spend",
            formatMoney(data.summary.cost.totalSpendUsd),
            "RequestLog estimate",
            "neutral",
          ],
          ["Avg cost", formatMoney(data.summary.cost.averageCostPerRequest), "Per request", "info"],
          [
            "Budget blocks",
            formatNumber(data.summary.guardrails.budgetBlocked),
            "Guardrail stops",
            "warn",
          ],
          [
            "Quota blocks",
            formatNumber(data.summary.guardrails.quotaBlocked),
            "Guardrail stops",
            "warn",
          ],
        ]}
      />
      <SpendChart data={data.costs} />
      <div className="grid gap-5 xl:grid-cols-2">
        <ModelTable models={data.summary.topModelsBySpend} />
        <ProviderTable providers={data.summary.topProvidersBySpend} />
      </div>
    </div>
  );
}

function ResiliencePage({ data }: { readonly data: ReturnType<typeof useDashboardData>["data"] }) {
  const failedAttempts = data.attempts.filter((attempt) => attempt.status === "failed").length;
  return (
    <div className="space-y-5">
      <MetricGrid
        metrics={[
          [
            "Fallbacks",
            formatNumber(data.summary.routing.fallbackUsed),
            "RouterDecisionLog",
            "info",
          ],
          ["Attempt failures", formatNumber(failedAttempts), "ProviderAttemptLog", "warn"],
          [
            "Circuit events",
            formatNumber(data.summary.resilience?.circuitBreakerTriggered ?? 0),
            "Open skips",
            "warn",
          ],
          ["Breakers", formatNumber(data.circuitBreakers.length), "Tracked models", "neutral"],
        ]}
      />
      <CircuitBreakerTable circuitBreakers={data.circuitBreakers} />
      <AttemptTable attempts={data.attempts} />
    </div>
  );
}

function RequestsPage({ data }: { readonly data: ReturnType<typeof useDashboardData>["data"] }) {
  return <RequestTable requests={data.requests} />;
}

function EvaluationsPage({ data }: { readonly data: ReturnType<typeof useDashboardData>["data"] }) {
  const completedRuns = data.evaluationRuns.filter((run) => run.status === "completed");
  const averageScore =
    completedRuns.length === 0
      ? 0
      : completedRuns.reduce((total, run) => total + run.averageScore, 0) / completedRuns.length;
  const evaluatedCases = completedRuns.reduce((total, run) => total + run.totalCases, 0);

  return (
    <div className="space-y-5">
      <MetricGrid
        metrics={[
          ["Datasets", formatNumber(data.evaluationDatasets.length), "Benchmark suites", "info"],
          ["Runs", formatNumber(data.evaluationRuns.length), "Recent evaluations", "neutral"],
          ["Avg score", formatPercent(averageScore), "Completed runs", "good"],
          ["Cases", formatNumber(evaluatedCases), "Completed cases", "neutral"],
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <EvaluationDatasetTable datasets={data.evaluationDatasets} />
        <EvaluationScoreTable scores={data.evaluationScores} />
      </div>
      <EvaluationRunTable runs={data.evaluationRuns} />
    </div>
  );
}

function EvaluationDatasetTable({
  datasets,
}: {
  readonly datasets: ReturnType<typeof useDashboardData>["data"]["evaluationDatasets"];
}) {
  return (
    <Card>
      <CardHeader title="Evaluation datasets" />
      {datasets.length === 0 ? (
        <div className="p-4">
          <EmptyState label="No evaluation datasets yet" />
        </div>
      ) : (
        <SimpleTable
          headers={["Name", "Task", "Updated"]}
          rows={datasets.map((dataset) => [
            dataset.name,
            dataset.taskType,
            formatDateTime(dataset.updatedAt),
          ])}
        />
      )}
    </Card>
  );
}

function EvaluationScoreTable({
  scores,
}: {
  readonly scores: ReturnType<typeof useDashboardData>["data"]["evaluationScores"];
}) {
  return (
    <Card>
      <CardHeader title="Model scores by task" />
      {scores.length === 0 ? (
        <div className="p-4">
          <EmptyState label="No model scores yet" />
        </div>
      ) : (
        <SimpleTable
          headers={["Task", "Model", "Provider", "Score", "Cases"]}
          rows={scores.map((score) => [
            score.taskType,
            score.model,
            score.provider,
            formatPercent(score.averageScore),
            score.totalCases.toLocaleString(),
          ])}
        />
      )}
    </Card>
  );
}

function EvaluationRunTable({
  runs,
}: {
  readonly runs: ReturnType<typeof useDashboardData>["data"]["evaluationRuns"];
}) {
  return (
    <Card>
      <CardHeader title="Recent evaluation runs" />
      {runs.length === 0 ? (
        <div className="p-4">
          <EmptyState label="No evaluation runs yet" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                {["Model", "Provider", "Status", "Passed", "Score", "Created"].map((header) => (
                  <th key={header} className="px-4 py-3 font-semibold">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="px-4 py-3 font-medium text-slate-950 dark:text-white">
                    {run.model}
                  </td>
                  <td className="px-4 py-3">{run.provider}</td>
                  <td className="px-4 py-3">
                    <StatusBadge value={run.status} />
                  </td>
                  <td className="px-4 py-3">
                    {run.passedCases.toLocaleString()} / {run.totalCases.toLocaleString()}
                  </td>
                  <td className="px-4 py-3">{formatPercent(run.averageScore)}</td>
                  <td className="px-4 py-3">{formatDateTime(run.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SimpleTable({
  headers,
  rows,
}: {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-4 py-3 font-semibold">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
          {rows.map((row, rowIndex) => (
            <tr key={`${row[0] ?? "row"}-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td
                  key={`${cell}-${cellIndex}`}
                  className={
                    cellIndex === 0
                      ? "px-4 py-3 font-medium text-slate-950 dark:text-white"
                      : "px-4 py-3"
                  }
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricGrid({
  metrics,
}: {
  readonly metrics: readonly [string, string, string, "neutral" | "good" | "warn" | "info"][];
}) {
  const icons = [DatabaseZap, Gauge, Coins, Activity, Clock3, Repeat2, HeartPulse, CircuitBoard];
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map(([label, value, detail, tone], index) => {
        const Icon = icons[index % icons.length] ?? Activity;
        return (
          <div key={label} className="relative">
            <MetricCard label={label} value={value} detail={detail} tone={tone} />
            <Icon className="pointer-events-none absolute right-4 top-4 h-4 w-4 text-slate-400" />
          </div>
        );
      })}
    </div>
  );
}

function estimateBudgetUsage(spend: number): number {
  return Math.min(0.99, spend / 500);
}
