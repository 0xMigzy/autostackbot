import { FlaskConical } from "lucide-react";

/** Shown on every screen so nobody mistakes the demo for a real wallet. */
export function DemoBar() {
  return (
    <div
      role="note"
      className="bg-background/95 sticky top-0 z-30 px-4 pt-[calc(0.5rem+var(--tg-content-safe-area-inset-top,0px))] pb-2 backdrop-blur"
    >
      <p className="bg-chip text-chip-foreground mx-auto flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium">
        <FlaskConical className="size-3.5" aria-hidden />
        Demo · pretend data, no wallet needed
      </p>
    </div>
  );
}
