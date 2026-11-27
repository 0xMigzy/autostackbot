import { useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "@/lib/utils";

interface ProgressRingProps {
  /** 0…1 */
  value: number;
  size?: number;
  stroke?: number;
  /** Keep showing the last value (e.g. while a sheet covers the ring) and animate once released. */
  hold?: boolean;
  /** Where the first animation starts from; defaults to empty. */
  initialFrom?: number;
  label: string;
  children?: ReactNode;
  className?: string;
}

/** Circular goal progress that fills with an animation whenever the shown value changes. */
export function ProgressRing({
  value,
  size = 104,
  stroke = 10,
  hold = false,
  initialFrom = 0,
  label,
  children,
  className,
}: ProgressRingProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const [shown, setShown] = useState(clamped);
  const [from, setFrom] = useState(Math.max(0, Math.min(1, initialFrom)));
  // Adjust state during render when the target changes (React's recommended pattern).
  if (!hold && clamped !== shown) {
    setFrom(shown);
    setShown(clamped);
  }

  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = (f: number) => circumference * (1 - f);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--chip)"
          strokeWidth={stroke}
        />
        <circle
          key={`${from}-${shown}`}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--positive)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          className="ring-fill"
          style={
            {
              strokeDashoffset: offset(shown),
              "--ring-from": offset(from),
              "--ring-to": offset(shown),
            } as CSSProperties
          }
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}
