// npm start: Tangem login (QR) → bot and scheduler → "online" message. Ctrl+C sends "offline".
import { closeTangemClient, getTangemClient } from "./tangem.js";
import * as core from "./plans.js";
import { COMMANDS, createBot } from "./bot.js";

try {
  process.loadEnvFile(".env");
} catch {
  console.error("Missing .env: copy .env.example to .env and fill it in (see README).");
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const ownerId = Number(process.env.TELEGRAM_OWNER_ID?.trim());
if (!token || !Number.isSafeInteger(ownerId) || ownerId <= 0) {
  console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID (your numeric Telegram user ID) in .env (see README).");
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

const app = createBot({ token, ownerId });
try {
  await app.bot.init();
  await app.bot.api.setMyCommands(COMMANDS);
} catch (err) {
  console.error("Telegram login failed (check TELEGRAM_BOT_TOKEN):", err.message);
  await closeTangemClient();
  process.exit(1);
}

core.init(app.events);
core.startScheduler();
app.startWatching();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  core.stopScheduler();
  app.stopWatching();
  await app.notifyOwner("🔴 AutoStackBot is offline");
  await app.bot.stop();
  await closeTangemClient();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// Long polling; updates sent while the bot was offline are dropped so no stale command or button runs.
await app.bot.start({
  drop_pending_updates: true,
  onStart: async ({ username }) => {
    console.log(`AutoStackBot is online as @${username}. Press Ctrl+C to stop.`);
    await app.notifyOwner("🟢 AutoStackBot is online");
  },
});
