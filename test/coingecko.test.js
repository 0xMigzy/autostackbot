import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoinGecko } from "../src/coingecko.js";

const KEY = "CG-secret-test-key";
const MIN = 60_000;
const START = Date.UTC(2026, 10, 27, 12, 0, 0);

/** Minimal Response stand-in. */
function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

/** Price table the fake API knows about. */
const MARKET = {
  bitcoin: { usd: 90000, usd_24h_change: 1.5 },
  ethereum: { usd: 3000, usd_24h_change: -2.25 },
  solana: { usd: 150, usd_24h_change: 0.5 },
};

/** Build a client with a fake clock, fake fetch and in-memory persistence. */
function setup({ handler, initial } = {}) {
  const clock = { t: START };
  const calls = [];
  let store = initial;
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), headers: init?.headers ?? {} });
    if (handler) return handler(new URL(url));
    const ids = new URL(url).searchParams.get("ids")?.split(",");
    if (!ids) return response(200, { coins: [] }); // /search
    const body = {};
    for (const id of ids) if (MARKET[id]) body[id] = MARKET[id];
    return response(200, body);
  };
  const cg = createCoinGecko({
    apiKey: KEY,
    fetch,
    now: () => clock.t,
    load: () => (store ? structuredClone(store) : undefined),
    save: (obj) => {
      store = structuredClone(obj);
    },
  });
  return { cg, calls, clock, stored: () => store };
}

const idsOf = (call) => call.url.searchParams.get("ids").split(",").sort();

test("one batched call for several ids incl. 24h change; key in header", async () => {
  const { cg, calls, clock } = setup();
  const r = await cg.getPrices(["bitcoin", "ethereum"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/v3/simple/price");
  assert.deepEqual(idsOf(calls[0]), ["bitcoin", "ethereum"]);
  assert.equal(calls[0].url.searchParams.get("vs_currencies"), "usd");
  assert.equal(calls[0].url.searchParams.get("include_24hr_change"), "true");
  assert.equal(calls[0].headers["x-cg-demo-api-key"], KEY);
  assert.ok(!calls[0].url.href.includes(KEY), "key must not be in the URL");
  assert.deepEqual(r, {
    prices: { bitcoin: { usd: 90000, change24h: 1.5 }, ethereum: { usd: 3000, change24h: -2.25 } },
    updatedAt: clock.t,
    fresh: true,
  });
});

test("served from cache within 5 min, refetched after", async () => {
  const { cg, calls, clock } = setup();
  await cg.getPrices(["bitcoin"]);
  const fetchedAt = clock.t;
  clock.t += 4 * MIN;
  const r = await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 1);
  assert.equal(r.fresh, true);
  assert.equal(r.updatedAt, fetchedAt);
  clock.t += 1 * MIN + 1;
  const r2 = await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 2);
  assert.equal(r2.updatedAt, clock.t);
});

test("subset hits cache; new id triggers one union call", async () => {
  const { cg, calls } = setup();
  await cg.getPrices(["bitcoin", "ethereum"]);
  const sub = await cg.getPrices(["ethereum"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(sub.prices, { ethereum: { usd: 3000, change24h: -2.25 } });

  const r = await cg.getPrices(["solana"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(idsOf(calls[1]), ["bitcoin", "ethereum", "solana"]);
  assert.deepEqual(Object.keys(r.prices), ["solana"]);

  // All three now cached together.
  await cg.getPrices(["bitcoin", "solana", "ethereum"]);
  assert.equal(calls.length, 2);
});

test("ids missing from the response are absent", async () => {
  const { cg } = setup();
  const r = await cg.getPrices(["bitcoin", "not-a-coin"]);
  assert.deepEqual(Object.keys(r.prices), ["bitcoin"]);
});

test("known ids persist across instances", async () => {
  const first = setup();
  await first.cg.getPrices(["bitcoin", "ethereum"]);
  const second = setup({ initial: first.stored() });
  second.clock.t = first.clock.t + 10 * MIN;
  await second.cg.getPrices(["solana"]);
  assert.deepEqual(idsOf(second.calls[0]), ["bitcoin", "ethereum", "solana"]);
});

test("peekPrices never calls and reports what is cached", async () => {
  const { cg, calls, clock } = setup();
  assert.deepEqual(cg.peekPrices(["bitcoin"]), { prices: {}, updatedAt: null, fresh: false });
  assert.equal(calls.length, 0);
  await cg.getPrices(["bitcoin", "ethereum"]);
  const fetchedAt = clock.t;
  assert.deepEqual(cg.peekPrices(["ethereum", "solana"]), {
    prices: { ethereum: { usd: 3000, change24h: -2.25 } },
    updatedAt: fetchedAt,
    fresh: false, // solana not covered by the last fetch
  });
  assert.deepEqual(cg.peekPrices(["bitcoin"]), {
    prices: { bitcoin: { usd: 90000, change24h: 1.5 } },
    updatedAt: fetchedAt,
    fresh: true,
  });
  clock.t += 60 * MIN;
  const stale = cg.peekPrices(["bitcoin"]);
  assert.equal(stale.fresh, false);
  assert.equal(stale.prices.bitcoin.usd, 90000);
  assert.equal(calls.length, 1);
});

test("daily counter increments and resets next UTC day", async () => {
  const { cg, clock } = setup();
  assert.deepEqual(cg.usage(), { day: "2026-11-27", calls: 0 });
  await cg.getPrices(["bitcoin"]);
  clock.t += 6 * MIN;
  await cg.getPrices(["bitcoin"]);
  await cg.search("btc");
  assert.deepEqual(cg.usage(), { day: "2026-11-27", calls: 3 });
  clock.t = Date.UTC(2026, 10, 28, 0, 0, 1);
  assert.deepEqual(cg.usage(), { day: "2026-11-28", calls: 0 });
  await cg.getPrices(["bitcoin"]);
  assert.deepEqual(cg.usage(), { day: "2026-11-28", calls: 1 });
});

test(">= 250 calls today: TTL becomes 30 min", async () => {
  const { cg, calls, clock } = setup({ initial: { usage: { day: "2026-11-27", calls: 250 } } });
  await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 1);
  clock.t += 20 * MIN;
  const r = await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 1);
  assert.equal(r.fresh, true);
  clock.t += 10 * MIN;
  await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 2);
});

test(">= 320 calls today: no calls, stale cache served", async () => {
  const { cg, calls, clock } = setup({ initial: { usage: { day: "2026-11-27", calls: 319 } } });
  await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 1);
  clock.t += 60 * MIN;
  const r = await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 1);
  assert.equal(r.fresh, false);
  assert.equal(r.prices.bitcoin.usd, 90000);
  await assert.rejects(cg.search("eth"), /budget/i);
  assert.equal(calls.length, 1);
});

test("never more than 30 calls in a rolling minute", async () => {
  const { cg, calls, clock } = setup();
  for (let i = 0; i < 35; i++) await cg.search(`q${i}`).catch(() => {});
  assert.equal(calls.length, 30);
  clock.t += MIN;
  await cg.search("again");
  assert.equal(calls.length, 31);
});

test("429 backs off 60s, doubles on consecutive 429s, resets after success", async () => {
  let mode = "ok";
  const { cg, calls, clock } = setup({
    handler: (url) => {
      if (mode === "429") return response(429, {});
      return response(200, { bitcoin: MARKET.bitcoin });
    },
  });
  await cg.getPrices(["bitcoin"]);
  mode = "429";
  clock.t += 6 * MIN;
  const stale = await cg.getPrices(["bitcoin"]);
  assert.equal(stale.fresh, false);
  assert.equal(calls.length, 2);

  clock.t += 59_000; // still backing off
  assert.equal((await cg.getPrices(["bitcoin"])).fresh, false);
  assert.equal(calls.length, 2);

  clock.t += 1_000; // 60s window over: retry, 429 again -> 120s
  await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 3);
  clock.t += 119_000;
  await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 3);

  mode = "ok";
  clock.t += 1_000;
  const fresh = await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 4);
  assert.equal(fresh.fresh, true);

  // Success reset the backoff: the next 429 waits 60s again.
  mode = "429";
  clock.t += 6 * MIN;
  await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 5);
  clock.t += 60_000;
  await cg.getPrices(["bitcoin"]);
  assert.equal(calls.length, 6);
});

test("429 respects Retry-After and caps doubling at 30 min", async () => {
  let retryAfter = "300";
  const { cg, calls, clock } = setup({ handler: () => response(429, {}, { "retry-after": retryAfter }) });
  await assert.rejects(cg.getPrices(["bitcoin"]), /429/);
  clock.t += 299_000;
  await assert.rejects(cg.search("x"), /rate limit/i);
  assert.equal(calls.length, 1);
  clock.t += 1_000;
  retryAfter = undefined;
  // Keep hitting 429: delays 120s, 240s, ... capped at 30 min.
  let expected = 60_000;
  for (let i = 0; i < 8; i++) {
    expected = Math.min(expected * 2, 30 * MIN);
    await cg.getPrices(["bitcoin"]).catch(() => {});
    const n = calls.length;
    clock.t += expected - 1;
    await cg.getPrices(["bitcoin"]).catch(() => {});
    assert.equal(calls.length, n, `still backing off at step ${i}`);
    clock.t += 1;
  }
  assert.equal(expected, 30 * MIN);
});

test("failure with cache returns stale cache", async () => {
  let fail = false;
  const { cg, clock } = setup({
    handler: () => {
      if (fail) throw new Error("network down");
      return response(200, { ethereum: MARKET.ethereum });
    },
  });
  const first = await cg.getPrices(["ethereum"]);
  fail = true;
  clock.t += 10 * MIN;
  const r = await cg.getPrices(["ethereum"]);
  assert.deepEqual(r, { prices: first.prices, updatedAt: first.updatedAt, fresh: false });
});

test("failure without cache throws without the key in the message", async () => {
  const { cg } = setup({
    handler: () => {
      throw new Error(`connect failed with header x-cg-demo-api-key=${KEY}`);
    },
  });
  await assert.rejects(cg.getPrices(["bitcoin"]), (err) => {
    assert.ok(!err.message.includes(KEY), err.message);
    return true;
  });
  const http = setup({ handler: () => response(500, {}) });
  await assert.rejects(http.cg.getPrices(["bitcoin"]), (err) => {
    assert.match(err.message, /HTTP 500/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test("search maps the top 10 coins", async () => {
  const coins = Array.from({ length: 12 }, (_, i) => ({
    id: `coin-${i}`,
    name: `Coin ${i}`,
    symbol: `C${i}`,
    market_cap_rank: i === 0 ? null : i,
    ...(i === 0 ? {} : i === 1 ? { thumb: "t1.png", large: "l1.png" } : { thumb: `t${i}.png` }),
  }));
  const { cg, calls } = setup({ handler: () => response(200, { coins }) });
  const r = await cg.search("coin");
  assert.equal(calls[0].url.pathname, "/api/v3/search");
  assert.equal(calls[0].url.searchParams.get("query"), "coin");
  assert.equal(r.length, 10);
  assert.deepEqual(r[0], { id: "coin-0", name: "Coin 0", symbol: "C0", marketCapRank: null, image: null });
  assert.deepEqual(r[1], { id: "coin-1", name: "Coin 1", symbol: "C1", marketCapRank: 1, image: "l1.png" });
  assert.equal(r[2].image, "t2.png"); // falls back to thumb
});

test("coinPlatforms uses detail_platforms and caches for a day", async () => {
  const { cg, calls, clock } = setup({
    handler: () =>
      response(200, {
        id: "lighter",
        name: "Lighter",
        symbol: "lit",
        image: { thumb: "thumb.png", small: "small.png", large: "large.png" },
        detail_platforms: {
          ethereum: { decimal_place: 18, contract_address: "0xabc" },
          "": { decimal_place: null, contract_address: "" },
          base: { decimal_place: null, contract_address: "0xdef" },
          solana: { decimal_place: 9, contract_address: "" },
        },
      }),
  });
  const r = await cg.coinPlatforms("lighter");
  assert.equal(calls[0].url.pathname, "/api/v3/coins/lighter");
  assert.equal(calls[0].url.searchParams.get("tickers"), "false");
  assert.equal(calls[0].url.searchParams.get("market_data"), "false");
  assert.deepEqual(r, {
    id: "lighter",
    name: "Lighter",
    symbol: "lit",
    image: "large.png",
    platforms: [
      { platformId: "ethereum", contractAddress: "0xabc", decimals: 18 },
      { platformId: "base", contractAddress: "0xdef", decimals: null },
    ],
  });
  clock.t += 23 * 60 * MIN;
  await cg.coinPlatforms("lighter");
  assert.equal(calls.length, 1);
  clock.t += 61 * MIN;
  await cg.coinPlatforms("lighter");
  assert.equal(calls.length, 2);
});

test("coinPlatforms image falls back to small/thumb/null; old cache entries report null without a call", async () => {
  let image;
  const { cg, calls } = setup({
    handler: () => response(200, { id: "x", name: "X", symbol: "x", image, detail_platforms: {} }),
  });
  image = { thumb: "thumb.png", small: "small.png" };
  assert.equal((await cg.coinPlatforms("a")).image, "small.png");
  image = { thumb: "thumb.png" };
  assert.equal((await cg.coinPlatforms("b")).image, "thumb.png");
  image = undefined;
  assert.equal((await cg.coinPlatforms("c")).image, null);

  const legacy = setup({
    initial: {
      coins: { old: { at: START, value: { id: "old", name: "Old", symbol: "o", platforms: [] } } },
    },
  });
  const r = await legacy.cg.coinPlatforms("old");
  assert.deepEqual(r, { id: "old", name: "Old", symbol: "o", platforms: [], image: null });
  assert.equal(legacy.calls.length, 0);
  assert.equal(calls.length, 3);
});

test("assetPlatforms maps and caches for a day", async () => {
  const { cg, calls, clock, stored } = setup({
    handler: () =>
      response(200, [
        { id: "ethereum", chain_identifier: 1, name: "Ethereum", native_coin_id: "ethereum" },
        { id: "base", chain_identifier: 8453, name: "Base", native_coin_id: "ethereum" },
      ]),
  });
  const r = await cg.assetPlatforms();
  assert.equal(calls[0].url.pathname, "/api/v3/asset_platforms");
  assert.deepEqual(r, [
    { id: "ethereum", nativeCoinId: "ethereum", name: "Ethereum" },
    { id: "base", nativeCoinId: "ethereum", name: "Base" },
  ]);
  clock.t += 12 * 60 * MIN;
  await cg.assetPlatforms();
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(stored()).includes(KEY), "key must not be persisted");
});
