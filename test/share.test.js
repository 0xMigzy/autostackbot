import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { renderCard } from "../src/share.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Width/height live in the IHDR chunk right after the signature.
function assertCardPng(png) {
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual(png.subarray(0, 8), PNG_SIG);
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.deepEqual({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, { width: 1080, height: 1080 });
}

const base = {
  coinSymbol: "HYPE", title: "Goal: 1 HYPE", logoPath: null, percent: 32, streak: 2, bestStreak: 3,
  periodWord: "week", onTrackDate: "28 Dec", amountsLine: null,
};

const dir = await mkdtemp(join(tmpdir(), "share-test-"));
test.after(() => rm(dir, { recursive: true, force: true }));

const garbage = join(dir, "garbage.png");
await writeFile(garbage, "definitely not an image");

const realLogo = join(dir, "logo.png");
{
  const c = createCanvas(64, 64);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#f7931a";
  ctx.fillRect(0, 0, 64, 64);
  await writeFile(realLogo, await c.encode("png"));
}

for (const [name, card] of [
  ["goal with progress", base],
  ["no goal (percent null)", { ...base, percent: null, title: "Stacking ETH", onTrackDate: null }],
  ["very long title with amounts", { ...base, title: "Goal: 123456789.123456 SUPERLONGTOKENSYMBOL ".repeat(4), amountsLine: "0.68 of 1 HYPE" }],
  ["logoPath missing from input", { ...base, logoPath: undefined }],
  ["nonexistent logo path", { ...base, logoPath: join(dir, "nope.png") }],
  ["garbage logo file", { ...base, logoPath: garbage }],
  ["real PNG logo", { ...base, logoPath: realLogo }],
]) {
  test(`renderCard: ${name}`, async () => {
    assertCardPng(await renderCard(card));
  });
}
