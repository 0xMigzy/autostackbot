import { CalendarClock, Flame, Scale, Target } from "lucide-react";

import { AppHeader } from "@/components/app-header";
import { CoinLogo } from "@/components/coin-logo";
import { MainAction, SCREEN_BOTTOM_PADDING } from "@/components/main-action";
import { PriceSourceLabel } from "@/components/price-source";
import { ProgressRing } from "@/components/progress-ring";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDemoStore } from "@/hooks/use-demo-store";
import { useNow } from "@/hooks/use-now";
import { WALLET_ORDER } from "@/lib/coins";
import { goalProgress, planStats, type Plan } from "@/lib/demo-store";
import { formatAmount, formatAsset, formatDay, formatUsd } from "@/lib/format";
import { finishForecast } from "@/lib/plan-summary";
import { usePrices } from "@/lib/prices";
import { countdown, nextBuy, streakUnit, WEEKDAY_LONG, weekdayOf } from "@/lib/schedule";
import { cn } from "@/lib/utils";

interface HomeScreenProps {
  /** True while the buy sheet covers Home, so the ring animates once it closes. */
  holdRing: boolean;
  onBuyNow: (plan: Plan) => void;
  onBrowse: () => void;
  onReset: () => void;
}

export function HomeScreen({ holdRing, onBuyNow, onBrowse, onReset }: HomeScreenProps) {
  const { state } = useDemoStore();
  const { quotes, source } = usePrices();
  const now = useNow();

  const total = WALLET_ORDER.reduce((sum, a) => sum + state.wallet[a] * quotes[a].price, 0);
  const holdings = WALLET_ORDER.filter((a) => state.wallet[a] > 0);
  const plan = state.plans.find((p) => p.status === "active") ?? state.plans[0];

  return (
    <div className={cn("flex flex-col gap-3", SCREEN_BOTTOM_PADDING)}>
      <AppHeader onReset={onReset} />

      <section aria-labelledby="balance-title" className="px-4">
        <Card>
          <h2 id="balance-title" className="text-muted-foreground text-[13px] font-medium">
            Demo wallet
          </h2>
          <p className="mt-1 text-[34px] leading-tight font-semibold tracking-tight tabular-nums">
            {formatUsd(total)}
          </p>
          <PriceSourceLabel source={source} />
          <ul className="mt-4 flex flex-wrap gap-2" aria-label="Holdings">
            {holdings.map((a) => (
              <li
                key={a}
                className="bg-chip flex h-10 items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm font-medium tabular-nums"
              >
                <CoinLogo asset={a} size={32} />
                {formatAsset(state.wallet[a], a)}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {plan ? (
        <PlanOverview plan={plan} holdRing={holdRing} now={now} />
      ) : (
        <section className="px-4">
          <Card className="flex flex-col items-start gap-3">
            <h2 className="text-lg font-semibold">No plan yet</h2>
            <p className="text-muted-foreground text-sm">
              Pick a coin and AutoStack buys a little on a schedule.
            </p>
            <Button variant="secondary" onClick={onBrowse}>
              Browse coins
            </Button>
          </Card>
        </section>
      )}

      <footer className="text-muted-foreground px-4 pt-3 text-center text-xs">
        AutoStack · works with Tangem · not affiliated with Tangem
      </footer>

      {plan && plan.status === "active" ? (
        <MainAction text="Buy now (demo)" onClick={() => onBuyNow(plan)} />
      ) : (
        <MainAction text="Set up a plan" onClick={onBrowse} />
      )}
    </div>
  );
}

function PlanOverview({ plan, holdRing, now }: { plan: Plan; holdRing: boolean; now: Date }) {
  const { state } = useDemoStore();
  const { quotes } = usePrices();
  const price = quotes[plan.coin].price;
  const stats = planStats(state.buys, plan.id);
  const goal = goalProgress(plan, stats);
  const eta = plan.status === "active" ? finishForecast(plan, stats, price, now) : null;
  const next = plan.status === "active" ? nextBuy(plan, now, plan.coveredUntil) : null;
  const average = stats.bought > 0 ? stats.spent / stats.bought : null;

  return (
    <>
      <section aria-labelledby="goal-title" className="px-4">
        <Card className="flex items-center gap-4">
          <ProgressRing
            value={goal?.fraction ?? 0}
            hold={holdRing}
            label={`Goal progress for ${plan.coin}`}
          >
            <span className="text-xl font-semibold tabular-nums">
              {Math.round((goal?.fraction ?? 0) * 100)}%
            </span>
          </ProgressRing>
          <div className="min-w-0">
            <h2
              id="goal-title"
              className="text-muted-foreground flex items-center gap-1.5 text-[13px] font-medium"
            >
              <Target className="size-4" aria-hidden />
              {goal ? "Goal" : "Bought so far"}
            </h2>
            {goal ? (
              <p className="mt-1 text-lg leading-snug font-semibold tabular-nums">
                {goal.unit === "coin"
                  ? `${formatAmount(goal.have, plan.coin)} of ${formatAsset(goal.target, plan.coin)}`
                  : `${formatUsd(goal.have)} of ${formatUsd(goal.target)}`}
              </p>
            ) : (
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatAsset(stats.bought, plan.coin)}
              </p>
            )}
            <p className="text-muted-foreground mt-0.5 text-sm">
              {plan.status === "finished"
                ? "Goal reached"
                : plan.status === "paused"
                  ? "Plan paused"
                  : eta
                    ? `On track for ${formatDay(eta.date, now)}`
                    : "Keeps buying on schedule"}
            </p>
          </div>
        </Card>
      </section>

      <section aria-label="Streak and average price" className="grid grid-cols-2 gap-3 px-4">
        <Card className="flex flex-col gap-1">
          <h2 className="text-muted-foreground flex items-center gap-1.5 text-[13px] font-medium">
            <Flame className="text-flame size-4" aria-hidden />
            Streak
          </h2>
          <p className="text-2xl font-semibold tabular-nums">
            {plan.streak}{" "}
            <span className="text-base font-medium">{streakUnit(plan.schedule, plan.streak)}</span>
          </p>
          <p className="text-muted-foreground text-xs">in a row · best {plan.bestStreak}</p>
        </Card>
        <Card className="flex flex-col gap-1">
          <h2 className="text-muted-foreground flex items-center gap-1.5 text-[13px] font-medium">
            <Scale className="size-4" aria-hidden />
            Average price
          </h2>
          <p className="text-2xl font-semibold tabular-nums">
            {average !== null ? formatUsd(average) : "—"}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            per {plan.coin}
            <span className="block">now {formatUsd(price)}</span>
          </p>
        </Card>
      </section>

      <section aria-labelledby="next-title" className="px-4">
        <Card className="flex items-center gap-3">
          <span className="bg-chip grid size-10 shrink-0 place-items-center rounded-full">
            <CalendarClock className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="next-title" className="text-muted-foreground text-[13px] font-medium">
              Next buy
            </h2>
            {next ? (
              <>
                <p className="font-semibold tabular-nums">
                  {WEEKDAY_LONG[weekdayOf(next)]} {plan.time} · {plan.amount} USDC → {plan.coin}
                </p>
                <p className="text-muted-foreground text-sm tabular-nums">
                  {countdown(next, now)} · {formatDay(next, now)}
                </p>
              </>
            ) : (
              <p className="font-semibold">
                {plan.status === "paused" ? "Paused" : "No more buys planned"}
              </p>
            )}
          </div>
        </Card>
      </section>
    </>
  );
}
