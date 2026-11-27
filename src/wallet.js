// Everything that talks to the Tangem MCP server: wallet, balances, best price, buy requests, status.
import { getTangemClient } from "./tangem.js";

const QUOTE_RETRY_DELAYS_MS = [1000, 2000]; // backoff before each retry of a retryable read-only error
export const NATIVE_CONTRACT = "0"; // Express id for a network's native coin
const NETWORKS_URI = "express+tangem-express://networks";
const PROVIDERS_URI = "express+tangem-express://providers";
// mcp-remote and the SDK only surface auth failures as error text.
const AUTH_ERROR = /\b401\b|unauthori[sz]ed|invalid_token|invalid_grant|token (?:has )?expired|login expired/i;
// Errors for an amount under the minimum.
const BELOW_MINIMUM = /\bmin(?:imum|imal)?\b|too (?:small|low)|less than/i;
const PAIRS_BATCH = 50; // express__pairs accepts at most 50 assets per side and 100 combinations

/** A problem the user can fix or should know about; its message is shown as is. */
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

/** Stable id of an asset: network + contract ("0" for the native coin). EVM contracts are case-insensitive. */
export function assetKey(network, contractAddress) {
  const contract = String(contractAddress ?? NATIVE_CONTRACT);
  return `${network}:${contract.startsWith("0x") ? contract.toLowerCase() : contract}`;
}

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

/** For read-only calls only: retries when Tangem marks the error retryable, with backoff. */
async function callReadTool(name, args) {
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

export function getResources() {
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

export async function networkName(network) {
  const { networks } = await getResources();
  return networks.get(network)?.name ?? network;
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
    const key = assetKey(networkId, contractAddress);
    if (byKey.has(key)) continue; // same asset in another account: the first account is used
    byKey.set(key, {
      key,
      symbol: t.symbol,
      name: t.name,
      network: networkId,
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

export const getWallet = async () => walletTokens ?? loadWallet();

/** The wallet's address on a network (any token on it), or null. */
export async function addressOn(network) {
  const tokens = await getWallet();
  return tokens.find((t) => t.network === network && t.address)?.address ?? null;
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

// ---- Amounts (string math only) ----

export function toMinor(amount, decimals, label = "Amount") {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(String(amount ?? "").trim());
  if (!match || (!match[1] && !match[2])) throw new UserError(`${label} must be a number such as 10 or 0.5`);
  const [, whole, frac = ""] = match;
  if (frac.length > decimals) throw new UserError(`${label} has more than ${decimals} decimal places`);
  const minor = (whole + frac.padEnd(decimals, "0")).replace(/^0+/, "");
  if (!minor) throw new UserError(`${label} must be more than 0`);
  return minor;
}

export function fromMinor(minor, decimals) {
  if (minor == null) return null;
  const digits = String(minor).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ---- Best price ----

const expressAsset = (asset) => ({ network: asset.network, contractAddress: asset.contractAddress });

/** Which (from, to) asset pairs Tangem can swap, as a Set of "fromKey>toKey". Batched within the tool's limits. */
export async function swappablePairs(fromAssets, toAssets) {
  const result = new Set();
  const fromBatch = Math.max(1, Math.min(PAIRS_BATCH, Math.floor(100 / Math.max(1, Math.min(toAssets.length, PAIRS_BATCH)))));
  for (let i = 0; i < fromAssets.length; i += fromBatch) {
    for (let j = 0; j < toAssets.length; j += Math.min(PAIRS_BATCH, Math.floor(100 / Math.min(fromBatch, fromAssets.length - i)))) {
      const from = fromAssets.slice(i, i + fromBatch).map(expressAsset);
      const to = toAssets.slice(j, j + Math.min(PAIRS_BATCH, Math.floor(100 / from.length))).map(expressAsset);
      const { pairs } = await callReadTool("express__pairs", { from, to });
      for (const pair of pairs) {
        if (pair.providers?.length) {
          result.add(`${assetKey(pair.from.network, pair.from.contractAddress)}>${assetKey(pair.to.network, pair.to.contractAddress)}`);
        }
      }
    }
  }
  return result;
}

async function quoteRoute(from, to, amountMinor, provider, rateType) {
  try {
    const q = await callReadTool("express__exchange_quote", {
      from: { ...expressAsset(from), decimals: from.decimals, amount: amountMinor },
      to: { ...expressAsset(to), decimals: to.decimals },
      provider,
      rateType,
    });
    return { provider, rateType, toAmountMinor: String(q.toAmount), toAmount: fromMinor(q.toAmount, to.decimals) };
  } catch (err) {
    if (isAuthError(err)) throw err;
    return { provider, rateType, error: err.message };
  }
}

function byReceivedDesc(a, b) {
  if (!a.error !== !b.error) return a.error ? 1 : -1;
  if (a.error) return 0;
  const diff = BigInt(b.toAmountMinor) - BigInt(a.toAmountMinor);
  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
}

/**
 * Tangem's best price for `amount` of `from` into `to` (assets with network, contractAddress, decimals):
 * every route is priced and the one giving the most wins. Throws a UserError in plain words if none can.
 */
export async function bestPrice(from, to, amount) {
  const amountMinor = toMinor(amount, from.decimals);
  const { pairs } = await callReadTool("express__pairs", { from: [expressAsset(from)], to: [expressAsset(to)] });
  const routes = new Map();
  for (const pair of pairs) {
    for (const { id, rateTypes } of pair.providers) {
      for (const rateType of rateTypes) routes.set(`${id}|${rateType}`, { provider: id, rateType });
    }
  }
  const prices = await Promise.all(
    [...routes.values()].map(({ provider, rateType }) => quoteRoute(from, to, amountMinor, provider, rateType)),
  );
  prices.sort(byReceivedDesc);
  const best = prices[0] && !prices[0].error ? prices[0] : null;
  if (best) return { amountMinor, best };
  if (prices.length) console.error(`No price for ${from.key ?? from.network} → ${to.key ?? to.network}:`, prices.map((p) => `${p.provider}: ${p.error}`).join("; "));
  if (!prices.length) throw new UserError(`Tangem can't swap ${from.symbol} on ${from.networkName ?? from.network} to ${to.symbol} right now.`);
  if (prices.every((p) => BELOW_MINIMUM.test(p.error))) {
    throw new UserError(`${amount} ${from.symbol} is below the minimum Tangem can swap to ${to.symbol}. Try a bigger amount.`);
  }
  throw new UserError(`Tangem can't buy ${to.symbol} with ${amount} ${from.symbol} right now. Try again later.`);
}

// ---- Buy requests ----

/**
 * THE ONLY place that creates a buy request in Tangem (express__exchange_intent_create), exactly once per call,
 * never retried. Callers enforce pause, daily cap and one-per-period rules before calling.
 */
export async function createBuyRequest({ from, to, fromAddress, payoutAddress, amountMinor, best }) {
  const { intentId, deeplink } = await callTool("express__exchange_intent_create", {
    fromAsset: { ...expressAsset(from), decimals: from.decimals },
    toAsset: { ...expressAsset(to), decimals: to.decimals },
    fromAddress,
    payoutAddress,
    provider: best.provider,
    rateType: best.rateType,
    fromAmount: amountMinor,
    sendNotification: true,
  });
  return { requestId: intentId, link: deeplink };
}

/** Express transaction status → our status. Anything not final means the buy is on its way. */
function mapStatus(expressStatus) {
  const s = String(expressStatus).toLowerCase();
  if (s === "finished") return "COMPLETED";
  if (["failed", "tx-failed", "refunded", "error"].includes(s)) return "FAILED";
  if (s === "expired") return "EXPIRED";
  if (s.includes("cancel")) return "FAILED";
  return "WAITING";
}

/** Reads an amount that may be given in minor units (digits only) or as a decimal string. */
function readAmount(value, decimals) {
  if (value == null) return null;
  const s = String(value);
  if (/^\d+$/.test(s)) return fromMinor(s, decimals);
  return /^\d*\.\d+$/.test(s) ? s : null;
}

/**
 * Status of a buy request: no exchange sent yet → WAITING (not approved). Otherwise the newest exchange decides.
 * `received` is the actual amount when Tangem reports one.
 */
export async function buyStatus(requestId) {
  const { intent, transactions } = await callTool("express__exchange_intent", { intentId: requestId });
  if (!transactions?.length) return { status: "WAITING", approved: false, received: null };
  const tx = transactions[0];
  const status = mapStatus(tx.status);
  const decimals = intent?.toDecimals ?? tx.toDecimals;
  const received =
    status === "COMPLETED" && decimals != null
      ? readAmount(tx.toActualAmount ?? tx.payoutAmount ?? tx.toAmount, decimals)
      : null;
  return { status, approved: true, received };
}
