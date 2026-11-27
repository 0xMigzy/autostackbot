import { Slider as SliderPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

function Slider({
  className,
  thumbLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & { thumbLabel: string }) {
  const count = (props.value ?? props.defaultValue ?? [0]).length;
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "relative flex w-full touch-none items-center py-2 select-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="bg-chip relative h-1.5 w-full grow overflow-hidden rounded-full"
      >
        <SliderPrimitive.Range data-slot="slider-range" className="bg-primary absolute h-full" />
      </SliderPrimitive.Track>
      {Array.from({ length: count }, (_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          aria-label={thumbLabel}
          data-slot="slider-thumb"
          className="bg-primary ring-offset-background focus-visible:ring-ring block size-6 shrink-0 rounded-full border-2 border-[var(--card)] shadow-md transition-transform outline-none focus-visible:ring-2 focus-visible:ring-offset-2 active:scale-110"
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
