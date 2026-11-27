import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { forecast, parseDate, parseTime, periodAt, planPreview, stopReason, upcomingDues } from "../src/schedule.js";

const tz = "Europe/London";
const at = (iso) => DateTime.fromISO(iso, { zone: tz }).toMillis();
const iso = (ms) => DateTime.fromMillis(ms, { zone: tz }).toFormat("yyyy-MM-dd HH:mm");
const weekly = { freq: "weekly", weekday: 1, time: "09:00" }; // Mondays 09:00
const NOW = at("2026-11-27T12:00"); // a Friday
const none = { buys: 0, received: 0, spent: 0 };

test("periods: weekly is Mon–Sun with the buy on the chosen day", () => {
  const p = periodAt(weekly, NOW, tz);
  assert.equal(p.key, "w:2026-11-23");
  assert.equal(iso(p.start), "2026-11-23 00:00");
  assert.equal(iso(p.end), "2026-11-30 00:00");
  assert.equal(iso(p.due), "2026-11-23 09:00");
});

test("periods: monthly buys on the first chosen weekday of the calendar month", () => {
  const p = periodAt({ freq: "monthly", weekday: 1, time: "09:00" }, at("2026-12-20T10:00"), tz);
  assert.equal(p.key, "m:2026-12");
  assert.equal(iso(p.due), "2026-12-07 09:00");
  assert.equal(iso(p.end), "2027-01-01 00:00");
});

test("periods: every X days are windows from the anchor", () => {
  const s = { freq: "days", every: 3, anchor: "2026-11-30", time: "18:00" };
  const p = periodAt(s, at("2026-12-04T08:00"), tz);
  assert.equal(p.key, "x:2026-12-03");
  assert.equal(iso(p.due), "2026-12-03 18:00");
  assert.equal(iso(p.end), "2026-12-06 00:00");
});

test("periods: daily keeps local buy time across a DST change", () => {
  const p = periodAt({ freq: "daily", time: "09:00" }, at("2026-10-25T12:00"), tz);
  assert.equal(iso(p.due), "2026-10-25 09:00");
  assert.equal(p.end - p.start, 25 * 3_600_000); // clocks go back: a 25-hour day
});

test("upcoming dues stop at a date stop", () => {
  const dues = upcomingDues(weekly, NOW, 100, tz, { type: "date", date: "2026-12-31" });
  assert.deepEqual(dues.map(iso), ["2026-11-30 09:00", "2026-12-07 09:00", "2026-12-14 09:00", "2026-12-21 09:00", "2026-12-28 09:00"]);
});

test("forecast: coin goal → buys needed and the date of the last one", () => {
  const f = forecast({ schedule: weekly, stop: { type: "goal", unit: "coin", target: "1" }, amount: "10", progress: none, perBuyCoin: 0.158, nowMs: NOW, tz });
  assert.equal(f.buys, 7);
  assert.equal(iso(f.date), "2027-01-11 09:00");
});

test("forecast: coin goal counts progress already made", () => {
  const f = forecast({ schedule: weekly, stop: { type: "goal", unit: "coin", target: "1" }, amount: "10", progress: { buys: 2, received: 0.317, spent: 20 }, perBuyCoin: 0.1585, nowMs: NOW, tz });
  assert.equal(f.buys, 5); // 0.683 / 0.1585 = 4.3 → 5
});

test("forecast: dollar goal uses the plan amount", () => {
  const f = forecast({ schedule: weekly, stop: { type: "goal", unit: "usd", target: "100" }, amount: "10", progress: { buys: 3, received: 0.4, spent: 30 }, perBuyCoin: null, nowMs: NOW, tz });
  assert.equal(f.buys, 7);
  assert.equal(iso(f.date), "2027-01-11 09:00");
});

test("forecast: goal already reached, or no price for a coin goal", () => {
  assert.deepEqual(forecast({ schedule: weekly, stop: { type: "goal", unit: "coin", target: "1" }, amount: "10", progress: { buys: 7, received: 1.01, spent: 70 }, perBuyCoin: 0.15, nowMs: NOW, tz }), { kind: "goal", buys: 0, date: null });
  assert.equal(forecast({ schedule: weekly, stop: { type: "goal", unit: "coin", target: "1" }, amount: "10", progress: none, perBuyCoin: null, nowMs: NOW, tz }), null);
});

test("forecast: buys, date and never stops", () => {
  const buys = forecast({ schedule: weekly, stop: { type: "buys", count: 12 }, amount: "10", progress: { buys: 2, received: 0, spent: 20 }, nowMs: NOW, tz });
  assert.equal(buys.buys, 10);
  const date = forecast({ schedule: weekly, stop: { type: "date", date: "2026-12-31" }, amount: "10", progress: none, nowMs: NOW, tz });
  assert.equal(date.buys, 5);
  assert.equal(iso(date.date), "2026-12-28 09:00");
  assert.deepEqual(forecast({ schedule: weekly, stop: { type: "never" }, amount: "10", progress: none, nowMs: NOW, tz }), { kind: "never" });
});

test("stop conditions", () => {
  assert.equal(stopReason({ type: "never" }, { buys: 99, received: 9, spent: 999 }, NOW, tz), null);
  assert.equal(stopReason({ type: "buys", count: 4 }, { buys: 3, received: 0, spent: 0 }, NOW, tz), null);
  assert.equal(stopReason({ type: "buys", count: 4 }, { buys: 4, received: 0, spent: 0 }, NOW, tz), "buys");
  assert.equal(stopReason({ type: "date", date: "2026-11-27" }, none, at("2026-11-27T23:59"), tz), null);
  assert.equal(stopReason({ type: "date", date: "2026-11-27" }, none, at("2026-11-28T00:00"), tz), "date");
  assert.equal(stopReason({ type: "goal", unit: "coin", target: "1" }, { buys: 6, received: 0.99, spent: 60 }, NOW, tz), null);
  assert.equal(stopReason({ type: "goal", unit: "coin", target: "1" }, { buys: 7, received: 1, spent: 70 }, NOW, tz), "goal");
  assert.equal(stopReason({ type: "goal", unit: "usd", target: "250" }, { buys: 25, received: 3, spent: 250 }, NOW, tz), "goal");
});

test("input parsing: typed times and DD/MM/YYYY dates", () => {
  for (const [typed, time] of [
    ["07:45", "07:45"], ["7:45", "07:45"], ["7.45", "07:45"], ["745", "07:45"], ["19:00", "19:00"],
    ["7pm", "19:00"], ["7 PM", "19:00"], ["7:30pm", "19:30"], ["12am", "00:00"], ["12pm", "12:00"], ["9:05", "09:05"],
  ]) {
    assert.equal(parseTime(typed), time, typed);
  }
  for (const bad of ["24:00", "7", "13pm", "0am", "7:60", "noon", ""]) assert.equal(parseTime(bad), null, bad);
  assert.equal(parseDate("31/03/2027"), "2027-03-31");
  assert.equal(parseDate("31/02/2027"), null);
});

const daily18 = { freq: "daily", time: "18:00" };
const goal1 = { type: "goal", unit: "coin", target: "1" };

test("preview with Buy now: first buy now, the schedule continues from the next period", () => {
  const nowMs = at("2026-11-27T10:00"); // before today's 18:00: today's slot is covered by the first buy
  const p = planPreview({ schedule: daily18, stop: goal1, amount: "10", perBuyCoin: 0.25, buyNow: true, nowMs, tz });
  assert.equal(p.firstAt, nowMs);
  assert.equal(p.forecast.buys, 4); // now + 28, 29, 30 Nov at 18:00
  assert.equal(iso(p.forecast.date), "2026-11-30 18:00");
});

test("preview waiting for the schedule: first buy at the next due time", () => {
  const nowMs = at("2026-11-27T10:00");
  const p = planPreview({ schedule: daily18, stop: goal1, amount: "10", perBuyCoin: 0.25, buyNow: false, nowMs, tz });
  assert.equal(iso(p.firstAt), "2026-11-27 18:00");
  assert.equal(p.forecast.buys, 4); // 27, 28, 29, 30 Nov
  assert.equal(iso(p.forecast.date), "2026-11-30 18:00");
});

test("preview with Buy now: a goal reached by the first buy, and a buys stop counting it", () => {
  const nowMs = at("2026-11-27T10:00");
  const one = planPreview({ schedule: daily18, stop: goal1, amount: "100", perBuyCoin: 1.2, buyNow: true, nowMs, tz });
  assert.deepEqual([one.forecast.buys, one.forecast.date], [1, nowMs]);
  const buys = planPreview({ schedule: daily18, stop: { type: "buys", count: 3 }, amount: "10", perBuyCoin: 0.2, buyNow: true, nowMs, tz });
  assert.equal(buys.forecast.buys, 3);
  assert.equal(iso(buys.forecast.date), "2026-11-29 18:00"); // now, 28, 29
});
