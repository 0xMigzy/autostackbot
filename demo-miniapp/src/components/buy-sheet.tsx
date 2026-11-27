import { Check, Clock, CreditCard } from "lucide-react";

import { CoinLogo } from "@/components/coin-logo";
import { MainAction } from "@/components/main-action";
import { ProgressRing } from "@/components/progress-ring";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useBackButton } from "@/hooks/use-telegram";
import { useDemoStore } from "@/hooks/use-demo-store";
import { goalProgress, planStats } from "@/lib/demo-store";
import { formatAmount, formatAsset, formatUsd } from "@/lib/format";
import { streakUnit } from "@/lib/schedule";
import { cn } from "@/lib/utils";

export interface BuyFlow {
  buyId: string;
  phase: "approving" | "done";
  /** Goal progress before this buy, so the ring can animate from there. */
  fromFraction: number;
  /** What the buy gets, e.g. "0.158 HYPE", for the completion toast. */
  got: string;
}

interface BuySheetProps {
  flow: BuyFlow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BuySheet({ flow, open, onOpenChange }: BuySheetProps) {
  return (
    <Sheet open={open && flow !== null} onOpenChange={onOpenChange}>
      {flow && (
        <SheetContent aria-describedby={undefined}>
          <BuySheetBody flow={flow} onClose={() => onOpenChange(false)} />
        </SheetContent>
      )}
    </Sheet>
  );
}

type StepState = "done" | "waiting" | "todo";

function Step({ state, title, detail }: { state: StepState; title: string; detail?: string }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-full border-2",
          state === "done" && "border-positive bg-positive text-background",
          state === "waiting" && "border-waiting text-waiting",
          state === "todo" && "border-border text-muted-foreground",
        )}
        aria-hidden
      >
        {state === "done" ? (
          <Check className="size-4" strokeWidth={3} />
        ) : state === "waiting" ? (
          <Clock className="size-4 motion-safe:animate-pulse" />
        ) : (
          <span className="size-1.5 rounded-full bg-current" />
        )}
      </span>
      <div className="min-w-0 pt-0.5">
        <p
          className={cn(
            "font-medium",
            state === "waiting" && "text-waiting",
            state === "todo" && "text-muted-foreground",
          )}
        >
          {title}
          <span className="sr-only">
            {state === "done" ? " (done)" : state === "waiting" ? " (in progress)" : " (next)"}
          </span>
        </p>
        {detail && <p className="text-muted-foreground text-sm">{detail}</p>}
      </div>
    </li>
  );
}

function BuySheetBody({ flow, onClose }: { flow: BuyFlow; onClose: () => void }) {
  const { state } = useDemoStore();
  useBackButton(onClose);
  const buy = state.buys.find((b) => b.id === flow.buyId);
  if (!buy) return null;

  const done = flow.phase === "done";
  const plan = state.plans.find((p) => p.id === buy.planId);
  const goal = plan ? goalProgress(plan, planStats(state.buys, plan.id)) : null;

  return (
    <>
      <SheetHeader>
        <SheetTitle>{done ? "Your buy is done" : "Your buy is ready"}</SheetTitle>
        <SheetDescription className="sr-only">
          A pretend buy of {buy.coin} with {buy.amount} USDC.
        </SheetDescription>
      </SheetHeader>

      <dl className="bg-raised flex flex-col gap-3 rounded-2xl p-4 text-[15px]">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">You pay</dt>
          <dd className="flex items-center gap-2 font-semibold tabular-nums">
            <CoinLogo asset="USDC" size={32} />
            {formatAsset(buy.amount, "USDC")}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">{done ? "You got" : "You get about"}</dt>
          <dd className="flex items-center gap-2 font-semibold tabular-nums">
            <CoinLogo asset={buy.coin} size={32} />
            {formatAsset(buy.coinAmount, buy.coin)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Best price via Tangem</dt>
          <dd className="text-right font-semibold tabular-nums">
            {buy.price ? `${formatUsd(buy.price)} per ${buy.coin}` : "—"}
          </dd>
        </div>
      </dl>

      <ol className="flex flex-col gap-4 px-1" aria-label="Steps">
        <Step state="done" title="Prepared" detail="Amount and best price locked in." />
        <Step
          state={done ? "done" : "waiting"}
          title="Approving with a card tap (demo)"
          detail={done ? "Approved." : "Waiting for your card…"}
        />
        <Step
          state={done ? "done" : "todo"}
          title="Done"
          detail={done ? `${buy.coin} added to your wallet.` : undefined}
        />
      </ol>

      {done && goal && plan ? (
        <div className="bg-raised flex items-center gap-4 rounded-2xl p-4" aria-live="polite">
          <ProgressRing
            value={goal.fraction}
            initialFrom={flow.fromFraction}
            size={72}
            stroke={8}
            label={`Goal progress for ${plan.coin}`}
          >
            <span className="text-sm font-semibold tabular-nums">
              {Math.round(goal.fraction * 100)}%
            </span>
          </ProgressRing>
          <div>
            <p className="text-muted-foreground text-sm">Goal</p>
            <p className="font-semibold tabular-nums">
              {goal.unit === "coin"
                ? `${formatAmount(goal.have, plan.coin)} of ${formatAsset(goal.target, plan.coin)}`
                : `${formatUsd(goal.have)} of ${formatUsd(goal.target)}`}
            </p>
            <p className="text-muted-foreground text-sm">
              Streak {plan.streak} {streakUnit(plan.schedule, plan.streak)} · best {plan.bestStreak}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground flex gap-2.5 text-sm">
          <CreditCard className="mt-0.5 size-4 shrink-0" aria-hidden />
          In the real app you open Tangem and tap your card. In this demo it completes on its own.
        </p>
      )}

      <MainAction
        placement="inline"
        text={done ? "Done" : "Waiting for card tap…"}
        loading={!done}
        onClick={onClose}
      />
    </>
  );
}
