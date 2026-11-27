import { useState } from "react";

import { AppHeader } from "@/components/app-header";
import { ChipGroup } from "@/components/chip-group";
import { CoinLogo } from "@/components/coin-logo";
import { SCREEN_BOTTOM_PADDING } from "@/components/main-action";
import { PriceSourceLabel } from "@/components/price-source";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useDemoStore } from "@/hooks/use-demo-store";
import { useNow } from "@/hooks/use-now";
import { ASSETS, COIN_IDS, type CoinId } from "@/lib/coins";
import { coinSummary, type Buy } from "@/lib/demo-store";
import { formatAsset, formatPercent, formatUsd, formatWeekdayDay } from "@/lib/format";
import { usePrices } from "@/lib/prices";
import { toDateKey, WEEKDAY_SHORT, weekdayOf } from "@/lib/schedule";
import { cn } from "@/lib/utils";

type Filter = CoinId | "all";

export function HistoryScreen({ onReset }: { onReset: () => void }) {
  const { state } = useDemoStore();
  const coins = COIN_IDS.filter((c) => state.buys.some((b) => b.coin === c));
  const [picked, setPicked] = useState<Filter | null>(null);
  // Default to the coin of the first plan with history; fall back to "all".
  const filter: Filter =
    picked && (picked === "all" || coins.includes(picked)) ? picked : (coins[0] ?? "all");
  const buys = filter === "all" ? state.buys : state.buys.filter((b) => b.coin === filter);

  return (
    <div className={cn("flex flex-col gap-3", SCREEN_BOTTOM_PADDING)}>
      <AppHeader title="History" onReset={onReset} />

      {coins.length > 0 && (
        <div className="px-4">
          <ChipGroup
            label="Show coin"
            value={filter}
            onChange={setPicked}
            className="flex flex-wrap gap-2"
            options={[
              { value: "all", label: "All" },
              ...coins.map((c) => ({
                value: c,
                label: c,
                ariaLabel: ASSETS[c].name,
              })),
            ]}
          />
        </div>
      )}

      {filter !== "all" && <CoinSummaryCard coin={filter} />}

      <section aria-label="Buys" className="px-4">
        <Card className="p-1.5">
          {buys.length === 0 ? (
            <p className="text-muted-foreground p-4 text-center text-sm">No buys yet.</p>
          ) : (
            <ul className="divide-border divide-y">
              {buys.map((b) => (
                <BuyRow key={b.id} buy={b} />
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}

function CoinSummaryCard({ coin }: { coin: CoinId }) {
  const { state } = useDemoStore();
  const { quotes, source } = usePrices();
  const summary = coinSummary(state.buys, coin);
  const price = quotes[coin].price;
  const worth = summary.bought * price;
  const gain = worth - summary.spent;
  const gainPct = summary.spent > 0 ? (gain / summary.spent) * 100 : 0;
  const up = gain >= 0;

  const cell = (label: string, value: string) => (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );

  return (
    <section aria-labelledby="coin-summary-title" className="px-4">
      <Card className="flex flex-col gap-3">
        <h2 id="coin-summary-title" className="text-muted-foreground text-[13px] font-medium">
          {ASSETS[coin].name} summary
        </h2>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-3">
          {cell("Total bought", formatAsset(summary.bought, coin))}
          {cell("Total spent", formatUsd(summary.spent))}
          {cell("Average price", summary.averagePrice ? formatUsd(summary.averagePrice) : "—")}
          {cell("Price now", formatUsd(price))}
        </dl>
        <div className="bg-raised flex items-end justify-between gap-3 rounded-xl p-3">
          <div>
            <p className="text-muted-foreground text-xs">Worth now</p>
            <p className="text-2xl font-semibold tabular-nums">{formatUsd(worth)}</p>
          </div>
          {summary.spent > 0 && (
            <p
              className={cn(
                "text-right text-sm font-semibold tabular-nums",
                up ? "text-positive" : "text-negative",
              )}
            >
              <span aria-hidden>{up ? "▲" : "▼"} </span>
              <span className="sr-only">{up ? "Up" : "Down"} </span>
              {formatUsd(Math.abs(gain))} · {formatPercent(gainPct)}
            </p>
          )}
        </div>
        <PriceSourceLabel source={source} />
      </Card>
    </section>
  );
}

function BuyRow({ buy }: { buy: Buy }) {
  const now = useNow();
  const due = new Date(buy.dueAt);
  const approved = buy.approvedAt ? new Date(buy.approvedAt) : null;

  let when: string;
  if (buy.kind === "now") {
    when = `${formatWeekdayDay(approved ?? due, now)} · bought now`;
  } else if (approved && toDateKey(approved) !== toDateKey(due)) {
    when = `${formatWeekdayDay(due, now)} · approved ${WEEKDAY_SHORT[weekdayOf(approved)]}`;
  } else {
    when = formatWeekdayDay(due, now);
  }

  return (
    <li className="flex items-center gap-3 px-2.5 py-3">
      <CoinLogo asset={buy.coin} size={36} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium tabular-nums">
          {buy.amount} USDC →{" "}
          {buy.status === "missed" ? buy.coin : formatAsset(buy.coinAmount, buy.coin)}
        </p>
        <p className="text-muted-foreground truncate text-sm">{when}</p>
      </div>
      {buy.status === "done" && <Badge variant="positive">Done</Badge>}
      {buy.status === "waiting" && <Badge variant="waiting">Waiting</Badge>}
      {buy.status === "missed" && <Badge variant="negative">Missed</Badge>}
    </li>
  );
}
