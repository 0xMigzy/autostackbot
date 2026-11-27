// npm start: Tangem login (QR) → bot, scheduler and alerts. Ctrl+C stops cleanly.
import { existsSync } from "node:fs";
import { addSecret, installConsoleRedaction } from "./src/redact.js";
import { closeTangemClient, getTangemClient } from "./src/tangem.js";
import { createCoinGecko } from "./src/coingecko.js";
import { coinByKey, fillLogoUrls, isUsdc, loadCoins } from "./src/coins.js";
import { loadState, readJson, writeJson } from "./src/store.js";
import { DEFAULT_TZ, envProblems, readEnv } from "./src/env.js";
import * as engine from "./src/engine.js";
import { COMMANDS, createBot } from "./src/bot/bot.js";

const env = readEnv();
const problems = envProblems(env);
if (problems.length) {
  console.error(env ? `Run npm run setup first (missing or not valid: ${problems.join(", ")}).` : "Run npm run setup first.");
  process.exit(1);
}

const token = env.get("TELEGRAM_BOT_TOKEN");
const ownerId = Number(env.get("TELEGRAM_OWNER_ID"));
const coingeckoKey = env.get("COINGECKO_API_KEY");
const zone = env.get("TZ") || DEFAULT_TZ;
addSecret(token);
addSecret(coingeckoKey);
installConsoleRedaction();

// No plans.json yet means AutoStack has never signed in to Tangem from this folder.
if (!existsSync("plans.json")) {
  console.log("First start: a page with a QR code will open in your browser; scan it with the Tangem app on your phone to connect your wallet.");
} else {
  console.log("Connecting to Tangem (scan the QR code with your Tangem app if a page opens).");
}
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
