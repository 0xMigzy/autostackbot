import { test } from "node:test";
import assert from "node:assert/strict";
import { amount, portfolioRows } from "../src/bot/format.js";

test("coin amounts show 4 significant digits", () => {
  assert.equal(amount("0.150547"), "0.1505");
  assert.equal(amount("0.077679708933387457"), "0.07768");
  assert.equal(amount("40.033285"), "40.03");
  assert.equal(amount("0.000012345"), "0.00001235");
  assert.equal(amount("10"), "10");
  assert.equal(amount("0"), "0");
});

test("amounts from 1,000 up keep the whole number", () => {
  assert.equal(amount("1234.56"), "1,235");
  assert.equal(amount("61307.9"), "61,308");
});

test("portfolio shows only balances above zero, largest $ value first", () => {
  const token = (symbol, networkName, key) => ({ symbol, networkName, key });
  const tokens = [
    token("ETH", "Ethereum", "eth"),
    token("USDC", "Ethereum", "usdc"),
    token("SOL", "Solana", "sol"), // balance not available: left out
    token("BTC", "Bitcoin", "btc"), // zero: left out
    token("LIT", "Ethereum", "lit"), // no price: shown without $, after priced ones
  ];
  const balances = new Map([["eth", "0.005"], ["usdc", "40.033285"], ["btc", "0"], ["lit", "12.5"]]);
  const prices = { eth: 1720, usdc: 1 };
  const { rows, total } = portfolioRows(tokens, balances, (t) => prices[t.key] ?? null);
  assert.deepEqual(rows.map((r) => r.line), [
    "USDC · Ethereum   40.03   ($40.03)",
    "ETH · Ethereum   0.005   ($8.60)",
    "LIT · Ethereum   12.5",
  ]);
  assert.ok(Math.abs(total - (40.033285 + 8.6)) < 1e-9);
  assert.deepEqual(portfolioRows(tokens, new Map(), () => 1).rows, []);
});
