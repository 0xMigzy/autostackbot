import { useId, useState } from "react";

import { AppHeader } from "@/components/app-header";
import { ChipGroup, MultiChipGroup } from "@/components/chip-group";
import { CoinLogo } from "@/components/coin-logo";
import { MainAction } from "@/components/main-action";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { useBackButton } from "@/hooks/use-telegram";
import { useDemoStore } from "@/hooks/use-demo-store";
import { useNow } from "@/hooks/use-now";
import { ASSETS, type CoinId } from "@/lib/coins";
import type { Plan, Stop } from "@/lib/demo-store";
import { formatAsset, formatUsd } from "@/lib/format";
import { planSummary } from "@/lib/plan-summary";
import { usePrices } from "@/lib/prices";
import {
  firstAnchor,
  toDateKey,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  WEEKDAYS,
  type Schedule,
  type Weekday,
} from "@/lib/schedule";
import { inTelegram } from "@/lib/telegram";
import { cn } from "@/lib/utils";

type AmountChoice = "5" | "10" | "25" | "other";
type Frequency = Schedule["kind"];
type StopKind = Stop["kind"];
type GoalUnit = "coin" | "usd";

const DEFAULT_GOAL: Record<CoinId, string> = {
  HYPE: "1",
  ETH: "0.1",
  BTC: "0.01",
  SOL: "2",
  LIT: "100",
};

const WEEKDAY_OPTIONS = WEEKDAYS.map((d) => ({
  value: String(d),
  label: WEEKDAY_SHORT[d],
  ariaLabel: WEEKDAY_LONG[d],
}));

/** Parses user input like "12,5" or "12.5"; NaN when empty or not a number. */
function parseNumber(text: string): number {
  const trimmed = text.trim().replace(",", ".");
  return trimmed === "" ? NaN : Number(trimmed);
}

interface PlanSetupScreenProps {
  coin: CoinId;
  onBack: () => void;
  onStart: (plan: Plan) => void;
  onReset: () => void;
}

export function PlanSetupScreen({ coin, onBack, onStart, onReset }: PlanSetupScreenProps) {
  const { state } = useDemoStore();
  const { quotes } = usePrices();
  const now = useNow();
  const ids = useId();
  useBackButton(onBack);

  const [amountChoice, setAmountChoice] = useState<AmountChoice>("10");
  const [otherAmount, setOtherAmount] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("weekly");
  const [weekDays, setWeekDays] = useState<Weekday[]>([0]);
  const [monthDay, setMonthDay] = useState<Weekday>(0);
  const [everyDays, setEveryDays] = useState(3);
  const [time, setTime] = useState("09:00");
  const [stopKind, setStopKind] = useState<StopKind>("goal");
  const [buysCount, setBuysCount] = useState("10");
  const [stopDate, setStopDate] = useState(() => {
    const d = new Date();
    return toDateKey(new Date(d.getFullYear(), d.getMonth() + 3, d.getDate()));
  });
  const [goalUnit, setGoalUnit] = useState<GoalUnit>("coin");
  const [goalValue, setGoalValue] = useState(DEFAULT_GOAL[coin]);

  const price = quotes[coin].price;
  const tomorrowKey = toDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

  // ---- validation
  const amount = amountChoice === "other" ? parseNumber(otherAmount) : Number(amountChoice);
  const amountError =
    amountChoice === "other" && !(amount > 0)
      ? "Enter an amount above 0."
      : amount > 100_000
        ? "Keep it under 100,000 USDC for the demo."
        : null;
  const timeError = /^\d{2}:\d{2}$/.test(time) ? null : "Pick a time.";
  const buysNumber = parseNumber(buysCount);
  const goalNumber = parseNumber(goalValue);
  let stopError: string | null = null;
  if (
    stopKind === "buys" &&
    !(Number.isInteger(buysNumber) && buysNumber >= 1 && buysNumber <= 500)
  ) {
    stopError = "Enter a whole number of buys from 1 to 500.";
  } else if (stopKind === "date" && !(stopDate >= tomorrowKey)) {
    stopError = "Pick a date after today.";
  } else if (stopKind === "goal" && !(goalNumber > 0)) {
    stopError = "Enter a goal above 0.";
  }
  const valid = !amountError && !timeError && !stopError;
  // Don't scold an empty "Other" field before anything was typed.
  const otherEmpty = amountChoice === "other" && otherAmount.trim() === "";
  const shownAmountError = otherEmpty ? null : amountError;

  const schedule: Schedule =
    frequency === "daily"
      ? { kind: "daily" }
      : frequency === "weekly"
        ? { kind: "weekly", days: [...weekDays].sort((a, b) => a - b) }
        : frequency === "monthly"
          ? { kind: "monthly", day: monthDay }
          : { kind: "custom", everyDays, anchor: firstAnchor(time, now) };
  const stop: Stop =
    stopKind === "never"
      ? { kind: "never" }
      : stopKind === "buys"
        ? { kind: "buys", count: buysNumber }
        : stopKind === "date"
          ? { kind: "date", date: stopDate }
          : { kind: "goal", unit: goalUnit, value: goalNumber };

  const summary = valid
    ? planSummary({ coin, amount, schedule, time, stop }, price, now)
    : otherEmpty
      ? "Enter your amount to see your plan."
      : "Fix the highlighted field to see your plan.";

  const start = () => {
    if (!valid) return;
    onStart({
      id: crypto.randomUUID(),
      coin,
      amount,
      schedule,
      time,
      stop,
      status: "active",
      createdAt: new Date().toISOString(),
      coveredUntil: null,
      streak: 0,
      bestStreak: 0,
    });
  };

  const sectionTitle = "text-[15px] font-semibold";
  const hint = "text-muted-foreground text-sm";
  const error = "text-negative text-sm";

  return (
    <div className={cn("flex flex-col gap-3", inTelegram ? "pb-8" : "pb-28")}>
      <AppHeader title="Set up a plan" onBack={onBack} onReset={onReset} />

      <div className="flex items-center gap-3 px-4">
        <CoinLogo asset={coin} size={40} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{ASSETS[coin].name}</p>
          <p className="text-muted-foreground text-sm tabular-nums">
            1 {coin} = {formatUsd(price)}
          </p>
        </div>
        <p className="text-muted-foreground text-right text-xs tabular-nums">
          You have
          <br />
          <span className="text-foreground text-sm font-medium">
            {formatAsset(state.wallet.USDC, "USDC")}
          </span>
        </p>
      </div>

      {/* Amount */}
      <section className="px-4" aria-labelledby={`${ids}-amount`}>
        <Card className="flex flex-col gap-3">
          <h2 id={`${ids}-amount`} className={sectionTitle}>
            Amount each time <span className="text-muted-foreground font-normal">(USDC)</span>
          </h2>
          <ChipGroup
            label="Amount each time"
            value={amountChoice}
            onChange={setAmountChoice}
            className="grid grid-cols-4 gap-1.5"
            itemClassName="min-w-0 px-2"
            options={[
              { value: "5", label: "5", ariaLabel: "5 USDC" },
              { value: "10", label: "10", ariaLabel: "10 USDC" },
              { value: "25", label: "25", ariaLabel: "25 USDC" },
              { value: "other", label: "Other" },
            ]}
          />
          {amountChoice === "other" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}-other`} className={hint}>
                Your amount in USDC
              </label>
              <Input
                id={`${ids}-other`}
                inputMode="decimal"
                placeholder="e.g. 15"
                autoComplete="off"
                value={otherAmount}
                onChange={(e) => setOtherAmount(e.target.value)}
                aria-invalid={shownAmountError ? true : undefined}
                aria-describedby={shownAmountError ? `${ids}-amount-error` : undefined}
              />
            </div>
          )}
          {shownAmountError && (
            <p id={`${ids}-amount-error`} className={error} role="alert">
              {shownAmountError}
            </p>
          )}
        </Card>
      </section>

      {/* Frequency */}
      <section className="px-4" aria-labelledby={`${ids}-often`}>
        <Card className="flex flex-col gap-3">
          <h2 id={`${ids}-often`} className={sectionTitle}>
            How often
          </h2>
          <ChipGroup
            label="How often"
            value={frequency}
            onChange={setFrequency}
            className="grid grid-cols-4 gap-1.5"
            itemClassName="min-w-0 px-1.5 text-[13px]"
            options={[
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
              { value: "custom", label: "Custom" },
            ]}
          />
          {frequency === "weekly" && (
            <div className="flex flex-col gap-1.5">
              <p className={hint} id={`${ids}-days`}>
                On which days
              </p>
              <MultiChipGroup
                label="Days of the week"
                value={weekDays.map(String)}
                onChange={(v) => setWeekDays(v.map((d) => Number(d) as Weekday))}
                className="grid grid-cols-7 gap-1"
                itemClassName="h-9 min-w-0 px-0 text-[13px]"
                options={WEEKDAY_OPTIONS}
              />
            </div>
          )}
          {frequency === "monthly" && (
            <div className="flex flex-col gap-1.5">
              <p className={hint}>On the first … of each month</p>
              <ChipGroup
                label="Day of the month"
                value={String(monthDay)}
                onChange={(v) => setMonthDay(Number(v) as Weekday)}
                className="grid grid-cols-7 gap-1"
                itemClassName="h-9 min-w-0 px-0 text-[13px]"
                options={WEEKDAY_OPTIONS}
              />
            </div>
          )}
          {frequency === "custom" && (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium tabular-nums" id={`${ids}-every`}>
                Every {everyDays} days
              </p>
              <Slider
                min={2}
                max={30}
                step={1}
                value={[everyDays]}
                onValueChange={([v]) => setEveryDays(v)}
                thumbLabel="Days between buys"
                aria-labelledby={`${ids}-every`}
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={`${ids}-time`} className={hint}>
              At what time
            </label>
            <Input
              id={`${ids}-time`}
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-32"
              aria-invalid={timeError ? true : undefined}
              required
            />
          </div>
          {timeError && (
            <p className={error} role="alert">
              {timeError}
            </p>
          )}
        </Card>
      </section>

      {/* Stop */}
      <section className="px-4" aria-labelledby={`${ids}-stop`}>
        <Card className="flex flex-col gap-3">
          <h2 id={`${ids}-stop`} className={sectionTitle}>
            Stop when
          </h2>
          <ChipGroup
            label="Stop when"
            value={stopKind}
            onChange={setStopKind}
            className="grid grid-cols-2 gap-1.5"
            itemClassName="min-w-0"
            options={[
              { value: "never", label: "Never" },
              { value: "buys", label: "After X buys" },
              { value: "date", label: "On a date" },
              { value: "goal", label: "At a goal" },
            ]}
          />
          {stopKind === "buys" && (
            <div className="flex items-center justify-between gap-3">
              <label htmlFor={`${ids}-buys`} className={hint}>
                Number of buys
              </label>
              <Input
                id={`${ids}-buys`}
                inputMode="numeric"
                className="w-28 text-right"
                value={buysCount}
                onChange={(e) => setBuysCount(e.target.value)}
                aria-invalid={stopError ? true : undefined}
                aria-describedby={stopError ? `${ids}-stop-error` : undefined}
              />
            </div>
          )}
          {stopKind === "date" && (
            <div className="flex items-center justify-between gap-3">
              <label htmlFor={`${ids}-date`} className={hint}>
                Last day
              </label>
              <Input
                id={`${ids}-date`}
                type="date"
                min={tomorrowKey}
                className="w-44"
                value={stopDate}
                onChange={(e) => setStopDate(e.target.value)}
                aria-invalid={stopError ? true : undefined}
                aria-describedby={stopError ? `${ids}-stop-error` : undefined}
              />
            </div>
          )}
          {stopKind === "goal" && (
            <div className="flex flex-col gap-2">
              <ChipGroup
                label="Goal in"
                value={goalUnit}
                onChange={(u) => {
                  setGoalUnit(u);
                  setGoalValue(u === "coin" ? DEFAULT_GOAL[coin] : "100");
                }}
                className="grid grid-cols-2 gap-1.5"
                itemClassName="h-9 min-w-0 text-[13px]"
                options={[
                  { value: "coin", label: `${coin} amount` },
                  { value: "usd", label: "Dollars put in" },
                ]}
              />
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={`${ids}-goal`} className={hint}>
                  {goalUnit === "coin" ? `Goal in ${coin}` : "Goal in $"}
                </label>
                <Input
                  id={`${ids}-goal`}
                  inputMode="decimal"
                  className="w-32 text-right"
                  value={goalValue}
                  onChange={(e) => setGoalValue(e.target.value)}
                  aria-invalid={stopError ? true : undefined}
                  aria-describedby={stopError ? `${ids}-stop-error` : undefined}
                />
              </div>
            </div>
          )}
          {stopError && (
            <p id={`${ids}-stop-error`} className={error} role="alert">
              {stopError}
            </p>
          )}
        </Card>
      </section>

      {/* Summary */}
      <section className="px-4" aria-labelledby={`${ids}-summary`}>
        <Card className="bg-raised border">
          <h2 id={`${ids}-summary`} className="text-muted-foreground text-[13px] font-medium">
            Your plan in plain words
          </h2>
          <p className="mt-1.5 text-[15px] leading-relaxed tabular-nums" aria-live="polite">
            {summary}
          </p>
        </Card>
      </section>

      <MainAction text="Start plan" onClick={start} disabled={!valid} aboveNav={false} />
    </div>
  );
}
