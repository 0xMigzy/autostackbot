import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLogo } from "../src/logos.js";

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const URL_ = "https://coin-images.coingecko.com/coins/images/1/large/coin.png";

const root = await mkdtemp(join(tmpdir(), "logos-test-"));
test.after(() => rm(root, { recursive: true, force: true }));

let n = 0;
const freshDir = () => join(root, `d${n++}`);

/** Fake fetch recording calls and replying with the given status/body. */
function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return new Response(body, { status });
  };
  fn.calls = calls;
  return fn;
}

// Silence the expected warnings from failure cases.
mock.method(console, "warn", () => {});

test("cached file is returned without fetching", async () => {
  const dir = freshDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "bitcoin.png"), PNG_BYTES);
  const fetch = fakeFetch(200, PNG_BYTES);
  const path = await ensureLogo({ coingeckoId: "bitcoin", logoUrl: URL_ }, { dir, fetch });
  assert.equal(path, join(dir, "bitcoin.png"));
  assert.equal(fetch.calls.length, 0);
});

test("successful download writes the file", async () => {
  const dir = freshDir();
  const fetch = fakeFetch(200, PNG_BYTES);
  const path = await ensureLogo({ coingeckoId: "bitcoin", logoUrl: URL_ }, { dir, fetch });
  assert.equal(path, join(dir, "bitcoin.png"));
  assert.deepEqual(await readFile(path), PNG_BYTES);
  assert.deepEqual(fetch.calls, [URL_]);
  assert.deepEqual(await readdir(dir), ["bitcoin.png"]); // no temp file left behind
});

test("HTTP error returns null", async () => {
  const dir = freshDir();
  assert.equal(await ensureLogo({ coingeckoId: "bitcoin", logoUrl: URL_ }, { dir, fetch: fakeFetch(404, "nope") }), null);
});

test("non-image bytes return null and are not cached", async () => {
  const dir = freshDir();
  const fetch = fakeFetch(200, "<html>not an image</html>");
  assert.equal(await ensureLogo({ coingeckoId: "bitcoin", logoUrl: URL_ }, { dir, fetch }), null);
  assert.deepEqual(await readdir(dir).catch(() => []), []);
});

test("missing or non-http logoUrl returns null without fetching", async () => {
  const fetch = fakeFetch(200, PNG_BYTES);
  assert.equal(await ensureLogo({ coingeckoId: "bitcoin" }, { dir: freshDir(), fetch }), null);
  assert.equal(await ensureLogo({ coingeckoId: "bitcoin", logoUrl: "file:///etc/passwd" }, { dir: freshDir(), fetch }), null);
  assert.equal(fetch.calls.length, 0);
});

test("fetch throwing returns null", async () => {
  const fetch = async () => { throw new Error("network down"); };
  assert.equal(await ensureLogo({ coingeckoId: "bitcoin", logoUrl: URL_ }, { dir: freshDir(), fetch }), null);
});
