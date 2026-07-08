import clsx from "clsx";
import type { ReactNode } from "react";

export function Card({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section
      className={clsx(
        "rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  action,
  description,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
      <div>
        <h2 className="text-sm font-semibold text-slate-950 dark:text-white">{title}</h2>
        {description ? (
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly tone?: "neutral" | "good" | "warn" | "info";
}) {
  return (
    <Card className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
        <span
          className={clsx(
            "h-2 w-2 rounded-full",
            tone === "good" && "bg-emerald-500",
            tone === "warn" && "bg-amber-500",
            tone === "info" && "bg-cyan-500",
            tone === "neutral" && "bg-slate-300 dark:bg-slate-700",
          )}
        />
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-normal text-slate-950 dark:text-white">
        {value}
      </p>
      {detail ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail}</p> : null}
    </Card>
  );
}

export function StatusBadge({ value }: { readonly value: string }) {
  const normalized = value.toLowerCase();
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium",
        (normalized === "healthy" || normalized === "success" || normalized === "closed") &&
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
        (normalized === "degraded" || normalized === "half_open") &&
          "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
        (normalized === "down" || normalized === "failed" || normalized === "open") &&
          "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
        ![
          "healthy",
          "success",
          "closed",
          "degraded",
          "half_open",
          "down",
          "failed",
          "open",
        ].includes(normalized) &&
          "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
      )}
    >
      {value.replace("_", " ")}
    </span>
  );
}

export function EmptyState({ label }: { readonly label: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
      {label}
    </div>
  );
}

export function LoadingPanel() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-4 w-32 rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-28 rounded bg-slate-200 dark:bg-slate-800" />
    </div>
  );
}
