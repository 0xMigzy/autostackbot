// npm start: Tangem login (QR) → bot, scheduler and alerts. Ctrl+C stops cleanly.
import { IANAZone } from "luxon";
import { addSecret, installConsoleRedaction } from "./src/redact.js";
import { closeTangemClient, getTangemClient } from "./src/tangem.js";
import { createCoinGecko } from "./src/coingecko.js";
import { coinByKey, fillLogoUrls, isUsdc, loadCoins } from "./src/coins.js";
import { loadState, readJson, writeJson } from "./src/store.js";
import * as engine from "./src/engine.js";
import { COMMANDS, createBot } from "./src/bot/bot.js";

try {
  process.loadEnvFile(".env");
} catch {
  console.error("Missing .env: copy .env.example to .env and fill it in (see README).");
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const ownerId = Number(process.env.TELEGRAM_OWNER_ID?.trim());
const coingeckoKey = process.env.COINGECKO_API_KEY?.trim();
const zone = process.env.TZ?.trim() || "Europe/London";
addSecret(token);
addSecret(coingeckoKey);
installConsoleRedaction();

if (!token || !Number.isSafeInteger(ownerId) || ownerId <= 0) {
  console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID (your numeric Telegram user ID) in .env (see README).");
  process.exit(1);
}
if (!coingeckoKey) {
  console.error("Set COINGECKO_API_KEY in .env (a free CoinGecko Demo key, see README).");
  process.exit(1);
}
if (!IANAZone.isValidZone(zone)) {
  console.error(`TZ in .env must be a time zone like Europe/London (got "${zone}").`);
  process.exit(1);
}

console.log("Logging in to Tangem: scan the QR code with your Tangem app if asked.");
try {
  await getTangemClient();
} catch (err) {
  console.error("Tangem login failed:", err.message);
  await closeTangemClient();
  process.exit(1);
}
console.log("Tangem connected.");

const PRICES_FILE = "prices.json";
const coingecko = createCoinGecko({
  apiKey: coingeckoKey,
  load: () => readJson(PRICES_FILE, undefined),
  save: (data) => writeJson(PRICES_FILE, data),
});

loadCoins();
loadState((key) => coinByKey(key) ?? (isUsdc({ key }) ? { symbol: "USDC" } : null));

const app = createBot({ token, ownerId, coingecko });
try {
  await app.bot.init();
  await app.bot.api.setMyCommands(COMMANDS);
} catch (err) {
  console.error("Telegram login failed (check TELEGRAM_BOT_TOKEN):", err.message);
  await closeTangemClient();
  process.exit(1);
}

engine.init({ zone, coingecko, handlers: app.handlers });
engine.start();
fillLogoUrls(coingecko).catch((err) => console.warn("Coin logos:", err.message));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  engine.stop();
  await app.notify("🔴 AutoStack is offline");
  await app.bot.stop();
  await closeTangemClient();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// Long polling; updates sent while AutoStack was offline are dropped, so no stale command or button runs.
await app.bot.start({
  drop_pending_updates: true,
  allowed_updates: ["message", "callback_query", "inline_query"],
  onStart: async ({ username }) => {
    console.log(`AutoStack is online as @${username} (times in ${zone}). Press Ctrl+C to stop.`);
    await app.notify("🟢 AutoStack is online");
  },
});
