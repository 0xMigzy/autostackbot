// npm run setup: asks for the four settings, checks them, and writes .env. Values are never printed.
// --dry-run skips the online checks (Telegram getMe, CoinGecko /ping).
import { createInterface } from "node:readline";
import { CHECKS, DEFAULT_TZ, ENV_FILE, readEnv, writeEnv } from "../src/env.js";

const DRY_RUN = process.argv.includes("--dry-run");
const MAX_TRIES = 5;

// ---- Input: one line at a time, works for typing and for piped input; secrets aren't echoed ----

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const queued = [];
let waiting = null;
let closed = false;
rl.on("line", (line) => (waiting ? (waiting(line), (waiting = null)) : queued.push(line)));
rl.on("close", () => {
  closed = true;
  waiting?.(null);
});
rl.on("SIGINT", () => {
  console.log("\nSetup cancelled. Nothing was written.");
  process.exit(1);
});

let muted = false;
const writeOutput = rl._writeToOutput?.bind(rl);
if (writeOutput) rl._writeToOutput = (s) => (muted ? /[\r\n]/.test(s) && writeOutput("\n") : writeOutput(s));

async function ask(prompt, { secret = false } = {}) {
  process.stdout.write(prompt);
  muted = secret && Boolean(process.stdin.isTTY);
  const line = queued.length ? queued.shift() : closed ? null : await new Promise((resolve) => (waiting = resolve));
  muted = false;
  if (line === null) {
    console.log("\nNo more input. Setup cancelled; nothing was written.");
    process.exit(1);
  }
  if (!process.stdin.isTTY) process.stdout.write("\n");
  return line.trim();
}

const yes = async (prompt) => /^y(es)?$/i.test(await ask(`${prompt} [y/N] `));

// ---- Online checks (skipped with --dry-run); messages never include the values ----

async function checkTelegram(token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json().catch(() => ({}));
    if (body.ok) return { ok: true, note: `Bot @${body.result.username} works.`, username: body.result.username };
    return { ok: false, note: "Telegram didn't accept this token. Copy it again from @BotFather." };
  } catch {
    return { ok: false, note: "Couldn't reach Telegram. Check your internet connection and try again." };
  }
}

async function checkCoinGecko(key) {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/ping", {
      headers: { "x-cg-demo-api-key": key, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true, note: "CoinGecko key works." };
    if (res.status === 429) return { ok: true, note: "CoinGecko is busy right now, but the key was accepted." };
    return { ok: false, note: "CoinGecko didn't accept this key. Copy the Demo key again from your CoinGecko developer dashboard." };
  } catch {
    return { ok: false, note: "Couldn't reach CoinGecko. Check your internet connection and try again." };
  }
}

// ---- The four questions ----

const QUESTIONS = [
  {
    key: "TELEGRAM_BOT_TOKEN",
    title: "Telegram bot token",
    help: "In Telegram, message @BotFather, send /newbot, and paste the token it gives you.",
    secret: true,
    invalid: "That doesn't look like a bot token (it looks like 123456789:AA…).",
    online: checkTelegram,
  },
  {
    key: "TELEGRAM_OWNER_ID",
    title: "Your Telegram user ID",
    help: "Message @userinfobot in Telegram and paste the number it replies with.",
    invalid: "Your user ID is a number, like 123456789.",
  },
  {
    key: "COINGECKO_API_KEY",
    title: "CoinGecko Demo API key",
    help: "Create a free Demo account at coingecko.com/en/api/pricing and paste the key from your developer dashboard.",
    secret: true,
    invalid: "That doesn't look like a CoinGecko key.",
    online: checkCoinGecko,
  },
  {
    key: "TZ",
    title: "Time zone",
    help: `For schedules and messages, like Europe/London or America/New_York. Press Enter for ${DEFAULT_TZ}.`,
    invalid: "That isn't a time zone name. Use one like Europe/London or Asia/Singapore.",
    fallback: DEFAULT_TZ,
  },
];

async function askValue(q) {
  for (let i = 0; i < MAX_TRIES; i++) {
    const value = (await ask(q.secret && process.stdin.isTTY ? "  > (hidden as you type or paste) " : "  > ", { secret: q.secret })) || q.fallback || "";
    if (!value || !CHECKS[q.key](value)) {
      console.log(`  ${q.invalid}`);
      continue;
    }
    if (q.online && !DRY_RUN) {
      const result = await q.online(value);
      console.log(`  ${result.note}`);
      if (!result.ok) continue;
      return { value, username: result.username };
    }
    return { value };
  }
  console.log(`  Too many tries. Setup stopped; nothing was written.`);
  process.exit(1);
}

console.log("AutoStack setup");
console.log(`Your answers are saved in ${ENV_FILE} in this folder and never shown on screen.`);
if (DRY_RUN) console.log("(Dry run: online checks are skipped.)");

const env = readEnv() ?? new Map();
let botUsername = null;
for (const [i, q] of QUESTIONS.entries()) {
  console.log(`\n${i + 1}/${QUESTIONS.length} ${q.title}`);
  console.log(`  ${q.help}`);
  const current = env.get(q.key);
  if (current && CHECKS[q.key](current) && !(await yes(`  ${q.title} is already set. Replace it?`))) {
    console.log("  Kept.");
    continue;
  }
  if (current && !CHECKS[q.key](current)) console.log("  The saved value doesn't look right, so let's set it again.");
  const { value, username } = await askValue(q);
  env.set(q.key, value);
  if (username) botUsername = username;
}

writeEnv(env);
rl.close();
console.log(`\nSaved ${ENV_FILE}.`);
console.log(
  botUsername
    ? `Next: open https://t.me/${botUsername} in Telegram and press Start, then run: npm start`
    : "Next: open your bot in Telegram and press Start, then run: npm start",
);
