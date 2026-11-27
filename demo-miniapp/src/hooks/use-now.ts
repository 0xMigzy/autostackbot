import { useSyncExternalStore } from "react";

/** One shared clock for countdowns; ticks every 15 s while something is listening. */
let now = new Date();
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    timer = window.setInterval(() => {
      now = new Date();
      listeners.forEach((l) => l());
    }, 15_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

const getNow = () => now;

export function useNow(): Date {
  return useSyncExternalStore(subscribe, getNow, getNow);
}

/** Current time for event handlers, also refreshing the shared clock. */
export function currentTime(): Date {
  now = new Date();
  return now;
}
