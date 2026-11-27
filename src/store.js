// plans.json (plans, settings, alert marks, share cards) and history.json (every buy), saved atomically.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const PLANS_FILE = "plans.json";
const HISTORY_FILE = "history.json";
const VERSION = 2;

export const DEFAULT_SETTINGS = {
  reminderHours: 6, // 0 = off
  quiet: { start: "23:00", end: "08:00" },
  lowUsdc: true,
  showAmounts: false,
};

export function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

export function writeJson(file, data) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

export const newId = () => randomBytes(4).toString("hex");

export const state = {
  version: VERSION,
  pausedAll: false,
  globalPauseRanges: [], // [{ from, to|null }] ms: periods paused here never break a streak
  settings: { ...DEFAULT_SETTINGS },
  plans: [],
  alerts: { dip: {}, lowUsdc: {} },
  cards: [], // [{ fileId, planId, at }] newest first, for inline mode
};
export const history = []; // newest first (by createdAt)

export function save() {
  writeJson(PLANS_FILE, state);
  writeJson(HISTORY_FILE, { items: history });
}

/** Inserts keeping newest-first order. */
export function insertEntry(entry) {
  const i = history.findIndex((e) => e.createdAt < entry.createdAt);
  history.splice(i === -1 ? history.length : i, 0, entry);
}

const LEGACY_STATUS = { CREATED: "WAITING", PENDING: "ERROR" };

/** Old (v1) history entry → current shape. `describe(key)` returns { symbol, network, contractAddress } for an asset key. */
function migrateEntry(e, describe) {
  if (e.coin) return e;
  const asset = (key, symbol) => {
    const [network, ...rest] = String(key).split(":");
    return { ...describe(key), symbol: symbol ?? describe(key)?.symbol ?? key, network, contractAddress: rest.join(":"), key };
  };
  return {
    id: e.id ?? newId(),
    planId: e.planId ?? null,
    periodKey: null,
    kind: "legacy",
    coin: asset(e.to, e.toSymbol),
    pay: asset(e.from, e.fromSymbol),
    paid: e.amount,
    estimate: e.toAmount ?? null,
    received: null,
    requestId: e.intentId ?? null,
    link: e.deeplink ?? null,
    status: LEGACY_STATUS[e.status] ?? e.status,
    attempted: Boolean(e.intentId) || e.status === "PENDING" || e.status === "FAILED" || e.status === "ERROR",
    approved: false,
    createdAt: Date.parse(e.time),
    completedAt: null,
  };
}

/** Loads both files, migrating the v1 format (old plans are dropped: their format can't be scheduled). */
export function loadState(describe = () => null) {
  const saved = readJson(PLANS_FILE, {});
  if (saved.version === VERSION) {
    Object.assign(state, saved, { settings: { ...DEFAULT_SETTINGS, ...saved.settings } });
  } else {
    state.pausedAll = Boolean(saved.pausedAll);
    if (saved.pausedAll) state.globalPauseRanges = [{ from: Date.now(), to: null }];
    if (saved.plans?.length) console.warn(`Dropped ${saved.plans.length} plan(s) from the old format; create them again.`);
  }
  const items = readJson(HISTORY_FILE, { items: [] }).items ?? [];
  history.length = 0;
  history.push(...items.map((e) => migrateEntry(e, describe)).sort((a, b) => b.createdAt - a.createdAt));
  save();
}
