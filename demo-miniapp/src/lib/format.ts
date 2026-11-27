import { ASSETS, type Asset } from "./coins";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$270.07", "$61,300.00". */
export function formatUsd(value: number): string {
  return usd.format(value);
}

/** Unsigned percentage for use next to a ▲/▼ arrow, e.g. "2.40%". */
export function formatPercent(value: number): string {
  return `${Math.abs(value).toFixed(2)}%`;
}

/** Amount of an asset with the asset's display decimals, e.g. "0.317". */
export function formatAmount(value: number, asset: Asset): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: ASSETS[asset].decimals,
    minimumFractionDigits: 0,
  }).format(value);
}

/** "0.317 HYPE". */
export function formatAsset(value: number, asset: Asset): string {
  return `${formatAmount(value, asset)} ${asset}`;
}

/** "23 Nov", or "23 Nov 2027" when not in the current year. */
export function formatDay(date: Date, now: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** "Mon 23 Nov". */
export function formatWeekdayDay(date: Date, now: Date): string {
  const weekday = date.toLocaleDateString("en-GB", { weekday: "short" });
  return `${weekday} ${formatDay(date, now)}`;
}

/** "09:00". */
export function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Trims float noise so stored amounts stay readable, e.g. 0.15797788309636651 → 0.157978. */
export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
