import { useColorScheme } from "@/hooks/use-color-scheme";
import { cn } from "@/lib/utils";

const brandUrl = (file: string) => `${import.meta.env.BASE_URL}brand/${file}`;

/**
 * The brand PNGs keep a near-invisible (alpha 1–2/255) background that shows as a faint box on
 * solid backgrounds. This filter drops that residue without touching the artwork; render it once.
 */
export function BrandFilter() {
  return (
    <svg aria-hidden width="0" height="0" className="absolute">
      <filter id="brand-clean-alpha" colorInterpolationFilters="sRGB">
        <feComponentTransfer>
          <feFuncA type="linear" slope="1.03" intercept="-0.03" />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

const brandImg = "select-none [filter:url(#brand-clean-alpha)]";

/** Full stacked AutoStack lockup (816×519); white on dark theme, black on light theme. */
export function Logo({ className }: { className?: string }) {
  const scheme = useColorScheme();
  return (
    <img
      src={brandUrl(scheme === "dark" ? "autostack-logo-white.png" : "autostack-logo-dark.png")}
      alt="AutoStack"
      width={816}
      height={519}
      className={cn("h-8 w-auto", brandImg, className)}
      draggable={false}
    />
  );
}

/** Coin-stack icon only. */
export function BrandIcon({ className }: { className?: string }) {
  const scheme = useColorScheme();
  return (
    <img
      src={brandUrl(scheme === "dark" ? "autostack-icon-white.png" : "autostack-icon-dark.png")}
      alt="AutoStack"
      className={cn("size-6 object-contain", brandImg, className)}
      draggable={false}
    />
  );
}
