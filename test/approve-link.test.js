import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_SOURCES, ALLOWED_TYPES, approvePageUrl, tangemLinkFromQuery } from "../demo-miniapp/public/open/link.js";
import { APPROVE_PAGE, approveUrl } from "../src/approve.js";

const ID = "b0e17551-b64a-4fce-bf01-2f0b60722cc9";
const DEEPLINK = `tangem://intent?id=${ID}&source=express&type=exchange`;
const STRICT = /^tangem:\/\/intent\?id=[0-9a-f-]{36}&source=[a-z]+&type=[a-z]+$/;

test("bot: a Tangem deeplink becomes an https link to the /open page", () => {
  assert.equal(APPROVE_PAGE, "https://0xmigzy.github.io/autostackbot/open/");
  assert.equal(approveUrl(DEEPLINK), `${APPROVE_PAGE}?id=${ID}&source=express&type=exchange`);
  assert.equal(approvePageUrl(`tangem://intent?type=exchange&source=express&id=${ID.toUpperCase()}`, "https://x/open/"), `https://x/open/?id=${ID}&source=express&type=exchange`);
});

test("bot: anything that isn't a valid Tangem buy link gives no button", () => {
  for (const link of [
    null,
    undefined,
    "",
    `https://evil.example/?id=${ID}&source=express&type=exchange`,
    `tangem://send?id=${ID}&source=express&type=exchange`,
    `tangem://intent?id=123&source=express&type=exchange`,
    `tangem://intent?id=${ID}&source=evil&type=exchange`,
    `tangem://intent?id=${ID}&source=express&type=send`,
    `tangem://intent?id=${ID}&source=express`,
    `javascript:alert(1)//tangem://intent?id=${ID}&source=express&type=exchange`,
  ]) {
    assert.equal(approveUrl(link), null, String(link));
  }
});

test("page: a valid query opens tangem://intent with the same id, source and type", () => {
  assert.equal(tangemLinkFromQuery(`?id=${ID}&source=express&type=exchange`), DEEPLINK);
  assert.equal(tangemLinkFromQuery(`?id=${ID.toUpperCase()}&source=express&type=exchange`), DEEPLINK);
  // Extra parameters are ignored, never passed on.
  assert.equal(tangemLinkFromQuery(`?id=${ID}&source=express&type=exchange&next=https://evil.example`), DEEPLINK);
});

test("page: the allow-list rejects everything else (no redirect at all)", () => {
  assert.deepEqual(ALLOWED_SOURCES, ["express"]);
  assert.deepEqual(ALLOWED_TYPES, ["exchange"]);
  for (const search of [
    "",
    "?id=",
    `?id=${ID}`,
    `?id=${ID}&source=express`,
    `?id=not-a-uuid&source=express&type=exchange`,
    `?id=${ID}x&source=express&type=exchange`,
    `?id=${ID}&source=Express&type=exchange`,
    `?id=${ID}&source=express&type=exchange2`,
    `?id=${ID}&source=https://evil.example&type=exchange`,
    `?id=${encodeURIComponent(`${ID}&type=x`)}&source=express&type=exchange`,
    `?id=javascript:alert(1)&source=express&type=exchange`,
  ]) {
    assert.equal(tangemLinkFromQuery(search), null, search);
  }
});

test("page: whatever the input, the only possible target is a strict tangem://intent link", () => {
  const pieces = [ID, ID.toUpperCase(), "express", "exchange", "evil", "%26", "&", "=", "#", "javascript:", "//", "tangem://intent", ""];
  for (const a of pieces) {
    for (const b of pieces) {
      for (const c of pieces) {
        const link = tangemLinkFromQuery(`?id=${a}&source=${b}&type=${c}`);
        if (link !== null) assert.match(link, STRICT);
      }
    }
  }
});
