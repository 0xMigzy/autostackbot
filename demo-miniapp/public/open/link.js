// Approval links, shared by the /open redirect page and the AutoStack bot. No dependencies; runs in browsers and Node.
// The page only ever opens tangem://intent?id=<uuid>&source=<allowed>&type=<allowed>; anything else is rejected.

export const ALLOWED_SOURCES = ["express"];
export const ALLOWED_TYPES = ["exchange"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** { id, source, type } when the id is a UUID and source/type are allowed; otherwise null. */
export function validIntent({ id, source, type }) {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (!ALLOWED_SOURCES.includes(source) || !ALLOWED_TYPES.includes(type)) return null;
  return { id: id.toLowerCase(), source, type };
}

const query = ({ id, source, type }) => `?id=${id}&source=${source}&type=${type}`;

/** The page: query string (e.g. location.search) → the Tangem link to open, or null. */
export function tangemLinkFromQuery(search) {
  const q = new URLSearchParams(search);
  const intent = validIntent({ id: q.get("id"), source: q.get("source"), type: q.get("type") });
  return intent && `tangem://intent${query(intent)}`;
}

/** The bot: Tangem deeplink (tangem://intent?…) → https link to the /open page at pageUrl, or null. */
export function approvePageUrl(deeplink, pageUrl) {
  const match = /^tangem:\/\/intent\?([^#]*)$/.exec(String(deeplink ?? ""));
  if (!match) return null;
  const q = new URLSearchParams(match[1]);
  const intent = validIntent({ id: q.get("id"), source: q.get("source"), type: q.get("type") });
  return intent && `${pageUrl}${query(intent)}`;
}
