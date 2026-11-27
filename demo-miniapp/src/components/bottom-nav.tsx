import { CalendarClock, ChartNoAxesColumn, History, House, type LucideIcon } from "lucide-react";

import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { haptics } from "@/lib/telegram";

export type Tab = "home" | "markets" | "plans" | "history";

const TABS: { value: Tab; label: string; icon: LucideIcon }[] = [
  { value: "home", label: "Home", icon: House },
  { value: "markets", label: "Markets", icon: ChartNoAxesColumn },
  { value: "plans", label: "Plans", icon: CalendarClock },
  { value: "history", label: "History", icon: History },
];

export function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="bg-background/95 fixed inset-x-0 bottom-0 z-30 border-t backdrop-blur"
    >
      <TabsList className="mx-auto flex h-16 w-full max-w-md px-2 pb-[env(safe-area-inset-bottom)] box-content">
        {TABS.map(({ value, label, icon: Icon }) => (
          <TabsTrigger
            key={value}
            value={value}
            onClick={() => haptics.selection()}
            className="h-14 flex-col gap-1 text-[11px] focus-visible:ring-inset"
          >
            <Icon className="size-[22px]" strokeWidth={1.75} aria-hidden />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </nav>
  );
}
