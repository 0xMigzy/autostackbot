// Engine tests with a fake Tangem layer: no network, nothing real is ever prepared. Runs in a temp folder so the
// state files it writes never touch the real ones.
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";

const tz = "Europe/London";
const at = (iso) => DateTime.fromISO(iso, { zone: tz }).toMillis();
const home = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "autostack-engine-"));
process.chdir(dir);

const E = await import("../src/engine.js");
const { history, state } = await import("../src/store.js");

const USDC = { key: "ethereum:0xa0b8", symbol: "USDC", network: "ethereum", networkName: "Ethereum", contractAddress: "0xa0b8", decimals: 6, address: "0xme" };
const HYPE = { key: "hyperevm:0", symbol: "HYPE", name: "Hyperliquid", network: "hyperevm", networkName: "HyperEVM", contractAddress: "0", decimals: 18, address: "0xme", coingeckoId: "hyperliquid" };
const requests = []; // every (fake) buy request created
const ready = [];

before(() => {
  mock.timers.enable({ apis: ["Date"], now: at("2026-12-01T10:00") });
  E.useWalletForTests({
    loadWallet: async () => [USDC, HYPE],
    getWallet: async () => [USDC, HYPE],
    loadBalances: async () => new Map(),
    addressOn: async () => "0xme",
    networkName: async (n) => n,
    bestPrice: async () => ({ amountMinor: "10000000", best: { provider: "fake", rateType: "float", toAmount: "0.15" } }),
    createBuyRequest: async () => {
      requests.push(Date.now());
      return { requestId: `req-${requests.length}`, link: "tangem://intent?id=fake" };
    },
    buyStatus: async () => ({ status: "WAITING", approved: false, received: null }),
  });
  E.init({
    zone: tz,
    coingecko: { peekPrices: () => ({ prices: {} }), getPrices: async () => ({ prices: {} }) },
    handlers: { buyReady: (entry) => ready.push(entry) },
  });
});

after(() => {
  mock.timers.reset();
  process.chdir(home);
  rmSync(dir, { recursive: true, force: true });
});

const draft = {
  coin: { symbol: "HYPE", name: "Hyperliquid", network: "hyperevm", contractAddress: "0", decimals: 18, coingeckoId: "hyperliquid", key: HYPE.key },
  pay: { symbol: "USDC", network: "ethereum", networkName: "Ethereum", contractAddress: "0xa0b8", key: USDC.key },
  amount: "10",
  schedule: { freq: "daily", time: "18:00" },
  stop: { type: "never" },
};

test("Start with Buy now: one request at once, covering today; no second buy today; tomorrow's runs", async () => {
  const { plan, entry, error } = await E.startPlan(draft, { buyNow: true });
  assert.equal(error, null);
  assert.equal(requests.length, 1);
  assert.equal(entry.kind, "now");
  assert.equal(entry.status, "WAITING");
  assert.equal(ready.length, 1); // the "Your buy is ready" message
  assert.equal(plan.lastPreparedKey, "d:2026-12-01");
  assert.equal(DateTime.fromMillis(E.nextBuyAt(plan), { zone: tz }).toFormat("yyyy-MM-dd HH:mm"), "2026-12-02 18:00");

  // Approved at 10:30: it counts for today's streak.
  mock.timers.setTime(at("2026-12-01T10:30"));
  Object.assign(history.find((e) => e.id === entry.id), { status: "COMPLETED", completedAt: Date.now(), received: "0.15" });

  // Today's 18:00 slot is covered: the scheduler prepares nothing.
  mock.timers.setTime(at("2026-12-01T18:05"));
  await E.tickForTests();
  assert.equal(requests.length, 1);
  assert.deepEqual(E.streakOf(plan), { current: 1, best: 1 });

  // Tomorrow at 18:00 the schedule takes over: exactly one scheduled request.
  mock.timers.setTime(at("2026-12-02T18:01"));
  await E.tickForTests();
  await E.tickForTests();
  assert.equal(requests.length, 2);
  assert.equal(history[0].kind, "scheduled");
});

test("Start with Wait for the schedule: no request until the first due time", async () => {
  mock.timers.setTime(at("2026-12-03T09:00"));
  const before = requests.length;
  const { plan, entry } = await E.startPlan({ ...draft, coin: { ...draft.coin } }, { buyNow: false });
  assert.equal(entry, null);
  assert.equal(requests.length, before);
  assert.equal(DateTime.fromMillis(E.nextBuyAt(plan), { zone: tz }).toFormat("yyyy-MM-dd HH:mm"), "2026-12-03 18:00");
});

test("Buy now is refused while everything is paused (nothing prepared)", async () => {
  mock.timers.setTime(at("2026-12-04T09:00"));
  await E.setPausedAll(true);
  const before = requests.length;
  const { plan, entry, error } = await E.startPlan(draft, { buyNow: true });
  assert.equal(entry, null);
  assert.match(error.message, /paused/i);
  assert.equal(requests.length, before);
  assert.equal(plan.status, "active");
  await E.setPausedAll(false);
});

test("clear history keeps buys in progress and resets the plan's streak", async () => {
  mock.timers.setTime(at("2026-12-05T09:00"));
  const plan = state.plans[0];
  const waiting = history.filter((e) => e.status === "WAITING").length;
  const { deleted, kept } = await E.clearHistory(HYPE.key);
  assert.equal(kept, waiting);
  assert.ok(deleted >= 1);
  assert.ok(history.every((e) => e.status === "WAITING" || e.status === "PENDING"));
  assert.deepEqual(E.streakOf(plan), { current: 0, best: 0 });
});
