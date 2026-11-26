import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getTangemClient, closeTangemClient } from "./tangem.js";

const PORT = Number(process.env.PORT) || 3000;
const APP_URL = `http://localhost:${PORT}`;
const PLANS_FILE = "plans.json";
const HISTORY_FILE = "history.json";
const TICK_MS = 60_000;
const DAILY_BUY_CAP = 3; // buy attempts per local calendar day, all plans together
const QUOTE_RETRY_DELAYS_MS = [1000, 2000]; // backoff before each retry of a retryable quote error
const NATIVE_CONTRACT = "0"; // Express id for a network's native coin
const NETWORKS_URI = "express+tangem-express://networks";
const PROVIDERS_URI = "express+tangem-express://providers";
const PLAN_TYPES = ["recurring", "limit"];
const LOGIN_EXPIRED = "Tangem login expired. Restart Auto-Stack and scan the QR code again.";
// mcp-remote and the SDK only surface auth failures as error text.
const AUTH_ERROR = /\b401\b|unauthori[sz]ed|invalid_token|invalid_grant|token (?:has )?expired|login expired/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A tool result with isError; code and retryable come from the "[code=2540 retryable=true]" suffix. */
class ToolError extends Error {
  status = 502;
  constructor(message, code, retryable) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const isAuthError = (err) => AUTH_ERROR.test(String(err?.message ?? ""));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callTool(name, args = {}) {
  const client = await getTangemClient();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (result.isError) {
    const meta = /\[code=(\d+)(?:\s+retryable=(true|false))?\]\s*$/.exec(text);
    const message = text.replace(/\s*\[code=[^\]]*\]\s*$/, "").trim() || `${name} failed`;
    throw new ToolError(message, meta ? Number(meta[1]) : undefined, meta?.[2] === "true");
  }
  return result.structuredContent ?? JSON.parse(text);
}

/** For read-only quote calls only: retries when Tangem marks the error retryable, with backoff. */
async function callQuoteTool(name, args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callTool(name, args);
    } catch (err) {
      const delay = QUOTE_RETRY_DELAYS_MS[attempt];
      if (!(err instanceof ToolError && err.retryable) || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}

// ---- Resources (read once, cached) ----

let resourcesPromise = null;

function getResources() {
  resourcesPromise ??= (async () => {
    const client = await getTangemClient();
    const readJson = async (uri) => JSON.parse((await client.readResource({ uri })).contents[0].text);
    const [networks, providers] = await Promise.all([readJson(NETWORKS_URI), readJson(PROVIDERS_URI)]);
    return {
      networks: new Map(networks.map((n) => [n.externalId, n])),
      providers: new Map(providers.map((p) => [p.id, p])),
    };
  })().catch((err) => {
    resourcesPromise = null;
    throw err;
  });
  return resourcesPromise;
}

// ---- Wallet ----

// Last wallets__get_tokens answer: the only trusted source of addresses and decimals.
let walletTokens = null;

async function loadWallet() {
  const [{ tokens }, { networks }] = await Promise.all([callTool("wallets__get_tokens"), getResources()]);
  const byKey = new Map();
  for (const t of tokens) {
    const network = networks.get(t.networkId);
    const networkId = network?.externalId ?? t.networkId;
    const contractAddress = t.contractAddress ?? NATIVE_CONTRACT;
    const key = `${networkId}:${contractAddress}`;
    if (byKey.has(key)) continue; // same asset in another account: the first account is used
    byKey.set(key, {
      key,
      symbol: t.symbol,
      name: t.name,
      networkId,
      decimals: t.decimals,
      contractAddress,
      address: t.addresses?.[0] ?? null,
      walletNetworkId: t.networkId,
      expressSupported: Boolean(network),
    });
  }
  walletTokens = [...byKey.values()];
  return walletTokens;
}

/** Human-readable balances by token key; tokens on networks the balance service rejects are left out. */
async function loadBalances(tokens) {
  const groups = new Map();
  for (const t of tokens) {
    if (!t.address) continue;
    const id = `${t.walletNetworkId}|${t.address}`;
    groups.set(id, [...(groups.get(id) ?? []), t]);
  }
  const balances = new Map();
  await Promise.all(
    [...groups.values()].map(async (group) => {
      const contracts = group
        .filter((t) => t.contractAddress !== NATIVE_CONTRACT)
        .map((t) => ({ contractAddress: t.contractAddress, decimals: t.decimals }));
      let result;
      try {
        result = await callTool("transactions__get_balances", {
          request: {
            networkId: group[0].walletNetworkId,
            walletAddress: group[0].address,
            ...(contracts.length && { tokens: contracts }),
          },
        });
      } catch (err) {
        if (isAuthError(err)) throw err;
        return; // network not supported by the balance service
      }
      if (result.status !== "OK") return;
      for (const t of group) {
        const native = t.contractAddress === NATIVE_CONTRACT;
        const match = (result.balances ?? []).find((b) =>
          native ? b.contractAddress == null : b.contractAddress?.toLowerCase() === t.contractAddress.toLowerCase(),
        );
        if (match?.rawAmount != null) balances.set(t.key, fromMinor(match.rawAmount, t.decimals));
      }
    }),
  );
  return balances;
}

async function resolveToken(key, label) {
  if (typeof key !== "string") throw new HttpError(400, `${label}: token key required (see /api/wallet)`);
  let token = walletTokens?.find((t) => t.key === key);
  token ??= (await loadWallet()).find((t) => t.key === key);
  if (!token) throw new HttpError(400, `${label}: token ${key} is not in the wallet`);
  if (!token.expressSupported) throw new HttpError(400, `${label}: ${token.networkId} is not supported by Express`);
  if (!token.address) throw new HttpError(400, `${label}: the Tangem app has not shared an address for ${token.symbol}`);
  return token;
}

const expressAsset = (token) => ({ network: token.networkId, contractAddress: token.contractAddress });

// ---- Amounts (string math only) ----

function toMinor(amount, decimals, label = "amount") {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(String(amount ?? "").trim());
  if (!match || (!match[1] && !match[2])) throw new HttpError(400, `${label} must be a decimal number such as 0.5`);
  const [, whole, frac = ""] = match;
  if (frac.length > decimals) throw new HttpError(400, `${label} has more than ${decimals} decimal places`);
  const minor = (whole + frac.padEnd(decimals, "0")).replace(/^0+/, "");
  if (!minor) throw new HttpError(400, `${label} must be greater than zero`);
  return minor;
}

function fromMinor(minor, decimals) {
  if (minor == null) return null;
  const digits = String(minor).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ---- Quotes ----

async function quoteRoute(from, to, amountMinor, provider, rateType, providers) {
  const providerName = providers.get(provider)?.name ?? provider;
  try {
    const q = await callQuoteTool("express__exchange_quote", {
      from: { ...expressAsset(from), decimals: from.decimals, amount: amountMinor },
      to: { ...expressAsset(to), decimals: to.decimals },
      provider,
      rateType,
    });
    return { provider, providerName, rateType, toAmountMinor: String(q.toAmount), toAmount: fromMinor(q.toAmount, to.decimals) };
  } catch (err) {
    if (isAuthError(err)) throw err;
    return { provider, providerName, rateType, error: err.message };
  }
}

function byReceivedDesc(a, b) {
  if (!a.error !== !b.error) return a.error ? 1 : -1;
  if (a.error) return 0;
  const diff = BigInt(b.toAmountMinor) - BigInt(a.toAmountMinor);
  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
}

/** Quotes every provider/rateType route; best is the highest amount received, or null if none quoted. */
async function bestQuote(from, to, amount) {
  const amountMinor = toMinor(amount, from.decimals);
  const { providers } = await getResources();
  const { pairs } = await callQuoteTool("express__pairs", { from: [expressAsset(from)], to: [expressAsset(to)] });

  const routes = new Map();
  for (const pair of pairs) {
    for (const { id, rateTypes } of pair.providers) {
      for (const rateType of rateTypes) routes.set(`${id}|${rateType}`, { provider: id, rateType });
    }
  }
  const quotes = await Promise.all(
    [...routes.values()].map(({ provider, rateType }) =>
      quoteRoute(from, to, amountMinor, provider, rateType, providers),
    ),
  );
  quotes.sort(byReceivedDesc);
  const best = quotes[0] && !quotes[0].error ? quotes[0] : null;
  return { amountMinor, best, quotes };
}

function publicQuote({ best, quotes }) {
  return {
    best: best && { provider: best.provider, providerName: best.providerName, toAmount: best.toAmount, rateType: best.rateType },
    quotes: quotes.map(({ provider, providerName, toAmount, error }) =>
      error ? { provider, providerName, error } : { provider, providerName, toAmount },
    ),
  };
}

function noQuoteMessage({ quotes }) {
  if (!quotes.length) return "No provider supports this pair";
  return `No provider could quote: ${quotes.map((q) => `${q.providerName}: ${q.error}`).join("; ")}`;
}

// ---- State (plans.json, history.json) ----

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

function writeJson(file, data) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

const savedPlans = readJson(PLANS_FILE, {});
const state = { pausedAll: Boolean(savedPlans.pausedAll), plans: savedPlans.plans ?? [] };
const history = readJson(HISTORY_FILE, { items: [] }).items ?? []; // newest first

function save() {
  writeJson(PLANS_FILE, state);
  writeJson(HISTORY_FILE, { items: history });
}

// A PENDING entry means the server stopped during intent creation: the intent may exist.
for (const entry of history) {
  if (entry.status !== "PENDING") continue;
  entry.status = "ERROR";
  const plan = state.plans.find((p) => p.id === entry.planId);
  if (plan?.status === "active") {
    plan.status = "error";
    plan.error = "Auto-Stack stopped while preparing a buy; it may exist. Check the Tangem app.";
  }
}
save();

const localDay = (ms) => new Date(ms).toLocaleDateString("en-CA"); // YYYY-MM-DD, server's time zone

/** Every history entry is one intent creation attempt, successful or not. */
function buysToday() {
  const today = localDay(Date.now());
  return history.filter((entry) => localDay(Date.parse(entry.time)) === today).length;
}

/** Next slot after now: scheduled runs keep the plan's cadence, manual runs restart it from now. */
function nextSlot(plan, manual = false) {
  const every = plan.everyMinutes * 60_000;
  const now = Date.now();
  let next = (manual ? now : Date.parse(plan.nextRunAt)) + every;
  if (next <= now) next += (Math.floor((now - next) / every) + 1) * every;
  return new Date(next).toISOString();
}

/** After a pause, an overdue recurring plan moves to its next slot instead of buying at once. */
function skipMissedSlot(plan) {
  if (plan.type === "recurring" && plan.status === "active" && Date.parse(plan.nextRunAt) <= Date.now()) {
    plan.nextRunAt = nextSlot(plan);
  }
}

// ---- Buys ----

// Serialises every plan run (scheduler, run-now, edits) so the daily cap and per-plan checks cannot race.
let planLock = Promise.resolve();

function withPlanLock(fn) {
  const run = planLock.then(fn);
  planLock = run.catch(() => {});
  return run;
}

/** Quotes the plan's current amount and records the best quote on the plan. */
async function quotePlan(plan) {
  const from = await resolveToken(plan.from, "from");
  const to = await resolveToken(plan.to, "to");
  const amount = plan.amount;
  const quote = await bestQuote(from, to, amount);
  plan.lastQuote = quote.best && {
    toAmount: quote.best.toAmount,
    providerName: quote.best.providerName,
    at: new Date().toISOString(),
  };
  return { from, to, amount, quote };
}

/**
 * Prepares one buy: exactly one express__exchange_intent_create call, never retried.
 * Call under withPlanLock with a quote that has a best route. Checks run after the quote's awaits,
 * so a pause, delete or cap reached meanwhile still stops the buy.
 */
async function prepareBuy(plan, { from, to, amount, quote }, { manual }) {
  if (!state.plans.includes(plan)) throw new HttpError(404, "plan not found");
  if (plan.status !== "active") throw new HttpError(409, `plan is ${plan.status}`);
  if (state.pausedAll) throw new HttpError(409, "All plans are paused. Resume all first.");
  if (!manual && plan.paused) throw new HttpError(409, "plan is paused");
  if (buysToday() >= DAILY_BUY_CAP) {
    throw new HttpError(429, `Daily limit of ${DAILY_BUY_CAP} prepared buys reached. Try again tomorrow.`);
  }

  const { best, amountMinor } = quote;
  // Recorded before the call, so a crash mid-call still counts toward the cap and stops the plan.
  const entry = {
    id: randomUUID(),
    time: new Date().toISOString(),
    planId: plan.id,
    from: plan.from,
    to: plan.to,
    amount,
    toAmount: best.toAmount,
    providerName: best.providerName,
    intentId: null,
    deeplink: null,
    status: "PENDING",
  };
  history.unshift(entry);
  save();

  try {
    const { intentId, deeplink } = await callTool("express__exchange_intent_create", {
      fromAsset: { ...expressAsset(from), decimals: from.decimals },
      toAsset: { ...expressAsset(to), decimals: to.decimals },
      fromAddress: from.address,
      payoutAddress: to.address,
      provider: best.provider,
      rateType: best.rateType,
      fromAmount: amountMinor,
      sendNotification: true,
    });
    Object.assign(entry, { status: "CREATED", intentId, deeplink });
    plan.error = null;
    if (plan.type === "recurring") plan.nextRunAt = nextSlot(plan, manual);
    else plan.status = "done";
    console.log(`Plan ${plan.id}: buy prepared, intent ${intentId}`);
    return entry;
  } catch (err) {
    // Only a non-retryable tool error is a definite failure; otherwise the intent may have been stored.
    const definite = err instanceof ToolError && !err.retryable;
    entry.status = definite ? "FAILED" : "ERROR";
    plan.status = "error";
    plan.error = definite
      ? `Preparing the buy failed: ${err.message}`
      : `Preparing the buy may have worked; check the Tangem app before anything else: ${err.message}`;
    console.error(`Plan ${plan.id} stopped. ${plan.error}`);
    throw err;
  } finally {
    save();
  }
}

/** One scheduler pass over one plan. Call under withPlanLock. */
async function tickPlan(plan) {
  if (!state.plans.includes(plan) || plan.status !== "active" || plan.paused || state.pausedAll) return;
  if (plan.type === "recurring") {
    if (Date.parse(plan.nextRunAt) > Date.now()) return;
    if (buysToday() >= DAILY_BUY_CAP) {
      plan.nextRunAt = nextSlot(plan);
      plan.error = `Skipped a buy: daily limit of ${DAILY_BUY_CAP} prepared buys reached`;
      console.log(`Plan ${plan.id}: ${plan.error}`);
      save();
      return;
    }
  }

  let quoted;
  try {
    quoted = await quotePlan(plan);
  } catch (err) {
    if (isAuthError(err)) throw err;
    plan.error = `Quote failed, retrying next minute: ${err.message}`; // a due recurring plan stays due
    save();
    return;
  }
  const { quote, to } = quoted;
  if (!quote.best) {
    plan.error = noQuoteMessage(quote);
    if (plan.type === "recurring") plan.status = "error";
    save();
    return;
  }
  plan.error = null;
  if (plan.type === "limit" && BigInt(quote.best.toAmountMinor) < BigInt(toMinor(plan.minReceive, to.decimals))) {
    save();
    return;
  }
  if (plan.type === "limit" && buysToday() >= DAILY_BUY_CAP) {
    save(); // target reached but the cap is used up: stays active and tries again later
    return;
  }
  await prepareBuy(plan, quoted, { manual: false });
}

// ---- Scheduler ----

let ticking = false;

async function tick() {
  if (ticking || state.pausedAll) return;
  ticking = true;
  try {
    for (const plan of [...state.plans]) {
      try {
        await withPlanLock(() => tickPlan(plan));
      } catch (err) {
        console.error(`Plan ${plan.id}:`, err.message);
        if (isAuthError(err)) break;
      }
    }
  } finally {
    ticking = false;
  }
}

// ---- Status of a prepared buy ----

/** Express transaction status → history status (the front end treats COMPLETED and FAIL/ERROR/EXPIRED/CANCEL specially). */
function historyStatus(expressStatus) {
  if (expressStatus === "finished") return "COMPLETED";
  if (["failed", "tx-failed", "refunded"].includes(expressStatus)) return "FAILED";
  return String(expressStatus).toUpperCase().replace(/-/g, "_");
}

// ---- App ----

const app = express();
app.use(express.json());
app.use(express.static("public"));

function findPlan(id) {
  const plan = state.plans.find((p) => p.id === id);
  if (!plan) throw new HttpError(404, "plan not found");
  return plan;
}

app.get("/api/wallet", async (req, res) => {
  const tokens = await loadWallet();
  const balances = await loadBalances(tokens);
  res.json({
    tokens: tokens.map(({ key, symbol, name, networkId, decimals, contractAddress, address }) => ({
      key,
      symbol,
      name,
      networkId,
      decimals,
      contractAddress,
      address,
      balance: balances.get(key) ?? null,
    })),
  });
});

app.post("/api/quote", async (req, res) => {
  const { from, to, amount } = req.body ?? {};
  if (from === to) throw new HttpError(400, "from and to must differ");
  const fromToken = await resolveToken(from, "from");
  const toToken = await resolveToken(to, "to");
  res.json(publicQuote(await bestQuote(fromToken, toToken, amount)));
});

app.get("/api/plans", (req, res) => {
  res.json({ plans: state.plans, pausedAll: state.pausedAll });
});

app.post("/api/plans", async (req, res) => {
  const { type, from, to, amount, everyMinutes, minReceive } = req.body ?? {};
  if (!PLAN_TYPES.includes(type)) throw new HttpError(400, `type must be one of ${PLAN_TYPES.join(", ")}`);
  if (from === to) throw new HttpError(400, "from and to must differ");
  const fromToken = await resolveToken(from, "from");
  const toToken = await resolveToken(to, "to");
  toMinor(amount, fromToken.decimals);

  const plan = {
    id: randomUUID(),
    type,
    from,
    to,
    amount: String(amount).trim(),
    everyMinutes: null,
    nextRunAt: null,
    minReceive: null,
    lastQuote: null,
    paused: false,
    status: "active",
    error: null,
    createdAt: new Date().toISOString(),
  };
  if (type === "recurring") {
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1) {
      throw new HttpError(400, "everyMinutes must be a whole number of minutes, at least 1");
    }
    plan.everyMinutes = everyMinutes;
    plan.nextRunAt = new Date(Date.now() + everyMinutes * 60_000).toISOString();
  } else {
    toMinor(minReceive, toToken.decimals, "minReceive");
    plan.minReceive = String(minReceive).trim();
  }
  state.plans.unshift(plan);
  save();
  res.status(201).json(plan);
});

// Under the plan lock, so an edit never lands in the middle of a buy: it applies from the next buy.
app.patch("/api/plans/:id", async (req, res) => {
  const plan = await withPlanLock(async () => {
    const plan = findPlan(req.params.id);
    if (plan.status === "done") throw new HttpError(409, "plan is done");
    const { amount } = req.body ?? {};
    toMinor(amount, (await resolveToken(plan.from, "from")).decimals);
    plan.amount = String(amount).trim();
    save();
    return plan;
  });
  res.json(plan);
});

app.post("/api/plans/:id/pause", (req, res) => {
  const plan = findPlan(req.params.id);
  plan.paused = !plan.paused;
  if (!plan.paused) skipMissedSlot(plan);
  save();
  res.json(plan);
});

app.post("/api/plans/:id/run-now", async (req, res) => {
  const entry = await withPlanLock(async () => {
    const plan = findPlan(req.params.id);
    if (plan.status !== "active") throw new HttpError(409, `plan is ${plan.status}`);
    if (state.pausedAll) throw new HttpError(409, "All plans are paused. Resume all first.");
    if (buysToday() >= DAILY_BUY_CAP) {
      throw new HttpError(429, `Daily limit of ${DAILY_BUY_CAP} prepared buys reached. Try again tomorrow.`);
    }
    const quoted = await quotePlan(plan);
    if (!quoted.quote.best) {
      save();
      throw new HttpError(502, noQuoteMessage(quoted.quote));
    }
    return prepareBuy(plan, quoted, { manual: true });
  });
  res.json(entry);
});

app.delete("/api/plans/:id", (req, res) => {
  findPlan(req.params.id);
  state.plans = state.plans.filter((p) => p.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.post("/api/pause-all", (req, res) => {
  const { paused } = req.body ?? {};
  if (typeof paused !== "boolean") throw new HttpError(400, "paused must be true or false");
  state.pausedAll = paused;
  if (!paused) state.plans.forEach(skipMissedSlot);
  save();
  res.json({ pausedAll: state.pausedAll });
});

app.get("/api/history", (req, res) => {
  res.json({ items: history });
});

// No status on the intent itself: the newest exchange sent from it decides. None sent yet: still CREATED.
app.get("/api/intent/:id", async (req, res) => {
  const { transactions } = await callTool("express__exchange_intent", { intentId: req.params.id });
  const status = transactions?.length ? historyStatus(transactions[0].status) : "CREATED";
  const entries = history.filter((e) => e.intentId === req.params.id && e.status !== status);
  if (entries.length) {
    for (const entry of entries) entry.status = status;
    save();
  }
  res.json({ status });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: `No route ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  if (isAuthError(err)) return res.status(401).json({ error: LOGIN_EXPIRED });
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500 && !(err instanceof ToolError)) console.error(err);
  res.status(status).json({ error: err.message });
});

function openBrowser(url) {
  if (process.env.BROWSER === "none") return;
  const [command, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

app.listen(PORT, () => {
  console.log(`Auto-Stack on ${APP_URL}`);
  console.log("Connecting to Tangem: scan the QR code with your Tangem app if asked.");
  // Connect now so the Tangem login (QR scan) happens at startup; open the app once it is done.
  getTangemClient().then(
    () => console.log("Tangem MCP connected"),
    (err) => console.error("Tangem MCP connect failed (will retry on next request):", err.message),
  ).finally(() => openBrowser(APP_URL));
});
setInterval(tick, TICK_MS);

process.on("SIGINT", async () => {
  await closeTangemClient();
  process.exit(0);
});
