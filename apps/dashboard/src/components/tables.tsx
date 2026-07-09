"use client";

import { formatDateTime, formatLatency, formatMoney, formatPercent } from "../lib/format";
import type {
  CircuitBreaker,
  ErrorAnalytics,
  ModelAnalytics,
  ProviderAnalytics,
  ProviderAttempt,
  ProviderHealthModel,
  RecentRequest,
} from "../lib/types";
import { Card, CardHeader, EmptyState, StatusBadge } from "./ui";

export function ModelTable({ models }: { readonly models: readonly ModelAnalytics[] }) {
  return (
    <Card>
      <CardHeader title="Model usage and routing performance" />
      {models.length === 0 ? (
        <div className="p-4">
          <EmptyState label="No model data yet" />
        </div>
      ) : (
        <Table
          headers={["Model", "Provider", "Requests", "Success", "Spend", "Avg latency"]}
          rows={models.map((model) => [
            model.model,
            model.provider ?? "unknown",
            model.requests.toLocaleString(),
            formatPercent(model.successRate),
            formatMoney(model.totalSpendUsd),
            formatLatency(model.averageLatencyMs),
          ])}
        />
      )}
    </Card>
  );
}

export function ProviderTable({ providers }: { readonly providers: readonly ProviderAnalytics[] }) {
  return (
    <Card>
      <CardHeader title="Provider analytics" />
      {providers.length === 0 ? (
        <div className="p-4">
          <EmptyState label="No provider data yet" />
        </div>
      ) : (
        <Table
          headers={["Provider", "Requests", "Success", "Spend", "Avg latency"]}
          rows={providers.map((provider) => [
            provider.provider,
            provider.requests.toLocaleString(),
            formatPercent(provider.successRate),
            formatMoney(provider.totalSpendUsd),
            formatLatency(provider.averageLatencyMs),
          ])}
        />
      )}
    </Card>
  );
}

export function ErrorTable({ errors }: { readonly errors: readonly ErrorAnalytics[] }) {
  return (
    <Card>
      <CardHeader title="Error breakdown" />
      {errors.length === 0 ? (
        <div className="p-4">
          <EmptyState label="No errors in this range" />
        </div>
      ) : (
        <Table
          headers={["Error", "Provider", "Model", "Type", "Count"]}
          rows={errors.map((error) => [
            error.errorMessage,
            error.provider ?? "-",
            error.model ?? "-",
            error.errorType ?? "-",
            error.count.toLocaleString(),
          ])}
        />
      )}
    </Card>
  );
}

export function ProviderHealthTable({
  provider,
  models,
}: {
  readonly provider: string;
  readonly models: readonly ProviderHealthModel[];
}) {
  return (
    <Card>
      <CardHeader title={`${provider} health`} />
      {models.length === 0 ? (
        <div className="p-4">
          <EmptyState label="No health samples yet" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                {["Model", "Status", "Avg", "P95", "Success", "Errors", "Samples"].map((header) => (
                  <th key={header} className="px-4 py-3 font-semibold">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {models.map((model) => (
                <tr key={model.model}>
                  <td className="px-4 py-3 font-medium text-slate-950 dark:text-white">
                    {model.model}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge value={model.status} />
                  </td>
                  <td className="px-4 py-3">{formatLatency(model.avgLatencyMs)}</td>
                  <td className="px-4 py-3">{formatLatency(model.p95LatencyMs)}</td>
                  <td className="px-4 py-3">{formatPercent(model.successRate)}</td>
                  <td className="px-4 py-3">{formatPercent(model.errorRate)}</td>
                  <td className="px-4 py-3">{model.sampleSize.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function CircuitBreakerTable({
  circuitBreakers,
}: {
  readonly circuitBreakers: readonly CircuitBreaker[];
}) {
  return (
    <Card>
      <CardHeader title="Circuit breakers" />
      {circuitBreakers.length === 0 ? (
        <div className="p-4">
          <EmptyState label="No circuit breaker state yet" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                {["Provider", "Model", "State", "Failures", "Updated"].map((header) => (
                  <th key={header} className="px-4 py-3 font-semibold">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {circuitBreakers.map((breaker) => (
                <tr key={breaker.id}>
                  <td className="px-4 py-3">{breaker.provider}</td>
                  <td className="px-4 py-3 font-medium text-slate-950 dark:text-white">
                    {breaker.model}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge value={breaker.state} />
                  </td>
                  <td className="px-4 py-3">{breaker.failureCount}</td>
                  <td className="px-4 py-3">{formatDateTime(breaker.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function AttemptTable({ attempts }: { readonly attempts: readonly ProviderAttempt[] }) {
  return (
    <Card>
      <CardHeader title="Provider attempt history" />
      {attempts.length === 0 ? (
        <div className="p-4">
          <EmptyState label="No provider attempts yet" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                {["Time", "Provider", "Model", "Attempt", "Status", "Latency", "Error"].map(
                  (header) => (
                    <th key={header} className="px-4 py-3 font-semibold">
                      {header}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {attempts.map((attempt) => (
                <tr key={attempt.id}>
                  <td className="px-4 py-3">{formatDateTime(attempt.createdAt)}</td>
                  <td className="px-4 py-3">{attempt.provider}</td>
                  <td className="px-4 py-3 font-medium text-slate-950 dark:text-white">
                    {attempt.model}
                  </td>
                  <td className="px-4 py-3">{attempt.attemptNumber}</td>
                  <td className="px-4 py-3">
                    <StatusBadge value={attempt.status} />
                  </td>
                  <td className="px-4 py-3">{formatLatency(attempt.latencyMs)}</td>
                  <td className="px-4 py-3">{attempt.errorType ?? attempt.errorMessage ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function RequestTable({ requests }: { readonly requests: readonly RecentRequest[] }) {
  return (
    <Card>
      <CardHeader title="Recent requests" />
      {requests.length === 0 ? (
        <div className="p-4">
          <EmptyState label="No request logs yet" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                {[
                  "Time",
                  "Requested",
                  "Selected",
                  "Provider",
                  "Status",
                  "Latency",
                  "Cost",
                  "Mode",
                  "Strategy",
                ].map((header) => (
                  <th key={header} className="px-4 py-3 font-semibold">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {requests.map((request) => (
                <tr key={request.id}>
                  <td className="px-4 py-3">{formatDateTime(request.timestamp)}</td>
                  <td className="px-4 py-3">{request.requestedModel}</td>
                  <td className="px-4 py-3 font-medium text-slate-950 dark:text-white">
                    {request.selectedModel ?? "-"}
                  </td>
                  <td className="px-4 py-3">{request.provider ?? "-"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge value={request.status} />
                  </td>
                  <td className="px-4 py-3">{formatLatency(request.latencyMs)}</td>
                  <td className="px-4 py-3">{formatMoney(request.costUsd ?? 0)}</td>
                  <td className="px-4 py-3">{request.routingMode ?? "-"}</td>
                  <td className="px-4 py-3">{request.routingStrategy ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Table({
  headers,
  rows,
}: {
  readonly headers: readonly string[];
  readonly rows: readonly string[][];
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
            <tr key={`${row[0]}-${rowIndex}`}>
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
