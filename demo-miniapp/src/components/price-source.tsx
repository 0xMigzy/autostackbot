import type { PriceSource } from "@/lib/prices";
import { cn } from "@/lib/utils";

const LABEL: Record<PriceSource, string> = {
  loading: "Loading prices…",
  coingecko: "Prices from CoinGecko",
  sample: "Sample prices",
};

export function PriceSourceLabel({
  source,
  className,
}: {
  source: PriceSource;
  className?: string;
}) {
  return (
    <p className={cn("text-muted-foreground text-xs", className)} aria-live="polite">
      {LABEL[source]}
    </p>
  );
}
