"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardHeader, EmptyState } from "./ui";
import type { CostPoint, LatencyPoint, ModelAnalytics, ProviderAnalytics } from "../lib/types";

const palette = ["#0f9f91", "#2563eb", "#d8952f", "#7c3aed", "#ef4444", "#14b8a6"];

export function SpendChart({ data }: { readonly data: readonly CostPoint[] }) {
  return (
    <Card className="min-h-80">
      <CardHeader title="Spend over time" description="Daily estimated spend from request logs" />
      <div className="h-64 p-4">
        {data.length === 0 ? (
          <EmptyState label="No cost data yet" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Area
                type="monotone"
                dataKey="spendUsd"
                stroke="#0f9f91"
                fill="#d8fff8"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

export function RequestsChart({ data }: { readonly data: readonly CostPoint[] }) {
  return (
    <Card className="min-h-80">
      <CardHeader title="Requests over time" description="Daily request volume" />
      <div className="h-64 p-4">
        {data.length === 0 ? (
          <EmptyState label="No request data yet" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Bar
                dataKey="requests"
                fill="#2563eb"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

export function ProviderDistribution({ data }: { readonly data: readonly ProviderAnalytics[] }) {
  return (
    <Card>
      <CardHeader title="Provider distribution" />
      <div className="h-64 p-4">
        {data.length === 0 ? (
          <EmptyState label="No provider usage yet" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="requests"
                nameKey="provider"
                innerRadius={54}
                outerRadius={88}
                isAnimationActive={false}
              >
                {data.map((item, index) => (
                  <Cell key={item.provider} fill={palette[index % palette.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

export function ModelUsageBars({ data }: { readonly data: readonly ModelAnalytics[] }) {
  return (
    <Card>
      <CardHeader title="Model usage" />
      <div className="h-64 p-4">
        {data.length === 0 ? (
          <EmptyState label="No model usage yet" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 28 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" />
              <YAxis dataKey="model" type="category" width={116} />
              <Tooltip />
              <Bar
                dataKey="requests"
                fill="#0f9f91"
                radius={[0, 4, 4, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

export function LatencyChart({ data }: { readonly data: readonly LatencyPoint[] }) {
  return (
    <Card>
      <CardHeader title="Latency trend" description="Average and p95 latency by day/provider" />
      <div className="h-72 p-4">
        {data.length === 0 ? (
          <EmptyState label="No latency data yet" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="averageLatencyMs"
                stroke="#2563eb"
                strokeWidth={2}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p95LatencyMs"
                stroke="#d8952f"
                strokeWidth={2}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}
