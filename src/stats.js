// Pure stats: plan progress, average price, streaks, coin summaries and plan restarts.
import { periodAt, periodsBetween } from "./schedule.js";

/** Coin received by a completed buy: the actual amount when known, else the estimate. */
export const receivedOf = (entry) => Number(entry.received ?? entry.estimate ?? 0);

export const REQUEST_EXPIRY_MS = 7 * 86_400_000;
/** A buy request not approved within 7 days counts as expired, even if Tangem hasn't said so. */
export const expiredByAge = (entry, nowMs) => !entry.approved && nowMs - entry.createdAt > REQUEST_EXPIRY_MS;

const completedFor = (plan, entries, from) =>
  entries.filter((e) => e.planId === plan.id && e.status === "COMPLETED" && e.completedAt >= from);

/** { buys, received, spent } of a plan's completed buys since its progress start. Spent is in USDC (≈ $). */
export function planProgress(plan, entries) {
  const done = completedFor(plan, entries, plan.progressFrom ?? 0);
  return {
    buys: done.length,
    received: done.reduce((sum, e) => sum + receivedOf(e), 0),
    spent: done.reduce((sum, e) => sum + Number(e.paid), 0),
  };
}

/** Average $ paid per coin over completed buys, or null. */
export function averagePrice(entries) {
  const done = entries.filter((e) => e.status === "COMPLETED");
  const received = done.reduce((sum, e) => sum + receivedOf(e), 0);
  const spent = done.reduce((sum, e) => sum + Number(e.paid), 0);
  return received > 0 ? spent / received : null;
}

export const isPausedAt = (ranges, ms) => ranges.some((r) => ms >= r.from && (r.to == null || ms < r.to));

/**
 * Streak = consecutive periods with at least one completed buy for the plan (a buy counts in the period it completed).
 * The open period never breaks it; periods before the plan's first buy and paused periods (paused at the buy time or at
 * the end of the period) are skipped. A finished period with no completed buy resets it to 0.
 * Returns { current, best }; best also keeps the plan's stored best.
 */
export function computeStreak({ plan, entries, pauseRanges = [], nowMs, tz }) {
  const from = Math.max(plan.startAt ?? 0, plan.streakFrom ?? 0);
  const ranges = [...(plan.pauseRanges ?? []), ...pauseRanges];
  const completed = new Set(completedFor(plan, entries, from).map((e) => periodAt(plan.schedule, e.completedAt, tz).key));
  let current = 0;
  let best = 0;
  for (const p of periodsBetween(plan.schedule, from, nowMs, tz)) {
    if (completed.has(p.key)) {
      current++;
      best = Math.max(best, current);
    } else if (p.end > nowMs || p.due < from || isPausedAt(ranges, p.due) || isPausedAt(ranges, p.end - 1)) {
      continue; // still open, before the first buy, or paused: neutral
    } else {
      current = 0;
    }
  }
  return { current, best: Math.max(best, plan.bestStreak ?? 0) };
}

/**
 * Summary of one coin's buys: totals, average price, value now. priceNow may be null (then worth fields are null).
 */
export function coinSummary(entries, priceNow) {
  const done = entries.filter((e) => e.status === "COMPLETED");
  const bought = done.reduce((sum, e) => sum + receivedOf(e), 0);
  const spent = done.reduce((sum, e) => sum + Number(e.paid), 0);
  const worth = priceNow != null ? bought * priceNow : null;
  const change = worth != null ? worth - spent : null;
  return {
    bought,
    spent,
    avgPrice: bought > 0 ? spent / bought : null,
    priceNow: priceNow ?? null,
    worth,
    change,
    changePct: change != null && spent > 0 ? (change / spent) * 100 : null,
    done: done.length,
    missed: entries.filter((e) => e.status === "MISSED").length,
  };
}

/**
 * Restart a paused or finished plan. "keep": progress and streak continue (the pause doesn't break it).
 * "fresh": progress and streak start from now; history stays; best streak is kept.
 */
export function restartPlan(plan, mode, nowMs) {
  const pauseRanges = (plan.pauseRanges ?? []).map((r) => (r.to == null ? { ...r, to: nowMs } : r));
  const restarted = { ...plan, status: "active", pauseRanges, note: null };
  if (mode === "fresh") {
    Object.assign(restarted, { progressFrom: nowMs, streakFrom: nowMs, startAt: nowMs, lastStreak: 0 });
  }
  return restarted;
}
