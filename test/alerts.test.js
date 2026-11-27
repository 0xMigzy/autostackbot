import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { afterQuiet, cheaperRoute, dipPercent, inQuietHours, nextReminderAt, routeFee, usdcNeeded } from "../src/alerts.js";

const tz = "Europe/London";
const at = (iso) => DateTime.fromISO(iso, { zone: tz }).toMillis();
const iso = (ms) => DateTime.fromMillis(ms, { zone: tz }).toFormat("yyyy-MM-dd HH:mm");
const quiet = { start: "23:00", end: "08:00" };

test("quiet hours across midnight and within a day", () => {
  assert.equal(inQuietHours(at("2026-11-27T23:30"), quiet, tz), true);
  assert.equal(inQuietHours(at("2026-11-27T07:59"), quiet, tz), true);
  assert.equal(inQuietHours(at("2026-11-27T08:00"), quiet, tz), false);
  assert.equal(inQuietHours(at("2026-11-27T22:59"), quiet, tz), false);
  const day = { start: "12:00", end: "14:00" };
  assert.equal(inQuietHours(at("2026-11-27T13:00"), day, tz), true);
  assert.equal(inQuietHours(at("2026-11-27T14:00"), day, tz), false);
});

test("reminders every N hours, moved to the end of quiet hours", () => {
  assert.equal(iso(nextReminderAt(at("2026-11-27T09:00"), 6, quiet, tz)), "2026-11-27 15:00");
  assert.equal(iso(nextReminderAt(at("2026-11-27T20:00"), 6, quiet, tz)), "2026-11-28 08:00"); // 02:00 is quiet
  assert.equal(iso(nextReminderAt(at("2026-11-27T16:30"), 12, quiet, tz)), "2026-11-28 08:00"); // 04:30 is quiet
  assert.equal(iso(nextReminderAt(at("2026-11-27T09:00"), 3, quiet, tz)), "2026-11-27 12:00");
  assert.equal(nextReminderAt(at("2026-11-27T09:00"), 0, quiet, tz), null); // off
  assert.equal(iso(afterQuiet(at("2026-11-27T23:10"), quiet, tz)), "2026-11-28 08:00");
});

test("low USDC: sums every buy due in the next 7 days from that USDC", () => {
  const pay = { key: "ethereum:0xa0b8" };
  const plans = [
    { status: "active", pay, amount: "10", schedule: { freq: "weekly", weekday: 1, time: "09:00" }, stop: { type: "never" } },
    { status: "active", pay, amount: "5", schedule: { freq: "daily", time: "09:00" }, stop: { type: "never" } },
    { status: "paused", pay, amount: "100", schedule: { freq: "daily", time: "09:00" }, stop: { type: "never" } },
    { status: "active", pay: { key: "arbitrum-one:0xaf88" }, amount: "50", schedule: { freq: "daily", time: "09:00" }, stop: { type: "never" } },
    { status: "active", pay, amount: "7", schedule: { freq: "daily", time: "09:00" }, stop: { type: "date", date: "2026-12-02" } },
  ];
  const now = at("2026-11-30T10:00"); // Monday, after today's buys
  // weekly: 7 Dec (1 × 10); daily: 1–7 Dec (7 × 5); dated plan: 1–2 Dec (2 × 7)
  assert.deepEqual(usdcNeeded(plans, pay.key, now, tz, 7), { total: 10 + 35 + 14, buys: 10 });
});

test("cheaper route: suggest only when clearly cheaper", () => {
  const arb = { token: "arbitrum", fee: 0.1 };
  assert.deepEqual(cheaperRoute({ amountUsd: 10, currentFee: 3.8, alternatives: [arb] }), { type: "switch", alt: arb });
  assert.equal(cheaperRoute({ amountUsd: 10, currentFee: 1.5, alternatives: [{ token: "x", fee: 0.6 }] }), null); // saves only $0.90
  assert.equal(cheaperRoute({ amountUsd: 100, currentFee: 5, alternatives: [{ token: "x", fee: 3 }] }), null); // only 40% lower
  const best = cheaperRoute({ amountUsd: 10, currentFee: 4, alternatives: [{ token: "a", fee: 1 }, { token: "b", fee: 0.2 }] });
  assert.equal(best.alt.token, "b");
});

test("cheaper route: no other USDC held → suggest moving only when fees are over 5%", () => {
  assert.deepEqual(cheaperRoute({ amountUsd: 10, currentFee: 0.6, alternatives: [] }), { type: "move" });
  assert.equal(cheaperRoute({ amountUsd: 10, currentFee: 0.5, alternatives: [] }), null);
});

test("route fee and price dip", () => {
  assert.ok(Math.abs(routeFee(10, 0.15, 63.3) - 0.505) < 1e-9);
  assert.equal(routeFee(10, 0.2, 63.3), 0);
  assert.equal(dipPercent(56.2, 63.09), 11);
  assert.equal(dipPercent(57, 63), null); // 9.5% below
  assert.equal(dipPercent(null, 63), null);
});
