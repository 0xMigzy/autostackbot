import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { BottomNav, type Tab } from "@/components/bottom-nav";
import { BuySheet, type BuyFlow } from "@/components/buy-sheet";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DemoBar } from "@/components/demo-bar";
import { HistoryScreen } from "@/components/screens/history-screen";
import { HomeScreen } from "@/components/screens/home-screen";
import { MarketsScreen } from "@/components/screens/markets-screen";
import { PlanSetupScreen } from "@/components/screens/plan-setup-screen";
import { PlansScreen } from "@/components/screens/plans-screen";
import { Splash } from "@/components/splash";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useDemoStore } from "@/hooks/use-demo-store";
import { currentTime } from "@/hooks/use-now";
import type { CoinId } from "@/lib/coins";
import { expectedCoins, goalProgress, planStats, seedState, type Plan } from "@/lib/demo-store";
import { formatAsset, formatWeekdayDay } from "@/lib/format";
import { usePrices } from "@/lib/prices";
import { nextBuy } from "@/lib/schedule";
import { haptics, paintTelegramChrome, setMainButtonColors } from "@/lib/telegram";

/** How long the pretend card approval takes. */
const APPROVAL_MS = 4000;

const CHROME = {
  dark: {
    bg: "#0A0A0B",
    button: "#FFFFFF",
    buttonText: "#0A0A0B",
    off: "#2A2A2E",
    offText: "#8E8E93",
  },
  light: {
    bg: "#F2F2F4",
    button: "#0A0A0B",
    buttonText: "#FFFFFF",
    off: "#DCDCE1",
    offText: "#5C5C63",
  },
} as const;

export default function App() {
  const scheme = useColorScheme();
  const { state, dispatch } = useDemoStore();
  const { quotes } = usePrices();

  const [tab, setTab] = useState<Tab>("home");
  const [setup, setSetup] = useState<{ coin: CoinId; from: Tab } | null>(null);
  const [flow, setFlow] = useState<BuyFlow | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  // Theme: Tailwind's `dark` class, browser theme colour and Telegram's own chrome.
  useEffect(() => {
    const c = CHROME[scheme];
    document.documentElement.classList.toggle("dark", scheme === "dark");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", c.bg);
    paintTelegramChrome(c.bg);
    setMainButtonColors({
      bg: c.button,
      text: c.buttonText,
      disabledBg: c.off,
      disabledText: c.offText,
    });
  }, [scheme]);

  // The pretend card approval: completes on its own after a few seconds.
  useEffect(() => {
    if (!flow || flow.phase !== "approving") return;
    const { buyId, got } = flow;
    const timer = window.setTimeout(() => {
      dispatch({ type: "completeBuy", buyId, at: new Date().toISOString() });
      haptics.success();
      toast.success(`Bought ${got}`, { description: "Pretend buy, added to the demo wallet." });
      setFlow((f) => (f && f.buyId === buyId ? { ...f, phase: "done" } : f));
    }, APPROVAL_MS);
    return () => window.clearTimeout(timer);
  }, [flow, dispatch]);

  const go = useCallback((next: Tab) => {
    setSetup(null);
    setTab(next);
    window.scrollTo({ top: 0 });
  }, []);

  const buyNow = (plan: Plan) => {
    if (flow?.phase === "approving") {
      setSheetOpen(true);
      return;
    }
    if (state.wallet.USDC < plan.amount) {
      haptics.warning();
      toast.error("Not enough USDC in the demo wallet", {
        description: "Use Reset demo in the menu to refill it.",
      });
      return;
    }
    const now = currentTime();
    const price = quotes[plan.coin].price;
    const due = nextBuy(plan, now, plan.coveredUntil) ?? now;
    const buyId = crypto.randomUUID();
    const goal = goalProgress(plan, planStats(state.buys, plan.id));
    const coinAmount = expectedCoins(plan.amount, price, plan.coin);
    dispatch({
      type: "startBuy",
      buy: {
        id: buyId,
        planId: plan.id,
        coin: plan.coin,
        amount: plan.amount,
        coinAmount,
        price,
        dueAt: due.toISOString(),
        kind: "now",
        status: "waiting",
        approvedAt: null,
      },
    });
    haptics.tap();
    setFlow({
      buyId,
      phase: "approving",
      fromFraction: goal?.fraction ?? 0,
      got: formatAsset(coinAmount, plan.coin),
    });
    setSheetOpen(true);
  };

  const closeSheet = (open: boolean) => {
    setSheetOpen(open);
    if (!open && flow?.phase === "done") setFlow(null);
  };

  const startPlan = (plan: Plan) => {
    dispatch({ type: "addPlan", plan });
    haptics.success();
    const now = currentTime();
    const first = nextBuy(plan, now);
    toast.success(`${plan.coin} plan started`, {
      description: first ? `First buy ${formatWeekdayDay(first, now)} at ${plan.time}.` : undefined,
    });
    go("plans");
  };

  const reset = () => {
    dispatch({ type: "reset", state: seedState() });
    setFlow(null);
    setSheetOpen(false);
    setResetOpen(false);
    go("home");
    toast.success("Demo reset", { description: "Wallet, plan and history are back to the start." });
  };

  const openReset = () => setResetOpen(true);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col overflow-x-clip">
      <DemoBar />
      {setup ? (
        <main className="flex-1">
          <PlanSetupScreen
            key={setup.coin}
            coin={setup.coin}
            onBack={() => go(setup.from)}
            onStart={startPlan}
            onReset={openReset}
          />
        </main>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(v) => go(v as Tab)}
          className="flex-1"
          activationMode="manual"
        >
          <main className="flex-1">
            <TabsContent value="home">
              <HomeScreen
                holdRing={sheetOpen}
                onBuyNow={buyNow}
                onBrowse={() => go("markets")}
                onReset={openReset}
              />
            </TabsContent>
            <TabsContent value="markets">
              <MarketsScreen
                onPick={(coin) => {
                  setSetup({ coin, from: tab });
                  window.scrollTo({ top: 0 });
                }}
                onReset={openReset}
              />
            </TabsContent>
            <TabsContent value="plans">
              <PlansScreen onBuyNow={buyNow} onAdd={() => go("markets")} onReset={openReset} />
            </TabsContent>
            <TabsContent value="history">
              <HistoryScreen onReset={openReset} />
            </TabsContent>
          </main>
          <BottomNav />
        </Tabs>
      )}

      <BuySheet flow={flow} open={sheetOpen} onOpenChange={closeSheet} />
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset the demo?"
        description="This puts back the starting wallet, the HYPE plan and its history."
        confirmLabel="Reset demo"
        onConfirm={reset}
      />
      <Toaster theme={scheme} />
      <Splash />
    </div>
  );
}
