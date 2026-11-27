import { useSyncExternalStore } from "react";

import { onTelegramThemeChange, telegramColorScheme, type ColorScheme } from "@/lib/telegram";

const OVERRIDE_KEY = "autostack-demo-theme";
const listeners = new Set<() => void>();

function readOverride(): ColorScheme | null {
  try {
    const v = window.localStorage.getItem(OVERRIDE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

let override = readOverride();

/** Telegram's scheme inside Telegram; elsewhere the visitor's choice, dark by default. */
function getScheme(): ColorScheme {
  return telegramColorScheme() ?? override ?? "dark";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const off = onTelegramThemeChange(listener);
  return () => {
    listeners.delete(listener);
    off();
  };
}

export function setColorSchemeOverride(scheme: ColorScheme): void {
  override = scheme;
  try {
    window.localStorage.setItem(OVERRIDE_KEY, scheme);
  } catch {
    // Not persisted; still applied for this visit.
  }
  listeners.forEach((l) => l());
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, getScheme, getScheme);
}
