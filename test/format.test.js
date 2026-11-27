import { test } from "node:test";
import assert from "node:assert/strict";
import { amount } from "../src/bot/format.js";

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
