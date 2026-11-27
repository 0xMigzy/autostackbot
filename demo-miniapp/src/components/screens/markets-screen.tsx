import { ChevronRight, Search } from "lucide-react";
import { useState } from "react";

import { AppHeader } from "@/components/app-header";
import { CoinLogo } from "@/components/coin-logo";
import { SCREEN_BOTTOM_PADDING } from "@/components/main-action";
import { PriceSourceLabel } from "@/components/price-source";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ASSETS, COIN_IDS, type CoinId } from "@/lib/coins";
import { formatPercent, formatUsd } from "@/lib/format";
import { usePrices } from "@/lib/prices";
import { haptics } from "@/lib/telegram";
import { cn } from "@/lib/utils";

interface MarketsScreenProps {
  onPick: (coin: CoinId) => void;
  onReset: () => void;
}

export function MarketsScreen({ onPick, onReset }: MarketsScreenProps) {
  const { quotes, source } = usePrices();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const coins = COIN_IDS.filter(
    (c) => !q || c.toLowerCase().includes(q) || ASSETS[c].name.toLowerCase().includes(q),
  );

  return (
    <div className={cn("flex flex-col gap-3", SCREEN_BOTTOM_PADDING)}>
      <AppHeader title="Markets" onReset={onReset} />
      <div className="px-4">
        <label htmlFor="coin-search" className="sr-only">
          Search coins
        </label>
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            id="coin-search"
            type="search"
            placeholder="Search by name or symbol"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="bg-card border-border pl-10"
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <PriceSourceLabel source={source} />
          <p className="text-muted-foreground text-xs">Tap a coin to set up a plan</p>
        </div>
      </div>

      <section aria-label="Coins" className="px-4">
        <Card className="p-1.5">
          {coins.length === 0 ? (
            <p className="text-muted-foreground p-4 text-center text-sm">
              No coin matches “{query.trim()}”.
            </p>
          ) : (
            <ul>
              {coins.map((c) => {
                const { price, change24h } = quotes[c];
                const up = change24h >= 0;
                return (
                  <li key={c}>
                    <button
                      type="button"
                      onClick={() => {
                        haptics.selection();
                        onPick(c);
                      }}
                      className="hover:bg-raised focus-visible:ring-ring flex w-full items-center gap-3 rounded-xl px-2.5 py-3 text-left outline-none focus-visible:ring-2"
                      aria-label={`${ASSETS[c].name}, ${formatUsd(price)}, ${up ? "up" : "down"} ${Math.abs(change24h).toFixed(2)}% in 24 hours. Set up a plan`}
                    >
                      <CoinLogo asset={c} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{ASSETS[c].name}</span>
                        <span className="text-muted-foreground block text-sm">{c}</span>
                      </span>
                      <span className="text-right tabular-nums">
                        <span className="block font-semibold">{formatUsd(price)}</span>
                        <span
                          className={cn("block text-sm", up ? "text-positive" : "text-negative")}
                        >
                          {up ? "▲" : "▼"} {formatPercent(change24h)}
                        </span>
                      </span>
                      <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
