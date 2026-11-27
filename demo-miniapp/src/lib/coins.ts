/** Coins the demo can buy, plus USDC which pays for every buy. */
export const COIN_IDS = ["HYPE", "ETH", "BTC", "SOL", "LIT"] as const;
export type CoinId = (typeof COIN_IDS)[number];
export type Asset = CoinId | "USDC";

export interface AssetInfo {
  symbol: Asset;
  name: string;
  /** CoinGecko id used for the one price request per visit. */
  geckoId: string;
  /** Decimals shown for amounts of this asset. */
  decimals: number;
  /** Fallback price (USD) and 24h change (%) when CoinGecko can't be reached. */
  samplePrice: number;
  sampleChange24h: number;
}

export const ASSETS: Record<Asset, AssetInfo> = {
  HYPE: {
    symbol: "HYPE",
    name: "Hyperliquid",
    geckoId: "hyperliquid",
    decimals: 3,
    samplePrice: 63.3,
    sampleChange24h: 2.4,
  },
  ETH: {
    symbol: "ETH",
    name: "Ethereum",
    geckoId: "ethereum",
    decimals: 5,
    samplePrice: 1720,
    sampleChange24h: -1.2,
  },
  BTC: {
    symbol: "BTC",
    name: "Bitcoin",
    geckoId: "bitcoin",
    decimals: 6,
    samplePrice: 61300,
    sampleChange24h: 0.8,
  },
  SOL: {
    symbol: "SOL",
    name: "Solana",
    geckoId: "solana",
    decimals: 3,
    samplePrice: 72.4,
    sampleChange24h: -2.1,
  },
  LIT: {
    symbol: "LIT",
    name: "Lighter",
    geckoId: "lighter",
    decimals: 2,
    samplePrice: 2.54,
    sampleChange24h: 4.6,
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    geckoId: "usd-coin",
    decimals: 2,
    samplePrice: 1,
    sampleChange24h: 0,
  },
};

export const WALLET_ORDER: Asset[] = ["USDC", ...COIN_IDS];

export function isCoinId(value: unknown): value is CoinId {
  return typeof value === "string" && (COIN_IDS as readonly string[]).includes(value);
}
