// Pure alert decisions: reminders and quiet hours, low USDC, cheaper routes, price dips.
import { DateTime } from "luxon";
import { upcomingDues } from "./schedule.js";

const minutesOf = (time) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/** True if `ms` falls in quiet hours { start: "23:00", end: "08:00" } (may wrap midnight). */
export function inQuietHours(ms, quiet, tz) {
  if (!quiet || quiet.start === quiet.end) return false;
  const t = DateTime.fromMillis(ms, { zone: tz });
  const now = t.hour * 60 + t.minute;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** First moment at or after `ms` outside quiet hours. */
export function afterQuiet(ms, quiet, tz) {
  if (!inQuietHours(ms, quiet, tz)) return ms;
  const [hour, minute] = quiet.end.split(":").map(Number);
  let end = DateTime.fromMillis(ms, { zone: tz }).set({ hour, minute, second: 0, millisecond: 0 });
  if (end.toMillis() <= ms) end = end.plus({ days: 1 });
  return end.toMillis();
}

/** When the next reminder for a waiting buy is due, or null when reminders are off. */
export function nextReminderAt(lastMs, everyHours, quiet, tz) {
  if (!everyHours) return null;
  return afterQuiet(lastMs + everyHours * 3_600_000, quiet, tz);
}

/**
 * USDC the active plans paying with `payKey` need for buys due in (now, now + days].
 * Returns { total, buys } with total in USDC.
 */
export function usdcNeeded(plans, payKey, nowMs, tz, days = 7) {
  const until = nowMs + days * 86_400_000;
  let total = 0;
  let buys = 0;
  for (const plan of plans) {
    if (plan.status !== "active" || plan.paused || plan.pay.key !== payKey) continue;
    const dues = upcomingDues(plan.schedule, nowMs, 400, tz, plan.stop).filter((d) => d <= until);
    total += dues.length * Number(plan.amount);
    buys += dues.length;
  }
  return { total, buys };
}

/** Cost of a buy in $: what was paid minus what the coin received is worth. Never negative. */
export const routeFee = (paidUsd, receivedCoin, coinPriceUsd) => Math.max(0, paidUsd - receivedCoin * coinPriceUsd);

/**
 * Cheaper way to pay? current/alternatives fees in $.
 * - alternatives held: the cheapest one if it saves at least $1 and is at least 50% cheaper → { type: "switch", alt }
 * - none held: if fees are over 5% of the amount → { type: "move" }
 * - otherwise null. Never a reason to skip a buy.
 */
export function cheaperRoute({ amountUsd, currentFee, alternatives }) {
  if (alternatives.length) {
    const alt = alternatives.reduce((a, b) => (b.fee < a.fee ? b : a));
    return currentFee - alt.fee >= 1 && alt.fee <= currentFee * 0.5 ? { type: "switch", alt } : null;
  }
  return currentFee > amountUsd * 0.05 ? { type: "move" } : null;
}

/** Price dip: now at least 10% below the average buy price. Returns the % below (rounded) or null. */
export function dipPercent(priceNow, avgPrice) {
  if (!(priceNow > 0) || !(avgPrice > 0)) return null;
  const below = (1 - priceNow / avgPrice) * 100;
  return below >= 10 ? Math.round(below) : null;
}
