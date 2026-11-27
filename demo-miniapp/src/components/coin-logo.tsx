import { useState } from "react";

import { ASSETS, type Asset } from "@/lib/coins";
import { usePrices } from "@/lib/prices";
import { cn } from "@/lib/utils";

interface CoinLogoProps {
  asset: Asset;
  /** Pixel size, 32–40 in lists. */
  size?: number;
  className?: string;
}

function LetterLogo({
  asset,
  size,
  className,
}: Required<Omit<CoinLogoProps, "className">> & { className?: string }) {
  return (
    <span
      role="img"
      aria-label={ASSETS[asset].name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-[#232326] font-semibold text-white",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {asset.slice(0, 2)}
    </span>
  );
}

function RemoteLogo({
  url,
  asset,
  size,
  className,
}: Required<Omit<CoinLogoProps, "className">> & {
  url: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <LetterLogo asset={asset} size={size} className={className} />;
  return (
    <img
      src={url}
      alt={ASSETS[asset].name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("shrink-0 rounded-full bg-[#232326] object-cover", className)}
      style={{ width: size, height: size }}
    />
  );
}

/** CoinGecko logo loaded at runtime, or a neutral circle with the symbol's first two letters. */
export function CoinLogo({ asset, size = 36, className }: CoinLogoProps) {
  const { quotes } = usePrices();
  const url = quotes[asset].image;
  return url ? (
    <RemoteLogo key={url} url={url} asset={asset} size={size} className={className} />
  ) : (
    <LetterLogo asset={asset} size={size} className={className} />
  );
}
