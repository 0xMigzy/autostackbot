// Pure schedule logic: periods, due times, stop conditions and forecasts. All times are ms; tz is an IANA zone.
import { DateTime } from "luxon";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // index + 1 = ISO weekday
export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MAX_STEPS = 5000;

const zoned = (ms, tz) => DateTime.fromMillis(ms, { zone: tz });

function atTime(day, time) {
  const [hour, minute] = time.split(":").map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

/** "HH:MM" 24h → normalised "HH:MM", or null. */
export function parseTime(text) {
  const match = /^\s*(\d{1,2})[:.h]?(\d{2})\s*$/.exec(text ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "DD/MM/YYYY" → "YYYY-MM-DD", or null if not a real date. */
export function parseDate(text) {
  const match = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(text ?? "");
  if (!match) return null;
  const date = DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) });
  return date.isValid ? date.toISODate() : null;
}

/**
 * The schedule period containing `ms`: { key, start, end, due }.
 * schedule = { freq: "daily"|"weekly"|"monthly"|"days", weekday (1-7, weekly/monthly), every (days), anchor ("YYYY-MM-DD", days), time "HH:MM" }.
 * Daily = calendar day, weekly = Mon–Sun, monthly = calendar month (buy on its first <weekday>),
 * days = windows of `every` days starting at `anchor`.
 */
export function periodAt(schedule, ms, tz) {
  const t = zoned(ms, tz);
  let start, end, due, key;
  switch (schedule.freq) {
    case "daily":
      start = t.startOf("day");
      end = start.plus({ days: 1 });
      due = atTime(start, schedule.time);
      key = `d:${start.toISODate()}`;
      break;
    case "weekly":
      start = t.startOf("week");
      end = start.plus({ weeks: 1 });
      due = atTime(start.plus({ days: schedule.weekday - 1 }), schedule.time);
      key = `w:${start.toISODate()}`;
      break;
    case "monthly": {
      start = t.startOf("month");
      end = start.plus({ months: 1 });
      const offset = (schedule.weekday - start.weekday + 7) % 7;
      due = atTime(start.plus({ days: offset }), schedule.time);
      key = `m:${start.toFormat("yyyy-MM")}`;
      break;
    }
    case "days": {
      const anchor = DateTime.fromISO(schedule.anchor, { zone: tz }).startOf("day");
      const days = Math.round(t.startOf("day").diff(anchor, "days").days);
      const k = Math.floor(days / schedule.every);
      start = anchor.plus({ days: k * schedule.every });
      end = start.plus({ days: schedule.every });
      due = atTime(start, schedule.time);
      key = `x:${start.toISODate()}`;
      break;
    }
    default:
      throw new Error(`unknown frequency ${schedule.freq}`);
  }
  return { key, start: start.toMillis(), end: end.toMillis(), due: due.toMillis() };
}

export const nextPeriod = (schedule, period, tz) => periodAt(schedule, period.end, tz);

/** Periods from the one containing `fromMs` up to the one containing `toMs`, inclusive. */
export function periodsBetween(schedule, fromMs, toMs, tz) {
  const out = [];
  let p = periodAt(schedule, fromMs, tz);
  for (let i = 0; i < MAX_STEPS && p.start <= toMs; i++) {
    out.push(p);
    p = nextPeriod(schedule, p, tz);
  }
  return out;
}

/** The last day a date stop allows, as ms (end of that day in tz). */
export const stopEnd = (stop, tz) => DateTime.fromISO(stop.date, { zone: tz }).endOf("day").toMillis();

/** Up to `count` due times strictly after `fromMs`, not past a date stop. */
export function upcomingDues(schedule, fromMs, count, tz, stop = null) {
  const limit = stop?.type === "date" ? stopEnd(stop, tz) : Infinity;
  const out = [];
  let p = periodAt(schedule, fromMs, tz);
  for (let i = 0; i < MAX_STEPS && out.length < count; i++) {
    if (p.due > limit) break;
    if (p.due > fromMs) out.push(p.due);
    p = nextPeriod(schedule, p, tz);
  }
  return out;
}

/** Why a plan is finished, or null: "buys" | "date" | "goal". progress = { buys, received, spent }. */
export function stopReason(stop, progress, nowMs, tz) {
  switch (stop?.type) {
    case "buys":
      return progress.buys >= stop.count ? "buys" : null;
    case "date":
      return nowMs > stopEnd(stop, tz) ? "date" : null;
    case "goal": {
      const have = stop.unit === "usd" ? progress.spent : progress.received;
      return have + 1e-12 >= Number(stop.target) ? "goal" : null;
    }
    default:
      return null;
  }
}

/** True if a due time is still allowed by the plan's stop rule (date stops only; others are checked on progress). */
export const dueAllowed = (stop, dueMs, tz) => stop?.type !== "date" || dueMs <= stopEnd(stop, tz);

/**
 * What the plan will do from now: { kind, buys, date } where date is the ms of the last expected buy.
 * - goal: buys still needed at `perBuyCoin` coin (or the plan amount in $) per buy, and when that buy happens
 * - buys: buys left and the last one's date; date: buys left until the stop date and the last one's date
 * - never: { kind: "never" }
 * Returns null when it can't forecast (no price for a coin goal).
 */
export function forecast({ schedule, stop, amount, progress, perBuyCoin, nowMs, tz }) {
  const lastOf = (n) => (n > 0 ? (upcomingDues(schedule, nowMs, n, tz, stop)[n - 1] ?? null) : null);
  switch (stop?.type) {
    case "goal": {
      const usd = stop.unit === "usd";
      const perBuy = usd ? Number(amount) : perBuyCoin;
      if (!(perBuy > 0)) return null;
      const remaining = Number(stop.target) - (usd ? progress.spent : progress.received);
      const buys = remaining <= 1e-12 ? 0 : Math.ceil(remaining / perBuy - 1e-9);
      return { kind: "goal", buys, date: lastOf(buys) };
    }
    case "buys": {
      const buys = Math.max(0, stop.count - progress.buys);
      return { kind: "buys", buys, date: lastOf(buys) };
    }
    case "date": {
      const dues = upcomingDues(schedule, nowMs, MAX_STEPS, tz, stop);
      return { kind: "date", buys: dues.length, date: dues.at(-1) ?? null };
    }
    default:
      return { kind: "never" };
  }
}
