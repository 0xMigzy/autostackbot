// coins.json: the coins AutoStack can buy. A coin is always identified by network + contract address, never by symbol.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeJson } from "./store.js";
import { assetKey } from "./wallet.js";

const COINS_FILE = "coins.json";

// contractAddress "0" = the network's native coin; "" = not confirmed yet (the coin is hidden until it is filled in).
export const SEED_COINS = [
  { symbol: "ETH", name: "Ethereum", network: "ethereum", contractAddress: "0", decimals: 18, coingeckoId: "ethereum", logoUrl: null },
  { symbol: "BTC", name: "Bitcoin", network: "bitcoin", contractAddress: "0", decimals: 8, coingeckoId: "bitcoin", logoUrl: null },
  { symbol: "SOL", name: "Solana", network: "solana", contractAddress: "0", decimals: 9, coingeckoId: "solana", logoUrl: null },
  { symbol: "HYPE", name: "Hyperliquid", network: "hyperevm", contractAddress: "0", decimals: 18, coingeckoId: "hyperliquid", logoUrl: null },
  // LIT contract confirmed by the owner (matches CoinGecko "lighter" on Ethereum and the wallet's LIT token).
  { symbol: "LIT", name: "Lighter", network: "ethereum", contractAddress: "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2", decimals: 18, coingeckoId: "lighter", logoUrl: null },
];

// Native Circle USDC by network: the only tokens AutoStack pays with.
export const USDC = [
  ["ethereum", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  ["arbitrum-one", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"],
  ["base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  ["optimistic-ethereum", "0x0b2c639c533813f4aa9d7837caf62653d097ff85"],
  ["polygon-pos", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"],
  ["avalanche", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"],
  ["solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
];
const USDC_KEYS = new Set(USDC.map(([network, contract]) => assetKey(network, contract)));
export const isUsdc = (token) => USDC_KEYS.has(token.key ?? assetKey(token.network, token.contractAddress));
export const USDC_COINGECKO_ID = "usd-coin";

const withKey = (coin) => ({ ...coin, key: assetKey(coin.network, coin.contractAddress) });
const FIELDS = ["symbol", "name", "network", "contractAddress", "decimals", "coingeckoId", "logoUrl"];
const stored = (coin) => Object.fromEntries(FIELDS.map((f) => [f, coin[f] ?? null]));

let coins = null;

export function loadCoins() {
  if (!existsSync(COINS_FILE)) writeJson(COINS_FILE, SEED_COINS);
  coins = JSON.parse(readFileSync(COINS_FILE, "utf8")).map(withKey);
  return coins;
}

export const allCoins = () => coins ?? loadCoins();
/** Coins whose contract is confirmed. */
export const usableCoins = () => allCoins().filter((c) => c.contractAddress !== "");
/** Short stable id for button data (keys can be longer than Telegram allows). */
export const shortId = (key) => createHash("sha1").update(key).digest("hex").slice(0, 10);
export const coinByShortId = (id) => usableCoins().find((c) => shortId(c.key) === id) ?? null;
export const coinByKey = (key) => allCoins().find((c) => c.key === key) ?? null;

function saveCoins() {
  writeJson(COINS_FILE, coins.map(stored));
}

/** Adds a coin (from search); returns it. An existing coin with the same network + contract is kept. */
export function addCoin(coin) {
  const added = withKey(coin);
  const existing = coinByKey(added.key);
  if (existing) return existing;
  coins.push(added);
  saveCoins();
  return added;
}

/** Fills missing logoUrl once per coin from CoinGecko (one cached call per coin, then saved for good). */
export async function fillLogoUrls(cg) {
  let changed = false;
  for (const coin of allCoins()) {
    if (coin.logoUrl || !coin.coingeckoId) continue;
    try {
      const info = await cg.coinPlatforms(coin.coingeckoId);
      if (info.image) {
        coin.logoUrl = info.image;
        changed = true;
      }
    } catch (err) {
      console.warn(`No logo for ${coin.symbol}: ${err.message}`);
    }
  }
  if (changed) saveCoins();
}
