/**
 * Costs are tiny (a request is often $0.00003), so a fixed 2 decimals would show
 * most activity as $0.00. Amounts of a dollar or more get cents; smaller ones keep
 * enough precision to be non-zero.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs === 0 || abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export const formatInt = (value: number) => new Intl.NumberFormat("en-US").format(value);

/** Compact token counts for chart axes and stat tiles: 1.2M, 34K. */
export const formatCompact = (value: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);

/** UTC timestamps, like the Worker logs and the daily chart. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/**
 * Chart axis ticks. Spend axes often span fractions of a cent to a few cents,
 * where compact formatting would print "$0" on every tick; two significant
 * digits keep neighbouring ticks distinct ($0.025, $0.05) without long decimals.
 */
export function formatUsdTick(value: number): string {
  if (value === 0) return "$0";
  if (Math.abs(value) >= 1000) return `$${formatCompact(value)}`;
  return `$${Number(value.toPrecision(2))}`;
}
