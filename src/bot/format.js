// Plain-language formatting for bot messages. Times use the bot's time zone.
import { DateTime } from "luxon";
import { WEEKDAY_NAMES } from "../schedule.js";

export const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

export function usd(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const cents = n === 0 || Math.abs(n) >= 0.01;
  const digits = cents ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 };
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", ...digits });
}

/** Coin amounts for display: 4 significant digits (0.1505, 0.07768), whole numbers from 1,000 up. Full precision stays in data. */
export function amount(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  if (x === 0) return "0";
  if (Math.abs(x) >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return x.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

export function change(pct) {
  if (pct == null || !Number.isFinite(pct)) return "";
  return `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}%`;
}

export const bar = (pct, width = 10) => {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
};

const zoned = (ms, tz) => DateTime.fromMillis(ms, { zone: tz });
export const shortDate = (ms, tz) => zoned(ms, tz).toFormat("d LLL"); // 11 Jan
export const dayDate = (ms, tz) => zoned(ms, tz).toFormat("d LLL yyyy"); // 11 Jan 2027
export const weekday = (ms, tz) => zoned(ms, tz).toFormat("ccc"); // Wed
export const weekdayLong = (ms, tz) => zoned(ms, tz).toFormat("cccc"); // Monday
export const whenLong = (ms, tz) => zoned(ms, tz).toFormat("cccc d LLL 'at' HH:mm"); // Monday 1 Dec at 09:00
export const dayTime = (ms, tz) => zoned(ms, tz).toFormat("cccc HH:mm"); // Monday 09:00

export function countdown(ms, now = Date.now()) {
  let minutes = Math.max(0, Math.round((ms - now) / 60_000));
  const parts = [];
  for (const [unit, size] of [["d", 1440], ["h", 60], ["m", 1]]) {
    if (minutes >= size || (unit === "m" && !parts.length)) parts.push(`${Math.floor(minutes / size)}${unit}`);
    minutes %= size;
  }
  return parts.slice(0, 2).join(" ");
}

export function ago(ms, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export const shortContract = (c) => (!c || c === "0" ? "native coin" : c.length > 12 ? `${c.slice(0, 6)}…${c.slice(-4)}` : c);

/** "every Monday at 09:00" and friends. */
export function describeSchedule(s) {
  switch (s.freq) {
    case "daily":
      return `every day at ${s.time}`;
    case "weekly":
      return `every ${WEEKDAY_NAMES[s.weekday - 1]} at ${s.time}`;
    case "monthly":
      return `on the first ${WEEKDAY_NAMES[s.weekday - 1]} of every month at ${s.time}`;
    case "days":
      return `every ${s.every} days at ${s.time}`;
    default:
      return "";
  }
}

export const FREQ_LABEL = { daily: "daily", weekly: "weekly", monthly: "monthly", days: "every few days" };

/** Words for a plan's period: unit for streaks, last/this for missed notices, cardWord for share cards. */
export function periodWords(freq) {
  switch (freq) {
    case "daily":
      return { unit: "day", last: "yesterday", this: "Today's", that: "that day", cardWord: "day" };
    case "weekly":
      return { unit: "week", last: "last week", this: "This week's", that: "that week", cardWord: "week" };
    case "monthly":
      return { unit: "month", last: "last month", this: "This month's", that: "that month", cardWord: "month" };
    default:
      return { unit: "buy", last: "last time", this: "This", that: "that time", cardWord: "buy" };
  }
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function streakText(freq, current, best) {
  return `${plural(current, periodWords(freq).unit)} in a row · best ${best}`;
}

/** "1 HYPE" / "$250" */
export function goalLabel(stop, symbol) {
  return stop.unit === "usd" ? usd(Number(stop.target)).replace(/\.00$/, "") : `${amount(stop.target)} ${symbol}`;
}

export function stopText(stop, symbol) {
  switch (stop?.type) {
    case "buys":
      return `after ${plural(stop.count, "buy")}`;
    case "date":
      return `on ${DateTime.fromISO(stop.date).toFormat("d LLL yyyy")}`;
    case "goal":
      return stop.unit === "usd" ? `when you've invested ${goalLabel(stop, symbol)}` : `when you reach ${goalLabel(stop, symbol)}`;
    default:
      return "never";
  }
}

/**
 * /portfolio lines: only tokens with a balance above zero (missing balances are left out), largest $ value first.
 * balances: Map key → amount string; priceOf(token) → $ price or null. Returns { rows: [{ line, value }], total }.
 */
export function portfolioRows(tokens, balances, priceOf) {
  const rows = tokens
    .filter((t) => Number(balances.get(t.key) ?? 0) > 0)
    .map((t) => {
      const balance = balances.get(t.key);
      const price = priceOf(t);
      const value = price != null ? Number(balance) * price : null;
      const worth = value != null ? `   (${usd(value)})` : "";
      return { line: `${esc(t.symbol)} · ${esc(t.networkName)}   ${amount(balance)}${worth}`, value };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  return { rows, total: rows.reduce((sum, r) => sum + (r.value ?? 0), 0) };
}
