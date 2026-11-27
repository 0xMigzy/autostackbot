// CoinGecko Demo API client with a persisted cache and a strict call budget.
//
// The free Demo plan allows 10,000 calls/month (~322/day) and 100/min. This client:
// - batches every price lookup into ONE /simple/price call for all ids ever seen,
// - caches prices for 5 minutes (30 minutes once today's count reaches 250),
// - stops calling entirely at 320 calls per UTC day and serves the cache instead,
// - never makes more than 30 calls in a rolling minute,
// - backs off on HTTP 429 (60s, doubling up to 30 min, honouring Retry-After).
// The API key only ever travels in the `x-cg-demo-api-key` header and is scrubbed
// from every error message defensively.

const API_ROOT = "https://api.coingecko.com/api/v3";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const PRICE_TTL = 5 * MINUTE;
const SLOW_PRICE_TTL = 30 * MINUTE;
const META_TTL = DAY; // coin platforms + asset platforms

const SLOWDOWN_CALLS = 250; // daily count at which the price TTL becomes 30 min
const HARD_STOP_CALLS = 320; // daily count at which no more calls are made
const MAX_CALLS_PER_MINUTE = 30;

const BACKOFF_START = MINUTE;
const BACKOFF_MAX = 30 * MINUTE;

const SEARCH_LIMIT = 10;

/** UTC calendar day ("YYYY-MM-DD") of a millisecond timestamp. */
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Fill in any missing sections of a (possibly empty or old) persisted cache. */
function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    knownIds: Array.isArray(s.knownIds) ? s.knownIds : [],
    // Last successful price fetch: when, and which ids it asked for.
    pricesAt: typeof s.pricesAt === "number" ? s.pricesAt : null,
    pricesFor: Array.isArray(s.pricesFor) ? s.pricesFor : [],
    // id -> { usd, change24h, at }
    prices: s.prices && typeof s.prices === "object" ? s.prices : {},
    usage: s.usage && typeof s.usage === "object" ? s.usage : { day: null, calls: 0 },
    recentCalls: Array.isArray(s.recentCalls) ? s.recentCalls : [],
    backoff: s.backoff && typeof s.backoff === "object" ? s.backoff : { until: 0, delay: 0 },
    // id -> { at, value }
    coins: s.coins && typeof s.coins === "object" ? s.coins : {},
    // { at, value } | null
    assetPlatforms: s.assetPlatforms ?? null,
  };
}

export function createCoinGecko({ apiKey, fetch = globalThis.fetch, now = Date.now, load, save } = {}) {
  const state = normalizeState(load?.());

  // Serialize all operations so concurrent callers share one fetch and never race on state.
  let queue = Promise.resolve();
  function exclusive(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  /** Remove the API key from any text that may end up in an error or log. */
  function scrub(text) {
    const s = String(text ?? "");
    return apiKey ? s.split(apiKey).join("[redacted]") : s;
  }

  async function persist() {
    try {
      await save?.(state);
    } catch (err) {
      console.warn(`coingecko: failed to persist cache: ${scrub(err?.message)}`);
    }
  }

  /** Today's call count, resetting the counter when the UTC day changes. */
  function todayCalls() {
    const day = utcDay(now());
    if (state.usage.day !== day) state.usage = { day, calls: 0 };
    return state.usage.calls;
  }

  /** Why a call is not allowed right now, or null when it is. */
  function blockReason() {
    const t = now();
    if (state.backoff.until > t) {
      const secs = Math.ceil((state.backoff.until - t) / 1000);
      return `CoinGecko is rate limiting us; retrying in ${secs}s.`;
    }
    if (todayCalls() >= HARD_STOP_CALLS) {
      return "Daily CoinGecko call budget used up; try again after midnight UTC.";
    }
    state.recentCalls = state.recentCalls.filter((at) => t - at < MINUTE);
    if (state.recentCalls.length >= MAX_CALLS_PER_MINUTE) {
      return "Too many CoinGecko calls this minute; try again shortly.";
    }
    return null;
  }

  /** Perform one budgeted GET against the API and return the parsed JSON. */
  async function call(path) {
    const reason = blockReason();
    if (reason) throw new Error(reason);

    const t = now();
    todayCalls();
    state.usage.calls += 1;
    state.recentCalls.push(t);

    const headers = { accept: "application/json" };
    if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

    try {
      let res;
      try {
        res = await fetch(`${API_ROOT}${path}`, { headers });
      } catch (err) {
        throw new Error(`CoinGecko request failed: ${scrub(err?.message)}`);
      }

      if (res.status === 429) {
        const delay = Math.min(state.backoff.delay ? state.backoff.delay * 2 : BACKOFF_START, BACKOFF_MAX);
        const retryAfter = Number(res.headers?.get?.("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(delay, retryAfter * 1000) : delay;
        state.backoff = { until: now() + wait, delay };
        throw new Error(`CoinGecko rate limit hit (HTTP 429); backing off ${Math.ceil(wait / 1000)}s.`);
      }
      if (!res.ok) {
        throw new Error(`CoinGecko HTTP ${res.status} for ${scrub(path.split("?")[0])}`);
      }

      let body;
      try {
        body = await res.json();
      } catch (err) {
        throw new Error(`CoinGecko returned invalid JSON: ${scrub(err?.message)}`);
      }
      state.backoff = { until: 0, delay: 0 };
      return body;
    } finally {
      await persist();
    }
  }

  /** Cached price entries for `ids` (absent ids skipped) and the oldest fetch time among them. */
  function cachedPrices(ids) {
    const prices = {};
    let updatedAt = null;
    for (const id of ids) {
      const entry = state.prices[id];
      if (!entry) continue;
      prices[id] = { usd: entry.usd, change24h: entry.change24h };
      if (updatedAt === null || entry.at < updatedAt) updatedAt = entry.at;
    }
    return { prices, updatedAt };
  }

  /** Lowercased, trimmed, de-duplicated ids. */
  function normalizeIds(ids) {
    return [...new Set((ids ?? []).map((id) => String(id).trim().toLowerCase()).filter(Boolean))];
  }

  /** Price TTL for today's budget situation. */
  function priceTtl() {
    return todayCalls() >= SLOWDOWN_CALLS ? SLOW_PRICE_TTL : PRICE_TTL;
  }

  /** Whether the last price fetch covers all `ids` and is younger than the TTL. */
  function pricesFresh(ids) {
    const covered = new Set(state.pricesFor);
    return state.pricesAt !== null && now() - state.pricesAt < priceTtl() && ids.every((id) => covered.has(id));
  }

  /** Cached prices for `ids` without ever calling the API (for screens that must not spend budget). */
  function peekPrices(ids) {
    const wanted = normalizeIds(ids);
    const cached = cachedPrices(wanted);
    if (wanted.length > 0 && pricesFresh(wanted)) return { prices: cached.prices, updatedAt: state.pricesAt, fresh: true };
    return { ...cached, fresh: false };
  }

  async function getPrices(ids) {
    const wanted = normalizeIds(ids);
    if (wanted.length === 0) return { prices: {}, updatedAt: null, fresh: true };

    return exclusive(async () => {
      if (pricesFresh(wanted)) {
        const { prices } = cachedPrices(wanted);
        return { prices, updatedAt: state.pricesAt, fresh: true };
      }

      // Remember new ids so every future fetch covers them too.
      const union = [...new Set([...state.knownIds, ...wanted])];
      state.knownIds = union;

      try {
        const query = `ids=${encodeURIComponent(union.join(","))}&vs_currencies=usd&include_24hr_change=true`;
        const body = await call(`/simple/price?${query}`);
        const at = now();
        for (const id of union) {
          const row = body?.[id];
          if (row && typeof row.usd === "number") {
            const change = row.usd_24h_change;
            state.prices[id] = { usd: row.usd, change24h: typeof change === "number" ? change : null, at };
          } else {
            delete state.prices[id]; // unknown or delisted: absent from results
          }
        }
        state.pricesAt = at;
        state.pricesFor = union;
        await persist();
        const { prices } = cachedPrices(wanted);
        return { prices, updatedAt: at, fresh: true };
      } catch (err) {
        await persist(); // keep the newly known ids
        const cached = cachedPrices(wanted);
        if (Object.keys(cached.prices).length > 0) return { ...cached, fresh: false };
        throw new Error(scrub(err?.message));
      }
    });
  }

  async function search(query) {
    const q = String(query ?? "").trim();
    if (!q) return [];
    return exclusive(async () => {
      try {
        const body = await call(`/search?query=${encodeURIComponent(q)}`);
        return (body?.coins ?? []).slice(0, SEARCH_LIMIT).map((c) => ({
          id: c.id,
          name: c.name,
          symbol: c.symbol,
          marketCapRank: c.market_cap_rank ?? null,
          image: c.large || c.thumb || null,
        }));
      } catch (err) {
        throw new Error(scrub(err?.message));
      }
    });
  }

  /** Serve a 1-day cached value, refreshing via `fetchValue`; stale cache beats an error. */
  async function cachedMeta(entry, fetchValue, store) {
    if (entry && now() - entry.at < META_TTL) return entry.value;
    try {
      const value = await fetchValue();
      store({ at: now(), value });
      await persist();
      return value;
    } catch (err) {
      if (entry) return entry.value;
      throw new Error(scrub(err?.message));
    }
  }

  async function coinPlatforms(id) {
    const coinId = String(id ?? "").trim().toLowerCase();
    if (!coinId) throw new Error("Missing CoinGecko coin id.");
    // Entries cached before `image` existed report image: null until their normal 1-day refresh.
    const withImage = (coin) => ({ ...coin, image: coin.image ?? null });
    return exclusive(() =>
      cachedMeta(
        state.coins[coinId],
        async () => {
          const params =
            "localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false";
          const body = await call(`/coins/${encodeURIComponent(coinId)}?${params}`);
          const platforms = Object.entries(body?.detail_platforms ?? {})
            .filter(([platformId, d]) => platformId && d?.contract_address)
            .map(([platformId, d]) => ({
              platformId,
              contractAddress: d.contract_address,
              decimals: typeof d.decimal_place === "number" ? d.decimal_place : null,
            }));
          const image = body?.image?.large || body?.image?.small || body?.image?.thumb || null;
          return { id: body?.id ?? coinId, name: body?.name ?? null, symbol: body?.symbol ?? null, image, platforms };
        },
        (entry) => {
          state.coins[coinId] = entry;
        },
      ),
    ).then(withImage);
  }

  async function assetPlatforms() {
    return exclusive(() =>
      cachedMeta(
        state.assetPlatforms,
        async () => {
          const body = await call("/asset_platforms");
          return (Array.isArray(body) ? body : []).map((p) => ({
            id: p.id,
            nativeCoinId: p.native_coin_id ?? null,
            name: p.name,
          }));
        },
        (entry) => {
          state.assetPlatforms = entry;
        },
      ),
    );
  }

  function usage() {
    return { day: utcDay(now()), calls: todayCalls() };
  }

  return { getPrices, peekPrices, search, coinPlatforms, assetPlatforms, usage };
}
