// Scheduler and buy lifecycle: prepares buys, follows them, evaluates periods (missed, streaks), reminders and alerts.
// The bot listens to the events passed to init(); every buy request goes through requestBuy().
import { DateTime } from "luxon";
import * as Wallet from "./wallet.js";
import { USDC_COINGECKO_ID, isUsdc } from "./coins.js";
import { history, insertEntry, newId, save, state } from "./store.js";
import { dueAllowed, forecast, periodAt, periodsBetween, stopReason, upcomingDues } from "./schedule.js";
import { averagePrice, clearHistoryEntries, computeStreak, expiredByAge, isPausedAt, planProgress, resetPlanStats, restartPlan } from "./stats.js";
import { cheaperRoute, dipPercent, inQuietHours, nextReminderAt, routeFee, usdcNeeded } from "./alerts.js";

// The Tangem layer; tests swap it for a fake with useWalletForTests (test seam).
let W = Wallet;
export function useWalletForTests(fake) {
  W = { ...Wallet, ...fake };
}

export const DAILY_CAP = 3; // new buy requests per day, all plans together
const TICK_MS = 60_000;
const POLL_MS = 120_000;
const DIP_MS = 3_600_000;
// Unapproved requests are followed until Tangem reports them finished or they expire by age (expiredByAge).
const MAX_MISSED_PER_PASS = 60;

let tz = "Europe/London";
let cg = null;
let events = {};
const timers = [];

/** tz: IANA zone; coingecko: client from createCoinGecko; handlers: { buyReady, buyDone, buyMissed, buyExpired, buyFailed,
 * reminder, goalReached, planFinished, planProblem, lowUsdc, dip, cheaperRoute, moveTip, loginExpired } */
export function init({ zone, coingecko, handlers }) {
  tz = zone;
  cg = coingecko;
  events = handlers;
  // A PENDING entry means AutoStack stopped while creating the request: it may exist, so the plan pauses.
  for (const entry of history) {
    if (entry.status !== "PENDING") continue;
    entry.status = "ERROR";
    const plan = getPlan(entry.planId);
    if (plan?.status === "active") {
      pauseWithNote(plan, `AutoStack stopped while preparing your ${plan.coin.symbol} buy, so it may exist. Check the Tangem app, then restart the plan.`);
    }
  }
  save();
}

export const zone = () => tz;

function emit(name, ...args) {
  try {
    Promise.resolve(events[name]?.(...args)).catch((err) => console.error(`Event ${name}:`, err.message));
  } catch (err) {
    console.error(`Event ${name}:`, err.message);
  }
}

// ---- Lookups ----

export const getPlan = (id) => state.plans.find((p) => p.id === id) ?? null;
export const getEntry = (id) => history.find((e) => e.id === id) ?? null;
const localDay = (ms) => DateTime.fromMillis(ms, { zone: tz }).toISODate();
const isWaiting = (e) => e.status === "PENDING" || e.status === "WAITING";
export const waitingFor = (plan) => history.find((e) => e.planId === plan.id && isWaiting(e)) ?? null;
export const planEntries = (plan) => history.filter((e) => e.planId === plan.id);
export const progressOf = (plan) => planProgress(plan, history);

export function buysToday(now = Date.now()) {
  const today = localDay(now);
  return history.filter((e) => e.attempted && localDay(e.createdAt) === today).length;
}

const completedIn = (plan, period) =>
  history.some((e) => e.planId === plan.id && e.status === "COMPLETED" && e.completedAt >= period.start && e.completedAt < period.end);

export function streakOf(plan, now = Date.now()) {
  return computeStreak({ plan, entries: history, pauseRanges: state.globalPauseRanges, nowMs: now, tz });
}

function refreshStreak(plan, now = Date.now()) {
  const { current, best } = streakOf(plan, now);
  plan.lastStreak = current;
  plan.bestStreak = best;
  return { current, best };
}

// ---- Locking: every buy and plan change runs one at a time ----

let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

function openPause(ranges, now = Date.now()) {
  if (!ranges.some((r) => r.to == null)) ranges.push({ from: now, to: null });
}
function closePause(ranges, now = Date.now()) {
  for (const r of ranges) if (r.to == null) r.to = now;
}

/** When the plan's next scheduled buy will be prepared (skips periods already covered or completed), or null. */
export function nextBuyAt(plan, now = Date.now()) {
  if (plan.status !== "active") return null;
  for (const due of upcomingDues(plan.schedule, now, 3, tz, plan.stop)) {
    const period = periodAt(plan.schedule, due, tz);
    if (period.key !== plan.lastPreparedKey && !completedIn(plan, period)) return due;
  }
  return null;
}

/** Forecast for a plan; perBuyCoin defaults to the average received per completed buy. */
export function forecastOf(plan, perBuyCoin = null, now = Date.now()) {
  const progress = progressOf(plan);
  const perBuy = perBuyCoin ?? (progress.buys ? progress.received / progress.buys : null);
  return forecast({ schedule: plan.schedule, stop: plan.stop, amount: plan.amount, progress, perBuyCoin: perBuy, nowMs: now, tz });
}

function pauseWithNote(plan, note) {
  plan.status = "paused";
  plan.note = note;
  openPause((plan.pauseRanges ??= []));
  save();
  emit("planProblem", plan, note);
}

// ---- Buy requests ----

function assertCanBuy(plan, { replacing = false } = {}) {
  const sym = plan.coin.symbol;
  if (!state.plans.includes(plan)) throw new W.UserError("This plan was deleted.");
  if (state.pausedAll) throw new W.UserError("Everything is paused. Resume with /pause first.");
  if (plan.status !== "active") throw new W.UserError(`Your ${sym} plan is ${plan.status}. Restart it first.`);
  if (buysToday() >= DAILY_CAP) throw new W.UserError(`You've reached today's limit of ${DAILY_CAP} buys. Try again tomorrow.`);
  if (!replacing && waitingFor(plan)) {
    const err = new W.UserError(`Your ${sym} buy is still waiting. Approve it in Tangem, or get a fresh price.`);
    err.waiting = waitingFor(plan);
    throw err;
  }
}

/** Wallet assets for a plan's buy: the USDC paid with, the coin bought, and the address receiving it. */
async function buyAssets(plan, payKey = plan.pay.key) {
  const wallet = await W.loadWallet();
  const from = wallet.find((t) => t.key === payKey);
  if (!from?.address) throw new W.UserError(`Your ${plan.pay.symbol} on ${plan.pay.networkName} isn't in your Tangem wallet anymore.`);
  const coinInWallet = wallet.find((t) => t.key === plan.coin.key);
  const to = { ...plan.coin, decimals: coinInWallet?.decimals ?? plan.coin.decimals };
  const payout = await W.addressOn(plan.coin.network);
  if (!payout) {
    throw new W.UserError(`Add the ${await W.networkName(plan.coin.network)} network in Tangem so there's an address to receive ${plan.coin.symbol}.`);
  }
  return { from, to, payout };
}

/**
 * Prepares ONE buy request (one express__exchange_intent_create call, never retried). Call under withLock.
 * kind: "scheduled" | "now" | "fresh". Checks run again after the price awaits, so a pause or the cap meanwhile stops it.
 * coversPeriod: the buy stands for the current period, so that period's scheduled buy won't fire (scheduled buys,
 * and the first buy of a plan started with "Buy now").
 */
async function requestBuy(plan, { kind, replaces = null, amount = plan.amount, coversPeriod = kind === "scheduled" }) {
  assertCanBuy(plan, { replacing: Boolean(replaces) });
  const { from, to, payout } = await buyAssets(plan);
  const { amountMinor, best } = await W.bestPrice(from, to, amount);
  assertCanBuy(plan, { replacing: Boolean(replaces) });

  const now = Date.now();
  const period = periodAt(plan.schedule, now, tz);
  const entry = {
    id: newId(),
    planId: plan.id,
    periodKey: period.key,
    kind,
    coin: { symbol: to.symbol, name: to.name, network: to.network, contractAddress: to.contractAddress, key: to.key, coingeckoId: to.coingeckoId },
    pay: { symbol: from.symbol, network: from.network, networkName: from.networkName, contractAddress: from.contractAddress, key: from.key },
    paid: String(amount),
    estimate: best.toAmount,
    received: null,
    requestId: null,
    link: null,
    status: "PENDING",
    attempted: true, // counts toward the daily cap whatever happens next
    approved: false,
    createdAt: now,
    completedAt: null,
    lastReminderAt: now,
    replaces: replaces?.id ?? null,
  };
  insertEntry(entry);
  if (coversPeriod) plan.lastPreparedKey = period.key;
  save();

  let problem = null;
  try {
    const { requestId, link } = await W.createBuyRequest({ from, to, fromAddress: from.address, payoutAddress: payout, amountMinor, best });
    Object.assign(entry, { status: "WAITING", requestId, link });
    if (replaces && replaces.status !== "EXPIRED") replaces.status = "REPLACED";
    if (replaces) replaces.replacedBy = entry.id;
    console.log(`Plan ${plan.id}: buy request ${requestId} (${kind})`);
    save();
    return entry;
  } catch (err) {
    // Only a non-retryable tool error is a definite failure; otherwise the request may have been stored.
    const definite = err instanceof W.ToolError && !err.retryable;
    entry.status = definite ? "FAILED" : "ERROR";
    problem = definite
      ? `Tangem couldn't prepare your ${plan.coin.symbol} buy: ${err.message}. The plan is paused; restart it when you're ready.`
      : `Something went wrong preparing your ${plan.coin.symbol} buy, and it may exist anyway. Check the Tangem app before anything else. The plan is paused.`;
    throw err;
  } finally {
    if (problem) pauseWithNote(plan, problem);
  }
}

/** Buy now (from /plans or a price dip). Counts for the current period if nothing completed in it yet. */
export function buyNow(planId) {
  return withLock(async () => {
    const plan = getPlan(planId);
    if (!plan) throw new W.UserError("This plan was deleted.");
    const entry = await requestBuy(plan, { kind: "now" });
    emit("buyReady", entry, plan, {});
    afterPrepared(plan, entry);
    return entry;
  });
}

/** Get a fresh price for a waiting or expired buy: ONE new request; the old one is marked replaced. */
export function freshPrice(entryId) {
  return withLock(async () => {
    const old = getEntry(entryId);
    if (!old) throw new W.UserError("I can't find that buy anymore.");
    const plan = getPlan(old.planId);
    if (!plan) throw new W.UserError("This plan was deleted.");
    if (old.replacedBy) throw new W.UserError("This buy already has a fresh price.");
    if (old.status === "COMPLETED") throw new W.UserError("That buy already went through.");
    if (old.requestId && ["WAITING", "MISSED"].includes(old.status)) {
      const live = await W.buyStatus(old.requestId);
      if (live.approved) {
        applyStatus(old, live);
        save();
        throw new W.UserError("You already approved that buy, so it's on its way.");
      }
    }
    const wasExpired = old.status === "EXPIRED";
    const entry = await requestBuy(plan, { kind: "fresh", replaces: old, amount: old.paid });
    emit("buyReady", entry, plan, { replaced: old, wasExpired });
    afterPrepared(plan, entry);
    return entry;
  });
}

// ---- Scheduler ----

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const plan of [...state.plans]) {
      try {
        await withLock(() => tickPlan(plan, now));
      } catch (err) {
        if (W.isAuthError(err)) {
          emit("loginExpired");
          return;
        }
        console.error(`Plan ${plan.id}:`, err.message);
      }
    }
    remindersTick(now);
    await lowUsdcTick(now).catch((err) => (W.isAuthError(err) ? emit("loginExpired") : console.error("Low USDC check:", err.message)));
  } finally {
    ticking = false;
  }
}

/** Ended periods since the last pass: a period with no completed buy (and not paused) is missed. */
function evaluatePeriods(plan, now) {
  const from = plan.evaluatedUntil ?? plan.startAt;
  const ranges = [...(plan.pauseRanges ?? []), ...state.globalPauseRanges];
  let missedCount = 0;
  for (const p of periodsBetween(plan.schedule, from, now, tz)) {
    if (p.end > now || p.end <= from) continue;
    plan.evaluatedUntil = p.end;
    if (p.due < plan.startAt || isPausedAt(ranges, p.due) || isPausedAt(ranges, p.end - 1) || completedIn(plan, p)) continue;
    if (missedCount++ >= MAX_MISSED_PER_PASS) continue;
    const before = plan.lastStreak ?? 0;
    const waiting = history.filter((e) => e.planId === plan.id && e.periodKey === p.key && isWaiting(e));
    for (const entry of waiting) {
      entry.status = "MISSED";
      emit("buyMissed", entry, plan);
    }
    if (!history.some((e) => e.planId === plan.id && e.periodKey === p.key)) {
      insertEntry({
        id: newId(), planId: plan.id, periodKey: p.key, kind: "scheduled", coin: plan.coin, pay: plan.pay,
        paid: plan.amount, estimate: null, received: null, requestId: null, link: null, status: "MISSED",
        attempted: false, approved: false, createdAt: p.due, completedAt: null,
      });
    }
    if (before > 0) plan.streakNotice = { best: plan.bestStreak ?? before };
    plan.lastStreak = 0;
  }
}

async function tickPlan(plan, now) {
  if (!state.plans.includes(plan)) return;
  evaluatePeriods(plan, now);
  refreshStreak(plan, now);
  if (plan.status !== "active") return save();

  if (stopReason(plan.stop, progressOf(plan), now, tz) === "date") return finishPlan(plan, "date");
  if (state.pausedAll) return save();

  const p = periodAt(plan.schedule, now, tz);
  if (p.due > now || p.due < plan.startAt || plan.lastPreparedKey === p.key) return save();
  if (!dueAllowed(plan.stop, p.due, tz) || completedIn(plan, p) || waitingFor(plan)) return save();
  if (buysToday(now) >= DAILY_CAP) {
    if (plan.capNoticeKey !== p.key) {
      plan.capNoticeKey = p.key;
      emit("planProblem", plan, `Today's limit of ${DAILY_CAP} buys is reached, so your ${plan.coin.symbol} buy waits until tomorrow.`);
    }
    return save();
  }

  let entry;
  try {
    entry = await requestBuy(plan, { kind: "scheduled" });
  } catch (err) {
    if (W.isAuthError(err) || plan.status !== "active") throw err; // auth, or the request itself failed (plan paused)
    if (plan.priceProblemKey !== p.key) {
      plan.priceProblemKey = p.key; // tell once per period; the price is checked again next minute
      emit("planProblem", plan, `${err.message} I'll keep trying.`);
    }
    return save();
  }
  const streakNotice = plan.streakNotice;
  plan.streakNotice = null;
  save();
  emit("buyReady", entry, plan, { streakNotice });
  afterPrepared(plan, entry);
}

// ---- Following requests ----

function applyStatus(entry, live, now = Date.now()) {
  entry.approved = entry.approved || live.approved;
  if (live.status === "COMPLETED") {
    entry.status = "COMPLETED";
    entry.completedAt = now;
    if (live.received) entry.received = live.received;
  } else if (live.status === "FAILED" || live.status === "EXPIRED") {
    entry.status = live.status;
  } else if (expiredByAge(entry, now)) {
    entry.status = "EXPIRED"; // never approved within 7 days: no new request is made
  }
}

async function pollRequests() {
  const followed = history.filter((e) => e.requestId && (e.status === "WAITING" || e.status === "MISSED"));
  for (const entry of followed) {
    let live;
    try {
      live = await W.buyStatus(entry.requestId);
    } catch (err) {
      if (W.isAuthError(err)) return emit("loginExpired");
      console.error(`Buy ${entry.id}: status check failed:`, err.message);
      continue;
    }
    const before = entry.status;
    await withLock(async () => {
      applyStatus(entry, live);
      const plan = getPlan(entry.planId);
      if (entry.status === "COMPLETED" && before !== "COMPLETED") {
        if (plan) refreshStreak(plan);
        save();
        emit("buyDone", entry, plan);
        if (plan?.status === "active") {
          const reason = stopReason(plan.stop, progressOf(plan), Date.now(), tz);
          if (reason) finishPlan(plan, reason);
        }
      } else if (entry.status !== before) {
        save();
        if (plan) emit(entry.status === "EXPIRED" ? "buyExpired" : "buyFailed", entry, plan);
      } else {
        save();
      }
    });
  }
}

function finishPlan(plan, reason) {
  plan.status = "finished";
  plan.finishedReason = reason;
  openPause((plan.pauseRanges ??= []));
  save();
  emit(reason === "goal" ? "goalReached" : "planFinished", plan);
}

function remindersTick(now) {
  const { reminderHours, quiet } = state.settings;
  if (!reminderHours || state.pausedAll) return;
  for (const entry of history) {
    if (entry.status !== "WAITING" || entry.approved || !entry.requestId) continue;
    const plan = getPlan(entry.planId);
    if (!plan || plan.status !== "active") continue;
    const due = nextReminderAt(entry.lastReminderAt ?? entry.createdAt, reminderHours, quiet, tz);
    if (due == null || now < due) continue;
    entry.lastReminderAt = now;
    save();
    emit("reminder", entry, plan);
  }
}

// ---- Alerts ----

/** The day before a buy: is the USDC it pays with (plus everything due in the next 7 days) there? */
async function lowUsdcTick(now) {
  if (!state.settings.lowUsdc || state.pausedAll || inQuietHours(now, state.settings.quiet, tz)) return;
  const active = state.plans.filter((p) => p.status === "active");
  for (const payKey of new Set(active.map((p) => p.pay.key))) {
    const plans = active.filter((p) => p.pay.key === payKey);
    const nextDue = Math.min(...plans.map((p) => upcomingDues(p.schedule, now, 1, tz, p.stop)[0] ?? Infinity));
    if (!Number.isFinite(nextDue) || nextDue - now > 86_400_000 || state.alerts.lowUsdc[payKey] === nextDue) continue;
    state.alerts.lowUsdc[payKey] = nextDue;
    save();
    const wallet = await W.loadWallet();
    const usdcTokens = wallet.filter((t) => isUsdc(t) && t.address);
    const balances = await W.loadBalances(usdcTokens);
    const payToken = wallet.find((t) => t.key === payKey);
    const have = payToken && balances.has(payKey) ? Number(balances.get(payKey)) : null;
    const { total: need } = usdcNeeded(state.plans, payKey, now, tz, 7);
    const uncounted = usdcTokens.filter((t) => t.key !== payKey && !balances.has(t.key)).map((t) => t.networkName);
    if (have == null || have < need) {
      emit("lowUsdc", { payToken: payToken ?? plans[0].pay, have, need, nextDue, uncounted, plans });
    }
  }
}

/** Hourly, one batched price call: a coin ≥10% below your average buy price (once a day per coin). */
async function dipTick() {
  const now = Date.now();
  if (inQuietHours(now, state.settings.quiet, tz)) return;
  const byCoin = new Map();
  for (const e of history) {
    if (e.status !== "COMPLETED" || !e.coin?.coingeckoId) continue;
    byCoin.set(e.coin.key, [...(byCoin.get(e.coin.key) ?? []), e]);
  }
  if (!byCoin.size) return;
  const ids = [...new Set([...byCoin.values()].map((list) => list[0].coin.coingeckoId))];
  let prices;
  try {
    ({ prices } = await cg.getPrices([...ids, USDC_COINGECKO_ID]));
  } catch (err) {
    return console.error("Price dip check:", err.message);
  }
  const today = localDay(now);
  for (const [key, entries] of byCoin) {
    const coin = entries[0].coin;
    const price = prices[coin.coingeckoId]?.usd;
    const avg = averagePrice(entries);
    const pct = dipPercent(price, avg);
    if (pct == null || state.alerts.dip[key] === today) continue;
    state.alerts.dip[key] = today;
    save();
    const plan = state.plans.find((p) => p.coin.key === key && p.status === "active") ?? null;
    emit("dip", { coin, pct, price, avg, plan });
  }
}

/** After a buy is prepared: is paying with USDC on another network clearly cheaper? Read-only prices only. */
function afterPrepared(plan, entry) {
  checkCheaperRoute(plan, entry).catch((err) => console.error("Cheaper route check:", err.message));
}

async function checkCheaperRoute(plan, entry) {
  const price = cg.peekPrices([plan.coin.coingeckoId]).prices[plan.coin.coingeckoId]?.usd;
  if (!price || !entry.estimate) return;
  const amount = Number(entry.paid);
  const currentFee = routeFee(amount, Number(entry.estimate), price);
  const wallet = await W.getWallet();
  const others = wallet.filter((t) => isUsdc(t) && t.address && t.key !== plan.pay.key && !(plan.keepPay ?? []).includes(t.key));
  const balances = others.length ? await W.loadBalances(others) : new Map();
  const held = others.filter((t) => !balances.has(t.key) || Number(balances.get(t.key)) >= amount);
  const alternatives = [];
  for (const token of held) {
    try {
      const { best } = await W.bestPrice(token, { ...plan.coin }, entry.paid);
      alternatives.push({ token, fee: routeFee(amount, Number(best.toAmount), price) });
    } catch {
      // that network can't buy this coin right now
    }
  }
  const decision = cheaperRoute({ amountUsd: amount, currentFee, alternatives: held.length ? alternatives : [] });
  if (decision?.type === "switch") emit("cheaperRoute", plan, { alt: decision.alt.token, currentFee, altFee: decision.alt.fee });
  else if (decision?.type === "move" && !plan.moveTipShown) {
    plan.moveTipShown = true;
    save();
    emit("moveTip", plan, { currentFee });
  }
}

// ---- Plan changes ----

/**
 * Creates a plan from draft { coin, pay, amount, schedule, stop }. With buyNow, ONE buy request is prepared right away
 * and covers the current period (its scheduled buy won't fire again); otherwise the first buy is the next due time.
 * Returns { plan, entry, error }: error is set when the first buy couldn't be prepared (the plan still runs).
 */
export function startPlan(draft, { buyNow = false } = {}) {
  return withLock(async () => {
    const now = Date.now();
    const plan = {
      id: newId(),
      coin: draft.coin,
      pay: draft.pay,
      amount: draft.amount,
      schedule: draft.schedule,
      stop: draft.stop,
      status: "active",
      startAt: now,
      progressFrom: now,
      streakFrom: now,
      bestStreak: 0,
      lastStreak: 0,
      pauseRanges: [],
      lastPreparedKey: null,
      evaluatedUntil: now,
      note: null,
      createdAt: now,
    };
    state.plans.push(plan);
    save();
    if (!buyNow) return { plan, entry: null, error: null };
    try {
      const entry = await requestBuy(plan, { kind: "now", coversPeriod: true });
      save();
      emit("buyReady", entry, plan, {});
      afterPrepared(plan, entry);
      return { plan, entry, error: null };
    } catch (err) {
      if (W.isAuthError(err)) throw err;
      return { plan, entry: null, error: err };
    }
  });
}

const mutate = (planId, fn) =>
  withLock(async () => {
    const plan = getPlan(planId);
    if (!plan) throw new W.UserError("This plan was deleted.");
    const result = await fn(plan);
    save();
    return result ?? plan;
  });

/** New amount (validated against the USDC's decimals); applies from the next buy. */
export const editAmount = (planId, amount) =>
  mutate(planId, async (plan) => {
    const pay = (await W.getWallet()).find((t) => t.key === plan.pay.key);
    W.toMinor(amount, pay?.decimals ?? 6);
    plan.amount = String(Number(amount));
  });

export const editStop = (planId, stop) => mutate(planId, (plan) => void (plan.stop = stop));

export const setPay = (planId, token) =>
  mutate(planId, (plan) => {
    plan.pay = { symbol: token.symbol, network: token.network, networkName: token.networkName, contractAddress: token.contractAddress, key: token.key };
  });

export const keepPay = (planId, tokenKey) => mutate(planId, (plan) => void (plan.keepPay = [...(plan.keepPay ?? []), tokenKey]));

export const pausePlan = (planId) =>
  mutate(planId, (plan) => {
    if (plan.status !== "active") return;
    plan.status = "paused";
    openPause((plan.pauseRanges ??= []));
  });

export const restart = (planId, mode) =>
  mutate(planId, (plan) => {
    const restarted = restartPlan(plan, mode, Date.now());
    if (mode === "fresh") restarted.evaluatedUntil = restarted.startAt;
    Object.assign(plan, restarted, { finishedReason: null, priceProblemKey: null });
  });

/** After a goal: a new goal of twice the target ("double"), no goal ("none"), or stay finished ("stop"). */
export const afterGoal = (planId, choice) =>
  mutate(planId, (plan) => {
    if (choice === "stop") return;
    plan.stop = choice === "double" ? { ...plan.stop, target: String(Number(plan.stop.target) * 2) } : { type: "never" };
    Object.assign(plan, restartPlan(plan, "keep", Date.now()), { finishedReason: null });
  });

export const deletePlan = (planId) =>
  withLock(async () => {
    const plan = getPlan(planId);
    state.plans = state.plans.filter((p) => p.id !== planId);
    save();
    return plan;
  });

export function setPausedAll(paused) {
  return withLock(async () => {
    state.pausedAll = paused;
    if (paused) openPause(state.globalPauseRanges);
    else closePause(state.globalPauseRanges);
    save();
  });
}

/** Deletes every plan (and so their streaks). History and wallet are untouched. */
export const startOver = () =>
  withLock(async () => {
    state.plans = [];
    save();
  });

/**
 * Clears past buys for one coin (coinKey) or all coins (null). Buys still in progress are kept. Plans keep running,
 * but the affected plans' streak, best streak, average and goal progress start again from now.
 * Returns { deleted, kept }.
 */
export const clearHistory = (coinKey = null) =>
  withLock(async () => {
    const { remaining, deleted, kept } = clearHistoryEntries(history, coinKey);
    history.splice(0, history.length, ...remaining);
    const now = Date.now();
    for (const plan of state.plans) {
      if (coinKey == null || plan.coin.key === coinKey) Object.assign(plan, resetPlanStats(plan, now));
    }
    save();
    return { deleted, kept };
  });

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  save();
}

// ---- Start / stop ----

export function start() {
  timers.push(setInterval(tick, TICK_MS), setInterval(pollRequests, POLL_MS), setInterval(dipTick, DIP_MS));
  setTimeout(tick, 5_000);
  setTimeout(pollRequests, 15_000);
}

/** Test seam: one scheduler pass on demand. */
export const tickForTests = () => tick();

export function stop() {
  timers.splice(0).forEach(clearInterval);
}
