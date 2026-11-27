/**
 * Demo state: pretend wallet, plans and buy history. A pure reducer plus localStorage
 * persistence; nothing here talks to a wallet or a server.
 */
import { ASSETS, WALLET_ORDER, isCoinId, type Asset, type CoinId } from "./coins";
import { roundTo } from "./format";
import { upcomingBuys, type Timing } from "./schedule";

export type Stop =
  | { kind: "never" }
  | { kind: "buys"; count: number }
  /** Last day (YYYY-MM-DD, inclusive) on which a buy may happen. */
  | { kind: "date"; date: string }
  /** Stop once `value` coins are bought (unit "coin") or `value` dollars are spent ("usd"). */
  | { kind: "goal"; unit: "coin" | "usd"; value: number };

export type PlanStatus = "active" | "paused" | "finished";

export interface Plan extends Timing {
  id: string;
  coin: CoinId;
  /** USDC spent per buy. */
  amount: number;
  stop: Stop;
  status: PlanStatus;
  createdAt: string;
  /** Latest due slot already covered by a buy (ISO), so "Buy now" moves the next buy on. */
  coveredUntil: string | null;
  streak: number;
  bestStreak: number;
}

export type BuyStatus = "done" | "waiting" | "missed";

export interface Buy {
  id: string;
  planId: string | null;
  coin: CoinId;
  /** USDC paid. */
  amount: number;
  /** Coins received (expected amount while waiting, 0 when missed). */
  coinAmount: number;
  /** USD per coin, null when missed. */
  price: number | null;
  /** The scheduled slot this buy belongs to (ISO). */
  dueAt: string;
  /** "now" = started with Buy now ahead of schedule. */
  kind: "scheduled" | "now";
  status: BuyStatus;
  approvedAt: string | null;
}

export type Wallet = Record<Asset, number>;

export interface DemoState {
  version: 1;
  wallet: Wallet;
  plans: Plan[];
  buys: Buy[];
}

export type DemoAction =
  | { type: "reset"; state: DemoState }
  | { type: "addPlan"; plan: Plan }
  | { type: "setAmount"; planId: string; amount: number }
  | { type: "pause"; planId: string }
  | { type: "restart"; planId: string }
  | { type: "deletePlan"; planId: string }
  | { type: "startBuy"; buy: Buy }
  | { type: "completeBuy"; buyId: string; at: string };

export const STORAGE_KEY = "autostack-demo-v2";
/** Saved demos from the weekly example; dropped so everyone starts from the daily one. */
const OLD_STORAGE_KEYS = ["autostack-demo-v1"];

/** `days` days before `now` (0 = today) at hh:mm local time, as ISO. */
const daysAgo = (now: Date, days: number, h: number, min: number) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, h, min).toISOString();

/** The starting point of the demo: 10 USDC of HYPE every day at 09:00, dated relative to today. */
export function seedState(now: Date = new Date()): DemoState {
  const planId = "plan-hype";
  return {
    version: 1,
    wallet: { USDC: 250, ETH: 0.005, HYPE: 0.317, BTC: 0, SOL: 0, LIT: 0 },
    plans: [
      {
        id: planId,
        coin: "HYPE",
        amount: 10,
        schedule: { kind: "daily" },
        time: "09:00",
        stop: { kind: "goal", unit: "coin", value: 1 },
        status: "active",
        createdAt: daysAgo(now, 4, 18, 30),
        coveredUntil: daysAgo(now, 1, 9, 0),
        streak: 2,
        bestStreak: 3,
      },
    ],
    buys: [
      {
        id: "buy-1",
        planId,
        coin: "HYPE",
        amount: 10,
        coinAmount: 0.159,
        price: roundTo(10 / 0.159, 4),
        dueAt: daysAgo(now, 1, 9, 0),
        kind: "scheduled",
        status: "done",
        approvedAt: daysAgo(now, 1, 9, 4),
      },
      {
        id: "buy-2",
        planId,
        coin: "HYPE",
        amount: 10,
        coinAmount: 0.158,
        price: roundTo(10 / 0.158, 4),
        dueAt: daysAgo(now, 2, 9, 0),
        kind: "scheduled",
        status: "done",
        approvedAt: daysAgo(now, 2, 18, 41),
      },
      {
        id: "buy-3",
        planId,
        coin: "HYPE",
        amount: 10,
        coinAmount: 0,
        price: null,
        dueAt: daysAgo(now, 3, 9, 0),
        kind: "scheduled",
        status: "missed",
        approvedAt: null,
      },
    ],
  };
}

export interface PlanStats {
  /** Coins bought by this plan. */
  bought: number;
  /** USDC spent by this plan. */
  spent: number;
  /** Completed buys. */
  count: number;
}

export function planStats(buys: Buy[], planId: string): PlanStats {
  let bought = 0;
  let spent = 0;
  let count = 0;
  for (const b of buys) {
    if (b.planId !== planId || b.status !== "done") continue;
    bought += b.coinAmount;
    spent += b.amount;
    count += 1;
  }
  return { bought, spent, count };
}

export interface CoinSummary {
  bought: number;
  spent: number;
  /** Average USD paid per coin, null when nothing was bought yet. */
  averagePrice: number | null;
}

export function coinSummary(buys: Buy[], coin: CoinId): CoinSummary {
  let bought = 0;
  let spent = 0;
  for (const b of buys) {
    if (b.coin !== coin || b.status !== "done") continue;
    bought += b.coinAmount;
    spent += b.amount;
  }
  return { bought, spent, averagePrice: bought > 0 ? spent / bought : null };
}

export interface GoalProgress {
  have: number;
  target: number;
  unit: "coin" | "usd";
  /** 0…1 */
  fraction: number;
}

export function goalProgress(plan: Plan, stats: PlanStats): GoalProgress | null {
  if (plan.stop.kind !== "goal" || plan.stop.value <= 0) return null;
  const have = plan.stop.unit === "coin" ? stats.bought : stats.spent;
  return {
    have,
    target: plan.stop.value,
    unit: plan.stop.unit,
    fraction: Math.min(1, have / plan.stop.value),
  };
}

/** True when the plan's stop rule is met after the buys so far, as of `at`. */
export function stopReached(plan: Plan, stats: PlanStats, at: Date): boolean {
  switch (plan.stop.kind) {
    case "never":
      return false;
    case "buys":
      return stats.count >= plan.stop.count;
    case "goal":
      return (plan.stop.unit === "coin" ? stats.bought : stats.spent) >= plan.stop.value - 1e-9;
    case "date": {
      const [y, m, d] = plan.stop.date.split("-").map(Number);
      const lastMoment = new Date(y, m - 1, d, 23, 59, 59);
      const after =
        plan.coveredUntil && new Date(plan.coveredUntil) > at ? new Date(plan.coveredUntil) : at;
      return upcomingBuys(plan, after, 1, lastMoment).length === 0;
    }
  }
}

function updatePlan(state: DemoState, planId: string, patch: (p: Plan) => Plan): DemoState {
  return { ...state, plans: state.plans.map((p) => (p.id === planId ? patch(p) : p)) };
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "reset":
      return action.state;
    case "addPlan":
      return { ...state, plans: [...state.plans, action.plan] };
    case "setAmount":
      return updatePlan(state, action.planId, (p) => ({ ...p, amount: action.amount }));
    case "pause":
      return updatePlan(state, action.planId, (p) =>
        p.status === "active" ? { ...p, status: "paused" } : p,
      );
    case "restart":
      return updatePlan(state, action.planId, (p) =>
        p.status === "paused" ? { ...p, status: "active" } : p,
      );
    case "deletePlan":
      // History stays; it records what happened in the wallet.
      return { ...state, plans: state.plans.filter((p) => p.id !== action.planId) };
    case "startBuy":
      return { ...state, buys: [action.buy, ...state.buys] };
    case "completeBuy": {
      const buy = state.buys.find((b) => b.id === action.buyId);
      if (!buy || buy.status !== "waiting") return state;
      const done: Buy = { ...buy, status: "done", approvedAt: action.at };
      const buys = state.buys.map((b) => (b.id === buy.id ? done : b));
      const wallet: Wallet = {
        ...state.wallet,
        USDC: roundTo(state.wallet.USDC - buy.amount, 6),
        [buy.coin]: roundTo(state.wallet[buy.coin] + buy.coinAmount, 8),
      };
      const at = new Date(action.at);
      const plans = state.plans.map((p): Plan => {
        if (p.id !== buy.planId) return p;
        const covered =
          p.coveredUntil && new Date(p.coveredUntil) > new Date(buy.dueAt)
            ? p.coveredUntil
            : buy.dueAt;
        const streak = p.streak + 1;
        const next: Plan = {
          ...p,
          coveredUntil: covered,
          streak,
          bestStreak: Math.max(p.bestStreak, streak),
        };
        return stopReached(next, planStats(buys, p.id), at)
          ? { ...next, status: "finished" }
          : next;
      });
      return { ...state, wallet, buys, plans };
    }
  }
}

/* ---------------------------------------------------------------- persistence */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isValidState(v: unknown): v is DemoState {
  if (!isObject(v) || v.version !== 1) return false;
  if (!isObject(v.wallet) || !Array.isArray(v.plans) || !Array.isArray(v.buys)) return false;
  const wallet = v.wallet;
  if (!WALLET_ORDER.every((a) => typeof wallet[a] === "number")) return false;
  return (
    v.plans.every((p) => isObject(p) && isCoinId(p.coin) && typeof p.amount === "number") &&
    v.buys.every((b) => isObject(b) && isCoinId(b.coin) && typeof b.amount === "number")
  );
}

/**
 * Reads the saved demo, or the seed when nothing valid is stored. Buys left waiting when the
 * app was closed are completed, as the demo always completes them on its own.
 */
export function loadState(now: Date): DemoState {
  let state = seedState(now);
  try {
    for (const key of OLD_STORAGE_KEYS) window.localStorage.removeItem(key);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isValidState(parsed)) state = parsed;
    }
  } catch {
    // Storage blocked or corrupt: start from the seed.
  }
  for (const b of state.buys) {
    if (b.status === "waiting") {
      state = demoReducer(state, { type: "completeBuy", buyId: b.id, at: now.toISOString() });
    }
  }
  return state;
}

export function saveState(state: DemoState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or storage full: the demo keeps working in memory.
  }
}

/** Coins a buy of `amount` USDC gets at `price`, keeping a few digits beyond what is shown. */
export function expectedCoins(amount: number, price: number, coin: CoinId): number {
  return roundTo(amount / price, Math.max(ASSETS[coin].decimals + 3, 6));
}
