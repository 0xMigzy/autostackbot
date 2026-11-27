import { useColorScheme } from "@/hooks/use-color-scheme";
import { cn } from "@/lib/utils";

/**
 * Brand images are pre-rendered at the exact size they're shown (1×/2×/3×) by `npm run brand` in the repo root,
 * so the browser never has to shrink the large originals (blurry in Telegram's WebView) and no CSS filter is needed.
 */
const sized = (name: string) => {
  const url = (d: number) => `${import.meta.env.BASE_URL}brand/sized/${name}@${d}x.png`;
  return { src: url(1), srcSet: `${url(1)} 1x, ${url(2)} 2x, ${url(3)} 3x` };
};

const LOGO_SIZES = {
  header: { width: 50, height: 32 },
  splash: { width: 160, height: 102 },
} as const;

/** Full stacked AutoStack lockup; white on dark theme, black on light theme. */
export function Logo({
  variant,
  className,
}: {
  variant: keyof typeof LOGO_SIZES;
  className?: string;
}) {
  const tone = useColorScheme() === "dark" ? "white" : "dark";
  const { width, height } = LOGO_SIZES[variant];
  return (
    <img
      {...sized(`logo-${tone}-${variant}`)}
      alt="AutoStack"
      width={width}
      height={height}
      className={cn("select-none", className)}
      style={{ width, height }}
      draggable={false}
    />
  );
}

/** Coin-stack icon only, 24px tall. */
export function BrandIcon({ className }: { className?: string }) {
  const tone = useColorScheme() === "dark" ? "white" : "dark";
  return (
    <img
      {...sized(`icon-${tone}-24`)}
      alt="AutoStack"
      width={22}
      height={24}
      className={cn("select-none", className)}
      style={{ width: 22, height: 24 }}
      draggable={false}
    />
  );
}
