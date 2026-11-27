// Keeps the bot token and API keys out of logs and error messages: every occurrence becomes "***".
import { format } from "node:util";

const secrets = new Set();

export function addSecret(value) {
  if (typeof value === "string" && value.trim().length >= 6) secrets.add(value.trim());
}

export function redact(text) {
  let out = String(text ?? "");
  for (const secret of secrets) out = out.split(secret).join("***");
  return out;
}

/** Routes console output through redact(), objects and errors included. */
export function installConsoleRedaction() {
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(redact(format(...args)));
  }
}
