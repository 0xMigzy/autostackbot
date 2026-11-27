/**
 * Thin wrapper around the official Telegram WebApp SDK (telegram-web-app.js).
 * Outside Telegram the SDK object exists but is inert, so everything here degrades to no-ops
 * and the UI shows in-page replacements (primary button, back button).
 */
import type { WebApp } from "telegram-web-app";

export type ColorScheme = "dark" | "light";

const webApp: WebApp | undefined =
  typeof window !== "undefined"
    ? (window.Telegram as Window["Telegram"] | undefined)?.WebApp
    : undefined;

/** True when running inside a Telegram client (not just with the SDK script loaded). */
export const inTelegram = Boolean(
  webApp && (webApp.initData !== "" || (webApp.platform && webApp.platform !== "unknown")),
);

const supports = (version: string) => inTelegram && webApp!.isVersionAtLeast(version);

export function initTelegram(): void {
  if (!inTelegram || !webApp) return;
  webApp.ready();
  webApp.expand();
  if (supports("7.7")) webApp.disableVerticalSwipes();
}

export function telegramColorScheme(): ColorScheme | null {
  return inTelegram && webApp ? webApp.colorScheme : null;
}

export function onTelegramThemeChange(listener: () => void): () => void {
  if (!inTelegram || !webApp) return () => {};
  webApp.onEvent("themeChanged", listener);
  return () => webApp.offEvent("themeChanged", listener);
}

/** Paints Telegram's header, background and bottom bar to match the app. */
export function paintTelegramChrome(background: string): void {
  if (!inTelegram || !webApp) return;
  if (supports("6.1")) {
    webApp.setHeaderColor(background);
    webApp.setBackgroundColor(background);
  }
  if (supports("7.10")) webApp.setBottomBarColor(background);
}

/* ---------------------------------------------------------------- haptics */

export const haptics = {
  selection(): void {
    if (supports("6.1")) webApp!.HapticFeedback.selectionChanged();
  },
  success(): void {
    if (supports("6.1")) webApp!.HapticFeedback.notificationOccurred("success");
  },
  warning(): void {
    if (supports("6.1")) webApp!.HapticFeedback.notificationOccurred("warning");
  },
  tap(): void {
    if (supports("6.1")) webApp!.HapticFeedback.impactOccurred("light");
  },
};

/* ---------------------------------------------------------------- MainButton */

export interface MainButtonConfig {
  text: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}

/** A registration in the MainButton/BackButton stack. */
export interface ButtonHandle<T> {
  update(next: T): void;
  remove(): void;
}

interface Entry<T> {
  id: number;
  value: T;
}

/** The last registered screen owns the button, so a sheet opened over a screen takes it over. */
let mainEntries: Entry<MainButtonConfig>[] = [];
let nextId = 1;
let mainColors = { bg: "#FFFFFF", text: "#0A0A0B", disabledBg: "#2A2A2E", disabledText: "#8E8E93" };
let mainClickBound = false;

function applyMainButton() {
  if (!inTelegram || !webApp) return;
  const button = webApp.MainButton;
  if (!mainClickBound) {
    button.onClick(() => {
      const top = mainEntries[mainEntries.length - 1]?.value;
      if (top && !top.disabled && !top.loading) top.onClick();
    });
    mainClickBound = true;
  }
  const top = mainEntries[mainEntries.length - 1]?.value;
  if (!top) {
    button.hideProgress();
    button.hide();
    return;
  }
  const active = !top.disabled;
  button.setParams({
    text: top.text,
    color: active ? mainColors.bg : mainColors.disabledBg,
    text_color: active ? mainColors.text : mainColors.disabledText,
    is_active: active && !top.loading,
    is_visible: true,
  });
  if (top.loading) button.showProgress(false);
  else button.hideProgress();
}

export function setMainButtonColors(colors: typeof mainColors): void {
  mainColors = colors;
  applyMainButton();
}

export function registerMainButton(config: MainButtonConfig): ButtonHandle<MainButtonConfig> {
  const entry: Entry<MainButtonConfig> = { id: nextId++, value: config };
  mainEntries = [...mainEntries, entry];
  applyMainButton();
  return {
    update(next: MainButtonConfig) {
      entry.value = next;
      applyMainButton();
    },
    remove() {
      mainEntries = mainEntries.filter((e) => e.id !== entry.id);
      applyMainButton();
    },
  };
}

/* ---------------------------------------------------------------- BackButton */

let backEntries: Entry<() => void>[] = [];
let backClickBound = false;

function applyBackButton() {
  if (!inTelegram || !webApp || !supports("6.1")) return;
  const button = webApp.BackButton;
  if (!backClickBound) {
    button.onClick(() => backEntries[backEntries.length - 1]?.value());
    backClickBound = true;
  }
  if (backEntries.length > 0) button.show();
  else button.hide();
}

export function registerBackButton(onBack: () => void): ButtonHandle<() => void> {
  const entry: Entry<() => void> = { id: nextId++, value: onBack };
  backEntries = [...backEntries, entry];
  applyBackButton();
  return {
    update(next: () => void) {
      entry.value = next;
    },
    remove() {
      backEntries = backEntries.filter((e) => e.id !== entry.id);
      applyBackButton();
    },
  };
}
