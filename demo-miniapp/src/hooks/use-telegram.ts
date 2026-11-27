import { useEffect, useRef } from "react";

import {
  inTelegram,
  registerBackButton,
  registerMainButton,
  type ButtonHandle,
  type MainButtonConfig,
} from "@/lib/telegram";

/**
 * Shows Telegram's MainButton with `config` while the calling component is mounted.
 * Pass null to leave the button to someone else. No-op outside Telegram.
 */
export function useMainButton(config: MainButtonConfig | null): void {
  const latest = useRef(config);
  const handle = useRef<ButtonHandle<MainButtonConfig> | null>(null);
  const active = inTelegram && config !== null;

  // Keep the registered config current; runs before the registration effect on mount.
  useEffect(() => {
    latest.current = config;
    if (config) handle.current?.update(config);
  });

  useEffect(() => {
    if (!active || !latest.current) return;
    const h = registerMainButton(latest.current);
    handle.current = h;
    return () => {
      h.remove();
      handle.current = null;
    };
  }, [active]);
}

/** Shows Telegram's BackButton while mounted and calls `onBack` when tapped. */
export function useBackButton(onBack: (() => void) | null): void {
  const latest = useRef(onBack);
  const handle = useRef<ButtonHandle<() => void> | null>(null);
  const active = inTelegram && onBack !== null;

  useEffect(() => {
    latest.current = onBack;
    if (onBack) handle.current?.update(onBack);
  });

  useEffect(() => {
    if (!active) return;
    const h = registerBackButton(() => latest.current?.());
    handle.current = h;
    return () => {
      h.remove();
      handle.current = null;
    };
  }, [active]);
}
