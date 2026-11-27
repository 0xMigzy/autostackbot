import { useSyncExternalStore } from "react";

import { ASSETS, type Asset } from "./coins";

export interface AssetQuote {
  price: number;
  change24h: number;
  /** CoinGecko logo URL, or null to show the letter logo. */
  image: string | null;
}

export type PriceSource = "loading" | "coingecko" | "sample";

export interface PriceState {
  source: PriceSource;
  quotes: Record<Asset, AssetQuote>;
}

const ASSET_LIST = Object.values(ASSETS);

export const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=" +
  ASSET_LIST.map((a) => a.geckoId).join(",") +
  "&price_change_percentage=24h";

export function samplePrices(): Record<Asset, AssetQuote> {
  const quotes = {} as Record<Asset, AssetQuote>;
  for (const a of ASSET_LIST) {
    quotes[a.symbol] = { price: a.samplePrice, change24h: a.sampleChange24h, image: null };
  }
  return quotes;
}

interface GeckoMarket {
  id?: unknown;
  image?: unknown;
  current_price?: unknown;
  price_change_percentage_24h?: unknown;
  price_change_percentage_24h_in_currency?: unknown;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Merges a CoinGecko /coins/markets response over the sample prices. Pure. */
export function mergeGeckoMarkets(rows: unknown): Record<Asset, AssetQuote> | null {
  if (!Array.isArray(rows)) return null;
  const quotes = samplePrices();
  let matched = 0;
  for (const row of rows as GeckoMarket[]) {
    const info = ASSET_LIST.find((a) => a.geckoId === row.id);
    if (!info) continue;
    const image =
      typeof row.image === "string" && row.image.startsWith("https://") ? row.image : null;
    const change = isFiniteNumber(row.price_change_percentage_24h_in_currency)
      ? row.price_change_percentage_24h_in_currency
      : isFiniteNumber(row.price_change_percentage_24h)
        ? row.price_change_percentage_24h
        : 0;
    quotes[info.symbol] = {
      // USDC is treated as exactly $1 in the demo; only its logo comes from CoinGecko.
      price:
        info.symbol === "USDC"
          ? 1
          : isFiniteNumber(row.current_price) && row.current_price > 0
            ? row.current_price
            : info.samplePrice,
      change24h: info.symbol === "USDC" ? 0 : change,
      image,
    };
    matched += 1;
  }
  return matched > 0 ? quotes : null;
}

let state: PriceState = { source: "loading", quotes: samplePrices() };
const listeners = new Set<() => void>();
let started = false;

function setState(next: PriceState) {
  state = next;
  listeners.forEach((l) => l());
}

/** The single CoinGecko request of a visit. Falls back to sample prices on any failure. */
async function loadOnce() {
  if (started) return;
  started = true;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`CoinGecko answered ${res.status}`);
    const quotes = mergeGeckoMarkets(await res.json());
    setState(
      quotes ? { source: "coingecko", quotes } : { source: "sample", quotes: samplePrices() },
    );
  } catch {
    setState({ source: "sample", quotes: samplePrices() });
  } finally {
    window.clearTimeout(timer);
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void loadOnce();
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;

export function usePrices(): PriceState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
