"use client";

import { useEffect, useState } from "react";
import { sampleDashboardData } from "./sample-data";
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
          getJson<AnalyticsSummary>("/v1/analytics/summary"),
          getJson<{ models: readonly ModelAnalytics[] }>("/v1/analytics/models"),
          getJson<{ providers: readonly ProviderAnalytics[] }>("/v1/analytics/providers"),
          getJson<{ errors: readonly ErrorAnalytics[] }>("/v1/analytics/errors"),
          getJson<{ costs: readonly CostPoint[] }>("/v1/analytics/costs"),
          getJson<{ latency: readonly LatencyPoint[] }>("/v1/analytics/latency"),
          getJson<ProviderHealthResponse>("/v1/health/providers"),
          getJson<CircuitBreakerResponse>("/v1/resilience/circuit-breakers"),
          getJson<ProviderAttemptsResponse>("/v1/resilience/provider-attempts?limit=50"),
          getJson<RecentRequestsResponse>("/v1/analytics/requests?limit=50"),
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
  });

  if (!response.ok) {
    throw new Error(`RouteMind API ${path} returned ${response.status}.`);
  }

  return (await response.json()) as TValue;
}
