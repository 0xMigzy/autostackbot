import { ChevronLeft, Moon, MoreHorizontal, RotateCcw, Sun } from "lucide-react";

import { BrandIcon, Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setColorSchemeOverride, useColorScheme } from "@/hooks/use-color-scheme";
import { inTelegram } from "@/lib/telegram";

interface AppHeaderProps {
  /** Screen title; omit on Home to show the full logo. */
  title?: string;
  /** In-page back button for browsers (Telegram shows its own BackButton). */
  onBack?: () => void;
  onReset: () => void;
}

export function AppHeader({ title, onBack, onReset }: AppHeaderProps) {
  const scheme = useColorScheme();
  return (
    <header className="flex min-h-14 items-center gap-2 px-4 pt-1 pb-3">
      {onBack && !inTelegram && (
        <Button variant="ghost" size="icon" className="-ml-2" onClick={onBack} aria-label="Back">
          <ChevronLeft className="size-6" aria-hidden />
        </Button>
      )}
      {title ? (
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <BrandIcon />
          <h1 className="truncate text-xl font-semibold">{title}</h1>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <h1 className="contents">
            <Logo variant="header" />
          </h1>
          <p className="text-muted-foreground text-xs">for Tangem wallets</p>
        </div>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="-mr-2" aria-label="Menu">
            <MoreHorizontal className="size-5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>AutoStack demo</DropdownMenuLabel>
          {!inTelegram && (
            <DropdownMenuItem
              onSelect={() => setColorSchemeOverride(scheme === "dark" ? "light" : "dark")}
            >
              {scheme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
              {scheme === "dark" ? "Light theme" : "Dark theme"}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onReset}>
            <RotateCcw aria-hidden />
            Reset demo
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
