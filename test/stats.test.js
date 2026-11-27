import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { averagePrice, clearHistoryEntries, coinSummary, computeStreak, planProgress, resetPlanStats, restartPlan } from "../src/stats.js";

const tz = "Europe/London";
const at = (iso) => DateTime.fromISO(iso, { zone: tz }).toMillis();
const START = at("2026-11-01T12:00"); // Sunday; first weekly buy Monday 2 Nov

const plan = (schedule, extra = {}) => ({ id: "p1", schedule, startAt: START, streakFrom: START, progressFrom: START, pauseRanges: [], bestStreak: 0, ...extra });
const done = (iso, extra = {}) => ({ planId: "p1", status: "COMPLETED", completedAt: at(iso), createdAt: at(iso), paid: "10", estimate: "0.1", received: null, ...extra });
const weekly = { freq: "weekly", weekday: 1, time: "09:00" };
const streak = (p, entries, now, pauseRanges = []) => computeStreak({ plan: p, entries, pauseRanges, nowMs: at(now), tz });

test("weekly streak counts consecutive weeks with a completed buy", () => {
  const entries = [done("2026-11-02T10:00"), done("2026-11-09T10:00"), done("2026-11-16T10:00")];
  assert.deepEqual(streak(plan(weekly), entries, "2026-11-18T12:00"), { current: 3, best: 3 });
});

test("a missed week resets the streak; best is kept", () => {
  const entries = [done("2026-11-02T10:00"), done("2026-11-09T10:00"), done("2026-11-23T10:00")];
  assert.deepEqual(streak(plan(weekly), entries, "2026-11-24T12:00"), { current: 1, best: 2 });
});

test("the open week never breaks the streak", () => {
  const entries = [done("2026-11-02T10:00"), done("2026-11-09T10:00")];
  assert.deepEqual(streak(plan(weekly), entries, "2026-11-20T12:00"), { current: 2, best: 2 });
  // ...but once that week is over with nothing completed, it does.
  assert.deepEqual(streak(plan(weekly), entries, "2026-11-23T00:01"), { current: 0, best: 2 });
});

test("late approval: approving on Sunday still counts for that week", () => {
  const entries = [done("2026-11-02T10:00"), done("2026-11-15T22:00", { createdAt: at("2026-11-09T09:00") })];
  assert.deepEqual(streak(plan(weekly), entries, "2026-11-17T12:00"), { current: 2, best: 2 });
});

test("buy now counts for the current week if nothing completed yet; a second buy adds nothing", () => {
  const entries = [done("2026-11-02T10:00"), done("2026-11-12T15:00"), done("2026-11-13T09:00")];
  assert.deepEqual(streak(plan(weekly), entries, "2026-11-14T12:00"), { current: 2, best: 2 });
});

test("paused weeks don't break the streak (plan pause or global pause)", () => {
  const entries = [done("2026-11-02T10:00"), done("2026-11-09T10:00"), done("2026-11-23T10:00")];
  const paused = plan(weekly, { pauseRanges: [{ from: at("2026-11-15T00:00"), to: at("2026-11-20T00:00") }] });
  assert.deepEqual(streak(paused, entries, "2026-11-24T12:00"), { current: 3, best: 3 });
  const globalPause = [{ from: at("2026-11-16T08:00"), to: null }];
  assert.deepEqual(streak(plan(weekly), entries, "2026-11-24T12:00", globalPause), { current: 3, best: 3 });
});

test("daily streak uses calendar days", () => {
  const daily = plan({ freq: "daily", time: "09:00" });
  const entries = [done("2026-11-02T09:30"), done("2026-11-03T23:50"), done("2026-11-04T08:00")];
  assert.deepEqual(streak(daily, entries, "2026-11-04T20:00"), { current: 3, best: 3 });
  assert.deepEqual(streak(daily, entries, "2026-11-06T01:00"), { current: 0, best: 3 }); // 5 Nov missed
});

test("monthly streak uses calendar months", () => {
  const monthly = plan({ freq: "monthly", weekday: 1, time: "09:00" });
  const entries = [done("2026-11-02T10:00"), done("2026-12-30T10:00"), done("2027-01-05T10:00")];
  assert.deepEqual(streak(monthly, entries, "2027-01-20T12:00"), { current: 3, best: 3 });
  assert.deepEqual(streak(monthly, entries.slice(0, 1), "2027-01-20T12:00"), { current: 0, best: 1 });
});

test("the week the plan started in, before its first buy time, is neutral", () => {
  const p = plan(weekly, { startAt: at("2026-11-02T12:00"), streakFrom: at("2026-11-02T12:00") }); // after Monday 09:00
  assert.deepEqual(streak(p, [done("2026-11-09T10:00")], "2026-11-10T12:00"), { current: 1, best: 1 });
});

test("a stored best streak is kept", () => {
  assert.deepEqual(streak(plan(weekly, { bestStreak: 9 }), [done("2026-11-02T10:00")], "2026-11-03T12:00"), { current: 1, best: 9 });
});

test("progress and average price use actual amounts when known", () => {
  const entries = [
    done("2026-11-02T10:00", { received: "0.16" }),
    done("2026-11-09T10:00", { estimate: "0.15" }),
    { planId: "p1", status: "MISSED", paid: "10", createdAt: at("2026-11-16T09:00") },
    done("2026-10-20T10:00", { received: "1" }), // before progressFrom
  ];
  const p = planProgress(plan(weekly), entries);
  assert.equal(p.buys, 2);
  assert.equal(p.spent, 20);
  assert.ok(Math.abs(p.received - 0.31) < 1e-12);
  assert.ok(Math.abs(averagePrice(entries.slice(0, 2)) - 20 / 0.31) < 1e-9);
  assert.equal(averagePrice([]), null);
});

test("history summary: totals, average, worth now and change", () => {
  const entries = [
    done("2026-11-02T10:00", { received: "0.2", paid: "10" }),
    done("2026-11-09T10:00", { received: "0.25", paid: "15" }),
    { status: "MISSED", paid: "10" },
    { status: "REPLACED", paid: "10", estimate: "0.2" },
  ];
  const s = coinSummary(entries, 50);
  assert.ok(Math.abs(s.bought - 0.45) < 1e-12);
  assert.equal(s.spent, 25);
  assert.ok(Math.abs(s.avgPrice - 25 / 0.45) < 1e-9);
  assert.ok(Math.abs(s.worth - 22.5) < 1e-9);
  assert.ok(Math.abs(s.change + 2.5) < 1e-9);
  assert.ok(Math.abs(s.changePct + 10) < 1e-9);
  assert.equal(s.done, 2);
  assert.equal(s.missed, 1);
  assert.equal(coinSummary(entries, null).worth, null);
});

test("restart keep: progress and streak continue, the pause is closed", () => {
  const p = plan(weekly, { status: "paused", pauseRanges: [{ from: at("2026-11-10T00:00"), to: null }], bestStreak: 3 });
  const now = at("2026-11-20T12:00");
  const r = restartPlan(p, "keep", now);
  assert.equal(r.status, "active");
  assert.equal(r.progressFrom, START);
  assert.equal(r.streakFrom, START);
  assert.deepEqual(r.pauseRanges, [{ from: at("2026-11-10T00:00"), to: now }]);
  const entries = [done("2026-11-02T10:00"), done("2026-11-09T10:00"), done("2026-11-23T10:00")];
  assert.deepEqual(streak(r, entries, "2026-11-24T12:00"), { current: 3, best: 3 });
});

test("restart fresh: progress and streak from now, history and best kept", () => {
  const p = plan(weekly, { status: "finished", pauseRanges: [{ from: at("2026-11-10T00:00"), to: null }], bestStreak: 3 });
  const now = at("2026-11-20T12:00");
  const r = restartPlan(p, "fresh", now);
  assert.equal(r.progressFrom, now);
  assert.equal(r.streakFrom, now);
  const entries = [done("2026-11-02T10:00"), done("2026-11-09T10:00"), done("2026-11-23T10:00")];
  assert.equal(planProgress(r, entries).buys, 1);
  assert.deepEqual(streak(r, entries, "2026-11-24T12:00"), { current: 1, best: 3 });
});

test("a buy request not approved within 7 days counts as expired", async () => {
  const { expiredByAge } = await import("../src/stats.js");
  const created = at("2026-11-01T09:00");
  assert.equal(expiredByAge({ createdAt: created, approved: false }, at("2026-11-08T09:00")), false); // exactly 7 days
  assert.equal(expiredByAge({ createdAt: created, approved: false }, at("2026-11-08T09:01")), true);
  assert.equal(expiredByAge({ createdAt: created, approved: true }, at("2026-11-20T09:00")), false); // approved: on its way
});

const HYPE = { key: "hyperevm:0", symbol: "HYPE" };
const ETH = { key: "ethereum:0", symbol: "ETH" };
const clearSample = () => [
  done("2026-11-02T10:00", { coin: HYPE, received: "0.16" }),
  done("2026-11-09T10:00", { coin: ETH, received: "0.003" }),
  { planId: "p1", coin: HYPE, status: "MISSED", paid: "10", createdAt: at("2026-11-16T09:00") },
  { planId: "p1", coin: HYPE, status: "WAITING", paid: "10", estimate: "0.15", createdAt: at("2026-11-23T09:00") },
  { planId: "p1", coin: ETH, status: "PENDING", paid: "10", createdAt: at("2026-11-23T09:01") },
];

test("clear all history: past buys go, buys still waiting are kept", () => {
  const { remaining, deleted, kept } = clearHistoryEntries(clearSample(), null);
  assert.equal(deleted, 3);
  assert.equal(kept, 2);
  assert.deepEqual(remaining.map((e) => e.status), ["WAITING", "PENDING"]);
});

test("clear one coin: only that coin's past buys go", () => {
  const { remaining, deleted, kept } = clearHistoryEntries(clearSample(), HYPE.key);
  assert.equal(deleted, 2); // HYPE done + missed
  assert.equal(kept, 1); // HYPE waiting
  assert.deepEqual(remaining.map((e) => `${e.coin.symbol} ${e.status}`), ["ETH COMPLETED", "HYPE WAITING", "ETH PENDING"]);
});

test("after clearing, streak, best streak, average and goal progress start again", () => {
  const entries = [done("2026-11-02T10:00"), done("2026-11-09T10:00"), done("2026-11-16T10:00")];
  const before = plan(weekly, { bestStreak: 3 });
  assert.deepEqual(streak(before, entries, "2026-11-18T12:00"), { current: 3, best: 3 });
  const now = at("2026-11-18T12:00");
  const { remaining } = clearHistoryEntries(entries, null);
  const after = resetPlanStats(before, now);
  assert.equal(remaining.length, 0);
  assert.deepEqual(streak(after, remaining, "2026-11-18T13:00"), { current: 0, best: 0 });
  assert.equal(planProgress(after, remaining).buys, 0);
  assert.equal(averagePrice(remaining), null);
  // A buy that was kept (waiting) and completes later counts towards the new progress.
  const later = [done("2026-11-23T10:00")];
  assert.equal(planProgress(after, later).buys, 1);
  assert.deepEqual(streak(after, later, "2026-11-24T12:00"), { current: 1, best: 1 });
});
