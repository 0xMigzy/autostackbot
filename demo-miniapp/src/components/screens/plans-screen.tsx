import { Flame, Pause, Pencil, Play, ShoppingCart, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { CoinLogo } from "@/components/coin-logo";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EditAmountDialog } from "@/components/edit-amount-dialog";
import { MainAction, SCREEN_BOTTOM_PADDING } from "@/components/main-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useDemoStore } from "@/hooks/use-demo-store";
import { useNow } from "@/hooks/use-now";
import { ASSETS } from "@/lib/coins";
import { goalProgress, planStats, type Plan } from "@/lib/demo-store";
import { formatAmount, formatAsset, formatDay, formatUsd } from "@/lib/format";
import { usePrices } from "@/lib/prices";
import { countdown, describeSchedule, fromDateKey, nextBuy, streakUnit } from "@/lib/schedule";
import { haptics } from "@/lib/telegram";
import { cn } from "@/lib/utils";

interface PlansScreenProps {
  onBuyNow: (plan: Plan) => void;
  onAdd: () => void;
  onReset: () => void;
}

export function PlansScreen({ onBuyNow, onAdd, onReset }: PlansScreenProps) {
  const { state, dispatch } = useDemoStore();
  const { quotes } = usePrices();
  const [editing, setEditing] = useState<Plan | null>(null);
  const [deleting, setDeleting] = useState<Plan | null>(null);

  return (
    <div className={cn("flex flex-col gap-3", SCREEN_BOTTOM_PADDING)}>
      <AppHeader title="Plans" onReset={onReset} />

      {state.plans.length === 0 ? (
        <div className="px-4">
          <Card className="text-muted-foreground text-center text-sm">
            No plans yet. Add one to start buying on a schedule.
          </Card>
        </div>
      ) : (
        <ul className="flex flex-col gap-3 px-4" aria-label="Your plans">
          {state.plans.map((plan) => (
            <li key={plan.id}>
              <PlanCard
                plan={plan}
                onBuyNow={() => onBuyNow(plan)}
                onEdit={() => setEditing(plan)}
                onPause={() => {
                  haptics.tap();
                  dispatch({ type: "pause", planId: plan.id });
                  toast(`${plan.coin} plan paused`);
                }}
                onRestart={() => {
                  haptics.tap();
                  dispatch({ type: "restart", planId: plan.id });
                  toast.success(`${plan.coin} plan restarted`);
                }}
                onDelete={() => setDeleting(plan)}
              />
            </li>
          ))}
        </ul>
      )}

      <EditAmountDialog
        plan={editing}
        price={editing ? quotes[editing.coin].price : 1}
        onOpenChange={(open) => !open && setEditing(null)}
        onSave={(amount) => {
          if (!editing) return;
          dispatch({ type: "setAmount", planId: editing.id, amount });
          toast.success(`Now ${amount} USDC each ${editing.coin} buy`);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete the ${deleting?.coin ?? ""} plan?`}
        description="No more buys will happen for this plan. Your history stays."
        confirmLabel="Delete"
        onConfirm={() => {
          if (!deleting) return;
          dispatch({ type: "deletePlan", planId: deleting.id });
          toast(`${deleting.coin} plan deleted`);
          setDeleting(null);
        }}
      />

      <MainAction text="Add a plan" onClick={onAdd} />
    </div>
  );
}

interface PlanCardProps {
  plan: Plan;
  onBuyNow: () => void;
  onEdit: () => void;
  onPause: () => void;
  onRestart: () => void;
  onDelete: () => void;
}

function PlanCard({ plan, onBuyNow, onEdit, onPause, onRestart, onDelete }: PlanCardProps) {
  const { state } = useDemoStore();
  const now = useNow();
  const stats = planStats(state.buys, plan.id);
  const goal = goalProgress(plan, stats);
  const next = plan.status === "active" ? nextBuy(plan, now, plan.coveredUntil) : null;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <CoinLogo asset={plan.coin} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{ASSETS[plan.coin].name}</h2>
          <p className="text-muted-foreground text-sm">
            {plan.amount} USDC {describeSchedule(plan.schedule)} · {plan.time}
          </p>
        </div>
        {plan.status === "active" && <Badge variant="positive">Active</Badge>}
        {plan.status === "paused" && <Badge variant="waiting">Paused</Badge>}
        {plan.status === "finished" && <Badge variant="outline">Finished</Badge>}
      </div>

      {goal && (
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between gap-2 text-sm tabular-nums">
            <span className="font-medium">
              {goal.unit === "coin"
                ? `${formatAmount(goal.have, plan.coin)} of ${formatAsset(goal.target, plan.coin)}`
                : `${formatUsd(goal.have)} of ${formatUsd(goal.target)}`}
            </span>
            <span className="text-muted-foreground">{Math.round(goal.fraction * 100)}%</span>
          </div>
          <Progress value={goal.fraction * 100} aria-label={`Goal progress for ${plan.coin}`} />
        </div>
      )}
      {plan.stop.kind === "buys" && (
        <p className="text-muted-foreground text-sm tabular-nums">
          {stats.count} of {plan.stop.count} buys done
        </p>
      )}
      {plan.stop.kind === "date" && (
        <p className="text-muted-foreground text-sm">
          Runs until {formatDay(fromDateKey(plan.stop.date), now)}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-muted-foreground text-xs">Streak</p>
          <p className="flex items-center gap-1 font-medium tabular-nums">
            <Flame className="text-flame size-4" aria-hidden />
            {plan.streak} {streakUnit(plan.schedule, plan.streak)} · best {plan.bestStreak}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Next buy</p>
          <p className="font-medium tabular-nums">
            {next ? countdown(next, now) : plan.status === "paused" ? "Paused" : "None planned"}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {plan.status === "active" && (
          <Button size="sm" onClick={onBuyNow}>
            <ShoppingCart aria-hidden />
            Buy now
          </Button>
        )}
        {plan.status !== "finished" && (
          <Button size="sm" variant="secondary" onClick={onEdit}>
            <Pencil aria-hidden />
            Edit amount
          </Button>
        )}
        {plan.status === "active" && (
          <Button size="sm" variant="secondary" onClick={onPause}>
            <Pause aria-hidden />
            Pause
          </Button>
        )}
        {plan.status === "paused" && (
          <Button size="sm" onClick={onRestart}>
            <Play aria-hidden />
            Restart
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 aria-hidden />
          Delete
        </Button>
      </div>
    </Card>
  );
}
