// Writes sample share cards to samples/ for visual review: node scripts/samples.js
// Downloads the HYPE logo into cache/logos once (CoinGecko CDN image, no API key).
import { mkdir, writeFile } from "node:fs/promises";
import { renderCard } from "../src/share.js";
import { ensureLogo } from "../src/logos.js";

const outDir = new URL("../samples/", import.meta.url);

const hypeLogo = await ensureLogo({
  coingeckoId: "hyperliquid",
  logoUrl: "https://coin-images.coingecko.com/coins/images/50882/large/hyperliquid.jpg",
});

const goal = {
  coinSymbol: "HYPE", title: "Goal: 1 HYPE", logoPath: hypeLogo, streak: 2, bestStreak: 3,
  periodWord: "week", onTrackDate: "28 Dec",
};

const samples = {
  "goal-progress.png": { ...goal, percent: 32, amountsLine: null },
  "goal-amounts.png": { ...goal, percent: 68, amountsLine: "0.68 of 1 HYPE" },
  // No logo: shows the two-letter fallback circle.
  "no-goal.png": {
    coinSymbol: "ETH", title: "Stacking ETH", logoPath: null, percent: null, streak: 7, bestStreak: 7,
    periodWord: "day", onTrackDate: null, amountsLine: null,
  },
};

await mkdir(outDir, { recursive: true });
for (const [name, card] of Object.entries(samples)) {
  await writeFile(new URL(name, outDir), await renderCard(card));
  console.log(`wrote samples/${name}`);
}
