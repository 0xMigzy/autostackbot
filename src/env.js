// .env handling shared by `npm run setup` and `npm start`. Values are never printed.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { IANAZone } from "luxon";

export const ENV_FILE = ".env";
export const DEFAULT_TZ = "Europe/London";
export const REQUIRED = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID", "COINGECKO_API_KEY"];

/** Format checks (no network). TZ is optional: missing means the default. */
export const CHECKS = {
  TELEGRAM_BOT_TOKEN: (v) => /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(v),
  TELEGRAM_OWNER_ID: (v) => /^[1-9]\d{0,14}$/.test(v),
  COINGECKO_API_KEY: (v) => /^[A-Za-z0-9_-]{8,}$/.test(v),
  TZ: (v) => IANAZone.isValidZone(v),
};

/** KEY=value lines → Map. Ignores blanks and comments; strips a BOM and surrounding quotes. */
export function parseEnv(text) {
  const env = new Map();
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    env.set(line.slice(0, eq).trim(), value);
  }
  return env;
}

export const readEnv = (file = ENV_FILE) => (existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : null);

/** Writes KEY=value lines (UTF-8, no quotes, no BOM) atomically. */
export function writeEnv(env, file = ENV_FILE) {
  const text = [...env].map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(`${file}.tmp`, text, "utf8");
  renameSync(`${file}.tmp`, file);
}

/** Keys that are missing or don't look right. */
export function envProblems(env) {
  if (!env) return [...REQUIRED];
  const bad = REQUIRED.filter((k) => !env.get(k) || !CHECKS[k](env.get(k)));
  if (env.get("TZ") && !CHECKS.TZ(env.get("TZ"))) bad.push("TZ");
  return bad;
}
