import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useMainButton } from "@/hooks/use-telegram";
import { inTelegram, type MainButtonConfig } from "@/lib/telegram";
import { cn } from "@/lib/utils";

interface MainActionProps extends MainButtonConfig {
  /**
   * "screen": pinned to the bottom of the page (above the tab bar when `aboveNav`).
   * "inline": rendered in place, e.g. at the end of a sheet.
   */
  placement?: "screen" | "inline";
  aboveNav?: boolean;
}

/**
 * The main action of a screen. Inside Telegram it drives the native MainButton and renders
 * nothing; in a normal browser it renders an in-page primary button instead.
 */
export function MainAction({
  placement = "screen",
  aboveNav = true,
  text,
  onClick,
  disabled,
  loading,
}: MainActionProps) {
  useMainButton({ text, onClick, disabled, loading });
  if (inTelegram) return null;

  const button = (
    <Button size="lg" className="w-full" onClick={onClick} disabled={disabled || loading}>
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {text}
    </Button>
  );

  if (placement === "inline") return button;
  return (
    <div
      className={cn(
        "from-background via-background/95 pointer-events-none fixed inset-x-0 z-20 mx-auto w-full max-w-md bg-gradient-to-t to-transparent px-4 pt-6 pb-3",
        aboveNav
          ? "bottom-[calc(4rem+env(safe-area-inset-bottom))]"
          : "bottom-0 pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
      )}
    >
      <div className="pointer-events-auto">{button}</div>
    </div>
  );
}

/** Bottom padding a screen needs so its last card clears the tab bar and main action. */
export const SCREEN_BOTTOM_PADDING = inTelegram ? "pb-24" : "pb-44";
