/**
 * Calendar maths for plans: when the next buys are due and when a goal is reached.
 * Everything works in the visitor's local time zone and is pure (callers pass `now`).
 */

/** 0 = Monday … 6 = Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAY_LONG = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export type Schedule =
  | { kind: "daily" }
  | { kind: "weekly"; days: Weekday[] }
  /** The first `day` of every month, e.g. the first Monday. */
  | { kind: "monthly"; day: Weekday }
  /** Every `everyDays` days counted from `anchor` (YYYY-MM-DD). */
  | { kind: "custom"; everyDays: number; anchor: string };

export interface Timing {
  schedule: Schedule;
  /** "HH:MM", 24-hour local time. */
  time: string;
}

const DAY_MS = 86_400_000;
/** Search horizon for the next buys; long enough for monthly plans over many years. */
const MAX_DAYS_SCANNED = 366 * 12;

export function weekdayOf(date: Date): Weekday {
  return ((date.getDay() + 6) % 7) as Weekday;
}

export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local midnight of a YYYY-MM-DD key. */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function parseTime(time: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return { hours: 9, minutes: 0 };
  return {
    hours: Math.min(23, Number(match[1])),
    minutes: Math.min(59, Number(match[2])),
  };
}

function atTime(day: Date, time: string): Date {
  const { hours, minutes } = parseTime(time);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
}

/** Whole calendar days from `a` to `b` (both local), robust to DST shifts. */
function daysBetween(a: Date, b: Date): number {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / DAY_MS);
}

function runsOn(schedule: Schedule, day: Date): boolean {
  switch (schedule.kind) {
    case "daily":
      return true;
    case "weekly":
      return schedule.days.includes(weekdayOf(day));
    case "monthly":
      return day.getDate() <= 7 && weekdayOf(day) === schedule.day;
    case "custom": {
      const diff = daysBetween(fromDateKey(schedule.anchor), day);
      return diff >= 0 && diff % Math.max(1, schedule.everyDays) === 0;
    }
  }
}

/**
 * The next buy times strictly after `after`, stopping at `count` results or once a buy would be
 * later than `until` (inclusive), whichever comes first.
 */
export function upcomingBuys(timing: Timing, after: Date, count: number, until?: Date): Date[] {
  const result: Date[] = [];
  if (timing.schedule.kind === "weekly" && timing.schedule.days.length === 0) return result;
  const start = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let i = 0; i < MAX_DAYS_SCANNED && result.length < count; i += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (!runsOn(timing.schedule, day)) continue;
    const at = atTime(day, timing.time);
    if (until && at > until) break;
    if (at > after) result.push(at);
  }
  return result;
}

/** The first moment a plan's buys can start: today if `time` is still ahead, else tomorrow. */
export function firstAnchor(time: string, now: Date): string {
  const today = atTime(now, time);
  return toDateKey(
    today > now ? now : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
  );
}

/**
 * When the next buy is due. A buy made early ("Buy now") covers the next due slot, so the slot
 * after `coveredUntil` is returned in that case.
 */
export function nextBuy(timing: Timing, now: Date, coveredUntil?: string | null): Date | null {
  const covered = coveredUntil ? new Date(coveredUntil) : null;
  const after = covered && covered > now ? covered : now;
  return upcomingBuys(timing, after, 1)[0] ?? null;
}

/** Buys needed to add `remaining` when each buy adds `perBuy`. */
export function buysNeeded(remaining: number, perBuy: number): number {
  if (remaining <= 0) return 0;
  if (perBuy <= 0) return Infinity;
  // Small epsilon so that e.g. 0.3 / 0.1 does not round up to 4.
  return Math.ceil(remaining / perBuy - 1e-9);
}

/** The date of the `n`-th upcoming buy (1-based), or null when out of the search horizon. */
export function nthBuy(
  timing: Timing,
  now: Date,
  n: number,
  coveredUntil?: string | null,
): Date | null {
  if (!Number.isFinite(n) || n < 1) return null;
  const first = nextBuy(timing, now, coveredUntil);
  if (!first) return null;
  if (n === 1) return first;
  const rest = upcomingBuys(timing, first, n - 1);
  return rest.length === n - 1 ? rest[n - 2] : null;
}

/** Countdown text such as "in 2 days, 14 h", "in 3 h 12 min" or "in 5 min". */
export function countdown(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  if (ms <= 60_000) return "in a moment";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `in ${days} ${days === 1 ? "day" : "days"}, ${hours} h`;
  if (hours > 0) return `in ${hours} h ${minutes} min`;
  return `in ${minutes} min`;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "every Monday", "every day", "on the first Monday of each month", "every 3 days". */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "daily":
      return "every day";
    case "weekly": {
      const days = [...schedule.days].sort((a, b) => a - b);
      if (days.length === 7) return "every day";
      return `every ${joinWords(days.map((d) => WEEKDAY_LONG[d]))}`;
    }
    case "monthly":
      return `on the first ${WEEKDAY_LONG[schedule.day]} of each month`;
    case "custom":
      return schedule.everyDays === 1 ? "every day" : `every ${schedule.everyDays} days`;
  }
}

/** The unit a streak is counted in for this schedule. */
export function streakUnit(schedule: Schedule, count: number): string {
  const plural = count === 1 ? "" : "s";
  switch (schedule.kind) {
    case "daily":
      return `day${plural}`;
    case "weekly":
      return schedule.days.length === 1 ? `week${plural}` : `buy${plural}`;
    case "monthly":
      return `month${plural}`;
    case "custom":
      return `buy${plural}`;
  }
}
