import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import type { Plan } from "@/lib/demo-store";
import { formatAsset } from "@/lib/format";

interface EditAmountDialogProps {
  plan: Plan | null;
  price: number;
  onOpenChange: (open: boolean) => void;
  onSave: (amount: number) => void;
}

/** Change how much USDC a plan spends per buy. Remounted per plan so the draft resets. */
export function EditAmountDialog({ plan, price, onOpenChange, onSave }: EditAmountDialogProps) {
  return (
    <Dialog open={plan !== null} onOpenChange={onOpenChange}>
      {plan && (
        <DialogContent>
          <EditAmountForm key={plan.id} plan={plan} price={price} onSave={onSave} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function EditAmountForm({
  plan,
  price,
  onSave,
}: {
  plan: Plan;
  price: number;
  onSave: (amount: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState(String(plan.amount));
  const amount = Number(text.trim().replace(",", "."));
  const valid = text.trim() !== "" && amount > 0 && amount <= 100_000;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(amount);
      }}
    >
      <DialogHeader>
        <DialogTitle>Edit amount</DialogTitle>
        <DialogDescription>How much USDC each {plan.coin} buy spends.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <label htmlFor={`${id}-amount`} className="text-muted-foreground text-sm">
          USDC each time
        </label>
        <Input
          id={`${id}-amount`}
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={valid ? undefined : true}
          aria-describedby={`${id}-hint`}
          className="text-lg font-semibold"
        />
        <Slider
          min={1}
          max={100}
          step={1}
          value={[valid ? Math.min(100, Math.max(1, Math.round(amount))) : 1]}
          onValueChange={([v]) => setText(String(v))}
          thumbLabel="USDC each time"
        />
        <p
          id={`${id}-hint`}
          className={valid ? "text-muted-foreground text-sm tabular-nums" : "text-negative text-sm"}
        >
          {valid
            ? `About ${formatAsset(amount / price, plan.coin)} each time at today's price.`
            : "Enter an amount above 0."}
        </p>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!valid}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
