import { useEffect, useState } from "react";

import { Logo } from "@/components/brand";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

const SEEN_KEY = "autostack-demo-splash";

function alreadySeen(): boolean {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** ~1 s logo splash on the first load of a session; shorter with reduced motion. */
export function Splash() {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<"show" | "fade" | "gone">(() =>
    alreadySeen() ? "gone" : "show",
  );

  useEffect(() => {
    if (phase === "gone") return;
    try {
      window.sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Splash shows again next time; harmless.
    }
    const fadeAt = reduced ? 300 : 900;
    const doneAt = reduced ? 320 : 1200;
    const t1 = window.setTimeout(() => setPhase("fade"), fadeAt);
    const t2 = window.setTimeout(() => setPhase("gone"), doneAt);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // Runs once per mount; phase changes come from the timers themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  if (phase === "gone") return null;
  return (
    <div
      aria-hidden
      className={cn(
        "bg-background fixed inset-0 z-[100] grid place-items-center transition-opacity duration-300",
        phase === "fade" && "opacity-0",
      )}
    >
      <div className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-500">
        <Logo className="h-auto w-40" />
      </div>
    </div>
  );
}
