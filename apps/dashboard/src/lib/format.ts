export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 10 ? 0 : 3,
  }).format(value);
}

export function formatLatency(value: number): string {
  return `${formatNumber(value)} ms`;
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
