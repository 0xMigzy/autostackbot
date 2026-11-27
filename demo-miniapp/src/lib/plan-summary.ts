/** Plain-words forecasts for plans, computed from the price and the real calendar. */
import type { CoinId } from "./coins";
import type { Plan, PlanStats, Stop } from "./demo-store";
import { formatAsset, formatDay, formatUsd, formatWeekdayDay } from "./format";
import {
  buysNeeded,
  describeSchedule,
  fromDateKey,
  nextBuy,
  nthBuy,
  upcomingBuys,
  type Timing,
} from "./schedule";

export interface PlanDraft extends Timing {
  coin: CoinId;
  amount: number;
  stop: Stop;
}

const NO_STATS: PlanStats = { bought: 0, spent: 0, count: 0 };

/** Upper bound for forecasts, so endless or tiny plans don't scan forever. */
const MAX_FORECAST_BUYS = 500;

/** When the plan reaches its goal or buy count, and how many buys that takes. */
export function finishForecast(
  plan: PlanDraft & Pick<Plan, "coveredUntil">,
  stats: PlanStats,
  price: number,
  now: Date,
): { buys: number; date: Date } | null {
  const perBuy = plan.amount / price;
  let left: number;
  switch (plan.stop.kind) {
    case "goal":
      left =
        plan.stop.unit === "coin"
          ? buysNeeded(plan.stop.value - stats.bought, perBuy)
          : buysNeeded(plan.stop.value - stats.spent, plan.amount);
      break;
    case "buys":
      left = Math.max(0, plan.stop.count - stats.count);
      break;
    default:
      return null;
  }
  if (left === 0 || left > MAX_FORECAST_BUYS) return null;
  const date = nthBuy(plan, now, left, plan.coveredUntil);
  return date ? { buys: left, date } : null;
}

/** e.g. "10 USDC every Monday, about 0.158 HYPE each time, you'll reach 1 HYPE around 11 Jan (7 buys)." */
export function planSummary(draft: PlanDraft, price: number, now: Date): string {
  const perBuy = draft.amount / price;
  const head = `${draft.amount} USDC ${describeSchedule(draft.schedule)}, about ${formatAsset(perBuy, draft.coin)} each time`;
  const plan = { ...draft, coveredUntil: null };
  const first = nextBuy(draft, now);
  if (!first) return `${head}.`;
  const firstText = `First buy ${formatWeekdayDay(first, now)} at ${draft.time}.`;
  const plural = (n: number) => `${n} ${n === 1 ? "buy" : "buys"}`;

  switch (draft.stop.kind) {
    case "never":
      return `${head}. ${firstText} It keeps going until you pause it.`;
    case "goal": {
      const eta = finishForecast(plan, NO_STATS, price, now);
      if (!eta) return `${head}. ${firstText}`;
      const when = formatDay(eta.date, now);
      if (draft.stop.unit === "coin") {
        return `${head}, you'll reach ${formatAsset(draft.stop.value, draft.coin)} around ${when} (${plural(eta.buys)}). ${firstText}`;
      }
      return `${head}, you'll have put in ${formatUsd(draft.stop.value)} around ${when} (${plural(eta.buys)}, about ${formatAsset(perBuy * eta.buys, draft.coin)}). ${firstText}`;
    }
    case "buys": {
      const eta = finishForecast(plan, NO_STATS, price, now);
      if (!eta) return `${head}. ${firstText}`;
      return `${head}, ${plural(eta.buys)} in total, about ${formatAsset(perBuy * eta.buys, draft.coin)}, the last one around ${formatDay(eta.date, now)}. ${firstText}`;
    }
    case "date": {
      const end = fromDateKey(draft.stop.date);
      const lastMoment = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59);
      const count = upcomingBuys(draft, now, MAX_FORECAST_BUYS, lastMoment).length;
      if (count === 0)
        return `${head}. No buys fall before ${formatDay(end, now)}, pick a later date.`;
      return `${head}, until ${formatDay(end, now)}: ${plural(count)}, about ${formatAsset(perBuy * count, draft.coin)} in total. ${firstText}`;
    }
  }
}
