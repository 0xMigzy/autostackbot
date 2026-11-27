import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "bg-raised text-foreground placeholder:text-muted-foreground border-input h-11 w-full min-w-0 rounded-xl border px-3 text-base outline-none transition-[border-color,box-shadow] tabular-nums",
        "focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-2",
        "aria-invalid:border-negative aria-invalid:ring-negative/30",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
