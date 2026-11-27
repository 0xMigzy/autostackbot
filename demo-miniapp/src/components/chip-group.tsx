import type { ReactNode } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { haptics } from "@/lib/telegram";

export interface ChipOption<T extends string> {
  value: T;
  label: ReactNode;
  ariaLabel?: string;
}

interface SingleChipGroupProps<T extends string> {
  label: string;
  value: T;
  options: ChipOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  itemClassName?: string;
}

/** One-of-many chips; can't be cleared, taps give a selection haptic in Telegram. */
export function ChipGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  itemClassName,
}: SingleChipGroupProps<T>) {
  return (
    <ToggleGroup
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(v) => {
        if (!v || v === value) return;
        haptics.selection();
        onChange(v as T);
      }}
      className={className}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          aria-label={o.ariaLabel}
          className={itemClassName}
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

interface MultiChipGroupProps<T extends string> {
  label: string;
  value: T[];
  options: ChipOption<T>[];
  onChange: (value: T[]) => void;
  className?: string;
  itemClassName?: string;
}

/** Many-of-many chips that always keep at least one selected. */
export function MultiChipGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  itemClassName,
}: MultiChipGroupProps<T>) {
  return (
    <ToggleGroup
      type="multiple"
      aria-label={label}
      value={value}
      onValueChange={(v) => {
        if (v.length === 0) return;
        haptics.selection();
        onChange(v as T[]);
      }}
      className={className}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          aria-label={o.ariaLabel}
          className={itemClassName}
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
