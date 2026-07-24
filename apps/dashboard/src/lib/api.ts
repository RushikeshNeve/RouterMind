"use client";

import { useEffect, useState } from "react";
import { sampleDashboardData } from "./sample-data";
import { getActiveWorkspace } from "./workspace-client";
import type {
  AnalyticsSummary,
  CircuitBreakerResponse,
  CostPoint,
  DashboardData,
  ErrorAnalytics,
  EvaluationDataset,
  EvaluationRun,
  EvaluationScore,
  LatencyPoint,
  ModelAnalytics,
  ProviderAnalytics,
  ProviderAttemptsResponse,
  ProviderHealthResponse,
  RecentRequestsResponse,
} from "./types";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

export function useDashboardData() {
  const [data, setData] = useState<DashboardData>(sampleDashboardData);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      setIsLoading(true);
      try {
        const workspace = getActiveWorkspace();
        if (!workspace) {
          throw new Error("No active workspace. Accept a workspace invite to get started.");
        }
        const w = `/v1/workspaces/${workspace.id}`;

        const [
          summary,
          models,
          providers,
          errors,
          costs,
          latency,
          health,
          circuitBreakers,
          attempts,
          requests,
          evaluationDatasets,
          evaluationRuns,
          evaluationScores,
        ] = await Promise.all([
          getJson<AnalyticsSummary>(`${w}/analytics/summary`),
          getJson<{ models: readonly ModelAnalytics[] }>(`${w}/analytics/models`),
          getJson<{ providers: readonly ProviderAnalytics[] }>(`${w}/analytics/providers`),
          getJson<{ errors: readonly ErrorAnalytics[] }>(`${w}/analytics/errors`),
          getJson<{ costs: readonly CostPoint[] }>(`${w}/analytics/costs`),
          getJson<{ latency: readonly LatencyPoint[] }>(`${w}/analytics/latency`),
          getJson<ProviderHealthResponse>("/v1/health/providers"),
          getJson<CircuitBreakerResponse>("/v1/resilience/circuit-breakers"),
          getJson<ProviderAttemptsResponse>(`${w}/resilience/provider-attempts?limit=50`),
          getJson<RecentRequestsResponse>(`${w}/analytics/requests?limit=50`),
          getJson<{ datasets: readonly EvaluationDataset[] }>("/v1/evaluations/datasets"),
          getJson<{ runs: readonly EvaluationRun[] }>("/v1/evaluations/runs"),
          getJson<{ scores: readonly EvaluationScore[] }>("/v1/evaluations/scores"),
        ]);

        if (!isMounted) return;

        setData({
          summary,
          models: models.models,
          providers: providers.providers,
          errors: errors.errors,
          costs: costs.costs,
          latency: latency.latency,
          health,
          circuitBreakers: circuitBreakers.circuitBreakers,
          attempts: attempts.attempts,
          requests: requests.requests,
          evaluationDatasets: evaluationDatasets.datasets,
          evaluationRuns: evaluationRuns.runs,
          evaluationScores: evaluationScores.scores,
          isDemo: false,
        });
      } catch (error) {
        if (!isMounted) return;
        setData({
          ...sampleDashboardData,
          error:
            error instanceof Error
              ? `API unavailable. Showing dashboard demo data. ${error.message}`
              : "API unavailable. Showing dashboard demo data.",
        });
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      isMounted = false;
    };
  }, []);

  return { data, isLoading, apiBaseUrl };
}

async function getJson<TValue>(path: string): Promise<TValue> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { accept: "application/json" },
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`RouteMind API ${path} returned ${response.status}.`);
  }

  return (await response.json()) as TValue;
}
