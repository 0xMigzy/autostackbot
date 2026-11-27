// Plans, history, scheduler and buys. The Telegram bot calls this module directly.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getTangemClient } from "./tangem.js";

const PLANS_FILE = "plans.json";
const HISTORY_FILE = "history.json";
const TICK_MS = 60_000;
export const DAILY_BUY_CAP = 3; // buy attempts per local calendar day, all plans together
const QUOTE_RETRY_DELAYS_MS = [1000, 2000]; // backoff before each retry of a retryable quote error
const NATIVE_CONTRACT = "0"; // Express id for a network's native coin
const NETWORKS_URI = "express+tangem-express://networks";
const PROVIDERS_URI = "express+tangem-express://providers";
const PLAN_TYPES = ["recurring", "limit"];
export const LOGIN_EXPIRED = "Tangem login expired. Restart AutoStackBot and scan the QR.";
// mcp-remote and the SDK only surface auth failures as error text.
const AUTH_ERROR = /\b401\b|unauthori[sz]ed|invalid_token|invalid_grant|token (?:has )?expired|login expired/i;
// Provider errors for an amount under their minimum.
const BELOW_MINIMUM = /\bmin(?:imum|imal)?\b|too (?:small|low)|less than/i;

/** A problem with the user's input or the plan's state; its message is shown as is. */
export class UserError extends Error {}

/** A tool result with isError; code and retryable come from the "[code=2540 retryable=true]" suffix. */
export class ToolError extends Error {
  constructor(message, code, retryable) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export const isAuthError = (err) => AUTH_ERROR.test(String(err?.message ?? ""));
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

// ---- Notifications (set by init) ----

let notifier = {};

function notify(event, ...args) {
  try {
    Promise.resolve(notifier[event]?.(...args)).catch((err) => console.error(`Notify ${event}:`, err.message));
  } catch (err) {
    console.error(`Notify ${event}:`, err.message);
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

export async function loadWallet() {
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
      networkName: network?.name ?? networkId,
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
export async function loadBalances(tokens) {
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

/** Wallet tokens with this symbol (any case); `usable` are the ones Express can swap. Reloads once if none match. */
export async function findTokens(symbol) {
  const want = symbol.toLowerCase();
  const matching = (tokens) => tokens.filter((t) => t.symbol.toLowerCase() === want);
  let all = matching(walletTokens ?? (await loadWallet()));
  if (!all.length) all = matching(await loadWallet());
  return { all, usable: all.filter((t) => t.expressSupported && t.address) };
}

/** The cached wallet token for a key, for display; null if unknown. */
export function cachedToken(key) {
  return walletTokens?.find((t) => t.key === key) ?? null;
}

async function resolveToken(key, label) {
  if (typeof key !== "string") throw new UserError(`${label}: token required`);
  let token = walletTokens?.find((t) => t.key === key);
  token ??= (await loadWallet()).find((t) => t.key === key);
  if (!token) throw new UserError(`${label}: token ${key} is not in your Tangem wallet`);
  if (!token.expressSupported) throw new UserError(`${label}: ${token.networkId} is not supported by Tangem Express`);
  if (!token.address) throw new UserError(`${label}: the Tangem app has not shared an address for ${token.symbol}`);
  return token;
}

const expressAsset = (token) => ({ network: token.networkId, contractAddress: token.contractAddress });

// ---- Amounts (string math only) ----

function toMinor(amount, decimals, label = "Amount") {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(String(amount ?? "").trim());
  if (!match || (!match[1] && !match[2])) throw new UserError(`${label} must be a decimal number such as 0.5`);
  const [, whole, frac = ""] = match;
  if (frac.length > decimals) throw new UserError(`${label} has more than ${decimals} decimal places`);
  const minor = (whole + frac.padEnd(decimals, "0")).replace(/^0+/, "");
  if (!minor) throw new UserError(`${label} must be greater than zero`);
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

export function noQuoteMessage({ quotes }, amount, symbol) {
  if (!quotes.length) return "No Tangem Express provider supports this pair";
  const details = quotes.map((q) => `${q.providerName}: ${q.error}`).join("; ");
  if (quotes.every((q) => BELOW_MINIMUM.test(q.error))) {
    return `${amount} ${symbol} is below the providers' minimum. Try a bigger amount. (${details})`;
  }
  return `No provider could quote: ${details}`;
}

/** Best quote for an amount of `fromKey` into `toKey`, plus how many providers were asked and quoted. */
export async function quote(fromKey, toKey, amount) {
  if (fromKey === toKey) throw new UserError("Pick two different tokens");
  const from = await resolveToken(fromKey, "From");
  const to = await resolveToken(toKey, "To");
  const { best, quotes } = await bestQuote(from, to, amount);
  return {
    from,
    to,
    amount: String(amount).trim(),
    best: best && { providerName: best.providerName, toAmount: best.toAmount, rateType: best.rateType },
    providersAsked: new Set(quotes.map((q) => q.provider)).size,
    providersQuoted: new Set(quotes.filter((q) => !q.error).map((q) => q.provider)).size,
    error: best ? null : noQuoteMessage({ quotes }, amount, from.symbol),
  };
}

// ---- State (plans.json, history.json) ----

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

function writeJson(file, data) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

const state = { pausedAll: false, plans: [] };
const history = []; // newest first

function save() {
  writeJson(PLANS_FILE, state);
  writeJson(HISTORY_FILE, { items: history });
}

/** Stops a plan with an error and tells the owner. */
function failPlan(plan, message) {
  plan.status = "error";
  plan.error = message;
  save();
  notify("planError", plan);
}

/**
 * Loads plans and history and sets the notifier: { buyPrepared(entry, plan), planError(plan), loginExpired() }.
 * Call once, before anything else in this module.
 */
export function init(events) {
  notifier = events;
  const savedPlans = readJson(PLANS_FILE, {});
  state.pausedAll = Boolean(savedPlans.pausedAll);
  state.plans = savedPlans.plans ?? [];
  history.push(...(readJson(HISTORY_FILE, { items: [] }).items ?? []));

  // A PENDING entry means the bot stopped during intent creation: the intent may exist.
  const stopped = [];
  for (const entry of history) {
    if (entry.status !== "PENDING") continue;
    entry.status = "ERROR";
    const plan = state.plans.find((p) => p.id === entry.planId);
    if (plan?.status === "active") stopped.push(plan);
  }
  save();
  for (const plan of stopped) {
    failPlan(plan, "AutoStackBot stopped while preparing a buy; it may exist. Check the Tangem app.");
  }
}

const localDay = (ms) => new Date(ms).toLocaleDateString("en-CA"); // YYYY-MM-DD, this computer's time zone

/** Every history entry is one intent creation attempt, successful or not. */
export function buysToday() {
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
  const from = await resolveToken(plan.from, "From");
  const to = await resolveToken(plan.to, "To");
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
  if (!state.plans.includes(plan)) throw new UserError("Plan not found");
  if (plan.status !== "active") throw new UserError(`Plan is ${plan.status}`);
  if (state.pausedAll) throw new UserError("All plans are paused. /resumeall first.");
  if (plan.paused) throw new UserError("Plan is paused. Resume it first.");
  if (buysToday() >= DAILY_BUY_CAP) {
    throw new UserError(`Daily limit of ${DAILY_BUY_CAP} prepared buys reached. Try again tomorrow.`);
  }

  const { best, amountMinor } = quote;
  // Recorded before the call, so a crash mid-call still counts toward the cap and stops the plan.
  const entry = {
    id: randomUUID(),
    time: new Date().toISOString(),
    planId: plan.id,
    from: plan.from,
    to: plan.to,
    fromSymbol: from.symbol,
    toSymbol: to.symbol,
    amount,
    toAmount: best.toAmount,
    providerName: best.providerName,
    intentId: null,
    deeplink: null,
    status: "PENDING",
  };
  history.unshift(entry);
  save();

  let failure = null;
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
    save();
    notify("buyPrepared", entry, plan);
    return entry;
  } catch (err) {
    // Only a non-retryable tool error is a definite failure; otherwise the intent may have been stored.
    const definite = err instanceof ToolError && !err.retryable;
    entry.status = definite ? "FAILED" : "ERROR";
    failure = definite
      ? `Preparing the buy failed: ${err.message}`
      : `Preparing the buy may have worked; check the Tangem app before anything else: ${err.message}`;
    console.error(`Plan ${plan.id} stopped. ${failure}`);
    throw err;
  } finally {
    if (failure) failPlan(plan, failure);
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
  const { quote, from, to } = quoted;
  if (!quote.best) {
    const message = noQuoteMessage(quote, plan.amount, from.symbol);
    if (plan.type === "recurring") return failPlan(plan, message);
    plan.error = message;
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
let timer = null;

async function tick() {
  if (ticking || state.pausedAll) return;
  ticking = true;
  try {
    for (const plan of [...state.plans]) {
      try {
        await withPlanLock(() => tickPlan(plan));
      } catch (err) {
        console.error(`Plan ${plan.id}:`, err.message);
        if (isAuthError(err)) {
          notify("loginExpired");
          break;
        }
      }
    }
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  timer ??= setInterval(tick, TICK_MS);
}

export function stopScheduler() {
  clearInterval(timer);
  timer = null;
}

// ---- Plans ----

function findPlan(id) {
  const plan = state.plans.find((p) => p.id === id);
  if (!plan) throw new UserError("Plan not found (deleted?)");
  return plan;
}

export const getPlan = (id) => state.plans.find((p) => p.id === id) ?? null;
export const listPlans = () => state.plans;
export const isPausedAll = () => state.pausedAll;
export const listHistory = (limit) => history.slice(0, limit);

/** { type: "recurring", from, to, amount, everyMinutes } or { type: "limit", from, to, amount, minReceive }; from/to are token keys. */
export async function createPlan({ type, from, to, amount, everyMinutes, minReceive }) {
  if (!PLAN_TYPES.includes(type)) throw new UserError(`type must be one of ${PLAN_TYPES.join(", ")}`);
  if (from === to) throw new UserError("Pick two different tokens");
  const fromToken = await resolveToken(from, "From");
  const toToken = await resolveToken(to, "To");
  toMinor(amount, fromToken.decimals);

  const plan = {
    id: randomUUID(),
    type,
    from,
    to,
    fromSymbol: fromToken.symbol,
    toSymbol: toToken.symbol,
    fromNetwork: fromToken.networkName,
    toNetwork: toToken.networkName,
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
      throw new UserError("The interval must be at least 1 minute");
    }
    plan.everyMinutes = everyMinutes;
    plan.nextRunAt = new Date(Date.now() + everyMinutes * 60_000).toISOString();
  } else {
    toMinor(minReceive, toToken.decimals, "Minimum to receive");
    plan.minReceive = String(minReceive).trim();
  }
  state.plans.unshift(plan);
  save();
  return plan;
}

// Under the plan lock, so an edit never lands in the middle of a buy: it applies from the next buy.
export function editPlanAmount(id, amount) {
  return withPlanLock(async () => {
    const plan = findPlan(id);
    if (plan.status === "done") throw new UserError("Plan is done");
    toMinor(amount, (await resolveToken(plan.from, "From")).decimals);
    plan.amount = String(amount).trim();
    save();
    return plan;
  });
}

export function togglePause(id) {
  const plan = findPlan(id);
  plan.paused = !plan.paused;
  if (!plan.paused) skipMissedSlot(plan);
  save();
  return plan;
}

export function runNow(id) {
  return withPlanLock(async () => {
    const plan = findPlan(id);
    if (plan.status !== "active") throw new UserError(`Plan is ${plan.status}`);
    if (state.pausedAll) throw new UserError("All plans are paused. /resumeall first.");
    if (plan.paused) throw new UserError("Plan is paused. Resume it first.");
    if (buysToday() >= DAILY_BUY_CAP) {
      throw new UserError(`Daily limit of ${DAILY_BUY_CAP} prepared buys reached. Try again tomorrow.`);
    }
    const quoted = await quotePlan(plan);
    if (!quoted.quote.best) {
      save();
      throw new UserError(noQuoteMessage(quoted.quote, plan.amount, quoted.from.symbol));
    }
    return prepareBuy(plan, quoted, { manual: true });
  });
}

export function deletePlan(id) {
  const plan = findPlan(id);
  state.plans = state.plans.filter((p) => p.id !== id);
  save();
  return plan;
}

export function setPausedAll(paused) {
  state.pausedAll = paused;
  if (!paused) state.plans.forEach(skipMissedSlot);
  save();
}

// ---- Status of a prepared buy ----

/** Express transaction status → history status. */
function historyStatus(expressStatus) {
  if (expressStatus === "finished") return "COMPLETED";
  if (["failed", "tx-failed", "refunded"].includes(expressStatus)) return "FAILED";
  return String(expressStatus).toUpperCase().replace(/-/g, "_");
}

/** COMPLETED, or a status after which the buy cannot complete. */
export const isFinalStatus = (status) => status === "COMPLETED" || /FAIL|ERROR|EXPIRED|CANCEL|REFUND/.test(status);

// No status on the intent itself: the newest exchange sent from it decides. None sent yet: still CREATED.
export async function intentStatus(intentId) {
  const { transactions } = await callTool("express__exchange_intent", { intentId });
  const status = transactions?.length ? historyStatus(transactions[0].status) : "CREATED";
  const entries = history.filter((e) => e.intentId === intentId && e.status !== status);
  if (entries.length) {
    for (const entry of entries) entry.status = status;
    save();
  }
  return status;
}
