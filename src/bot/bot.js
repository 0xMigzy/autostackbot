// AutoStack's Telegram interface: screens, the plan setup form, buy messages and alerts. Owner only.
import { Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
import { DateTime } from "luxon";
import * as E from "../engine.js";
import * as W from "../wallet.js";
import * as C from "../coins.js";
import { history, save, state } from "../store.js";
import { WEEKDAYS, WEEKDAY_NAMES, forecast, parseDate, parseTime } from "../schedule.js";
import { coinSummary } from "../stats.js";
import { renderCard } from "../share.js";
import { ensureLogo } from "../logos.js";
import { redact } from "../redact.js";
import * as F from "./format.js";

const LOGIN_EXPIRED = "Tangem login expired. Restart AutoStack and scan the QR.";
const MARKETS_TTL_MS = 10 * 60_000;
const HISTORY_PAGE = 10;
const AMOUNT_RE = /^\d+(?:\.\d+)?$/;

export const COMMANDS = [
  { command: "start", description: "Welcome and main menu" },
  { command: "portfolio", description: "Your wallet in dollars" },
  { command: "markets", description: "Coins you can buy, with prices" },
  { command: "dca", description: "Set up a new DCA plan" },
  { command: "plans", description: "Your plans" },
  { command: "history", description: "Your buys" },
  { command: "pause", description: "Pause or resume everything" },
  { command: "settings", description: "Reminders, alerts, share cards" },
  { command: "help", description: "How AutoStack works" },
];

const WELCOME = "👋 Welcome to AutoStack\nAuto-buy crypto every week from your Tangem wallet.\nTap your card, stack your coins.";
const DCA_TEXT = [
  "DCA (dollar-cost averaging) means buying a fixed amount on a schedule, for example 10 USDC every week, whatever the price.",
  "Some weeks you buy high, some weeks low, so over time you pay about the average price and don't have to guess the best moment.",
  "",
  "This isn't financial advice.",
].join("\n");
export const DISCLAIMER =
  "Run at your own risk. Not financial advice. Start with small amounts. AutoStack never signs: you approve every buy in Tangem. Not affiliated with Tangem.";
const HELP = [
  "AutoStack buys crypto for you on a schedule, from your Tangem wallet.",
  "",
  "/portfolio: your wallet in dollars",
  "/markets: coins you can buy, with prices",
  "/dca: set up a new DCA plan",
  "/plans: see, pause or change your plans",
  "/history: your buys, with a summary per coin",
  "/pause: pause or resume everything",
  "/settings: reminders, alerts and share cards",
  "",
  DISCLAIMER,
  "",
  "<i>Prices from CoinGecko</i>",
].join("\n");
const STRANGER_REPLY =
  "AutoStack is a private bot. Try the demo here: https://t.me/AutoStackTangemBot/demo\nor run your own: github.com/0xMigzy/autostackbot";

const html = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };
const isNotModified = (err) => err instanceof GrammyError && /not modified/i.test(err.description);
const isUrlRejected = (err) => err instanceof GrammyError && /url|button/i.test(err.description);

function errorText(err) {
  if (W.isAuthError(err)) return LOGIN_EXPIRED;
  if (err instanceof W.UserError) return err.message;
  console.error(err);
  return `Something went wrong: ${redact(err?.message ?? err)}`;
}

export function createBot({ token, ownerId, coingecko: cg }) {
  const bot = new Bot(token);
  const tz = () => E.zone();

  let input = null; // what the next plain text message is for: { kind, ... }
  let form = null; // the plan setup / edit form bound to one message
  let search = null; // { results, msgId }
  let linkButtonsOk = true; // Telegram may refuse tangem:// in buttons; then the link stays text-only
  let marketsCache = null; // { at, keys: Set } coins buyable from my USDC
  let loginExpiredSent = false;
  const busy = new Set(); // double-tap guard for buttons that prepare a buy

  // ---- Sending and editing ----

  async function notify(text, extra = {}) {
    try {
      return await bot.api.sendMessage(ownerId, text, { ...html, ...extra });
    } catch (err) {
      if (err instanceof GrammyError && /chat not found|blocked/i.test(err.description)) {
        const username = bot.isInited() ? bot.botInfo.username : "your bot";
        console.error(`Can't message you on Telegram: open https://t.me/${username} and press Start.`);
      } else {
        console.error("Telegram send failed:", err.message);
      }
      return null;
    }
  }

  async function edit(messageId, text, keyboard) {
    try {
      await bot.api.editMessageText(ownerId, messageId, text, { ...html, reply_markup: keyboard ?? new InlineKeyboard() });
      return true;
    } catch (err) {
      if (isNotModified(err)) return true;
      console.error("Edit failed:", err.message);
      return false;
    }
  }

  /** Every screen except the start menu ends with a button back to it (unless it already has one). */
  function withMenu(keyboard = new InlineKeyboard()) {
    const rows = keyboard.inline_keyboard.filter((row) => row.length);
    if (rows.flat().some((b) => b.callback_data === "nav:start")) return keyboard;
    return InlineKeyboard.from([...rows, [InlineKeyboard.text("‹ Start menu", "nav:start")]]);
  }

  /** Shows a screen: edits the message a button was pressed on, otherwise sends a new one. */
  async function show(ctx, { text, keyboard: base, home = false }) {
    const keyboard = home ? base : withMenu(base);
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, { ...html, reply_markup: keyboard });
        return ctx.callbackQuery.message;
      } catch (err) {
        if (isNotModified(err)) return ctx.callbackQuery.message;
        if (!(err instanceof GrammyError)) throw err;
      }
    }
    return ctx.reply(text, { ...html, reply_markup: keyboard });
  }

  /** Message with a Tangem link as text; also as a button when Telegram accepts it. */
  async function sendWithLink(text, link, keyboard = new InlineKeyboard()) {
    const withButton = () =>
      InlineKeyboard.from([[InlineKeyboard.url("Open Tangem", link)], ...keyboard.inline_keyboard.filter((row) => row.length)]);
    if (link && linkButtonsOk) {
      try {
        return await bot.api.sendMessage(ownerId, text, { ...html, reply_markup: withButton() });
      } catch (err) {
        if (!isUrlRejected(err)) throw err;
        linkButtonsOk = false;
      }
    }
    return bot.api.sendMessage(ownerId, text, { ...html, reply_markup: keyboard });
  }

  const approveBlock = (entry) => `Open Tangem and tap your card to approve:\n${F.esc(entry.link)}`;

  // ---- Prices ----

  const priceIdOf = (token) => (C.isUsdc(token) ? C.USDC_COINGECKO_ID : C.coinByKey(token.key)?.coingeckoId ?? null);

  function pricesFooter({ fresh, updatedAt }, extra = "") {
    const stale = !fresh && updatedAt ? ` · updated ${F.ago(updatedAt)}` : "";
    return `<i>Prices from CoinGecko${extra}${stale}</i>`;
  }

  async function getPrices(ids) {
    try {
      return await cg.getPrices(ids.filter(Boolean));
    } catch (err) {
      console.error("Prices:", err.message);
      return { prices: {}, updatedAt: null, fresh: false };
    }
  }

  // ---- Screens ----

  const mainMenu = () =>
    new InlineKeyboard()
      .text("Portfolio", "nav:portfolio").text("Markets", "nav:markets").row()
      .text("My plans", "nav:plans").text("History", "h:all:0").row()
      .text("Settings", "nav:settings").text("What's DCA?", "nav:dca");

  const welcomeScreen = () => ({ text: WELCOME, keyboard: mainMenu(), home: true });
  const dcaScreen = () => ({ text: DCA_TEXT, keyboard: new InlineKeyboard() });

  /** Only tokens with a balance above zero, largest $ value first. Tokens Tangem can't read a balance for are left out. */
  async function portfolioScreen() {
    const tokens = await W.loadWallet();
    const balances = await W.loadBalances(tokens);
    const held = tokens.filter((t) => Number(balances.get(t.key) ?? 0) > 0);
    if (!held.length) {
      return { text: "Your wallet is empty. Top up in Tangem, then come back.", keyboard: new InlineKeyboard().text("Markets", "nav:markets") };
    }
    const priced = await getPrices([...new Set(held.map(priceIdOf))]);
    const rows = held.map((t) => {
      const balance = balances.get(t.key);
      const price = priced.prices[priceIdOf(t)]?.usd;
      const value = price != null ? Number(balance) * price : null;
      const worth = value != null ? `   (${F.usd(value)})` : "";
      return { line: `${F.esc(t.symbol)} · ${F.esc(t.networkName)}   ${F.amount(balance)}${worth}`, value };
    });
    rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
    const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
    return {
      text: [`💼 <b>Your portfolio: ${F.usd(total)}</b>`, "", ...rows.map((r) => r.line)].join("\n"),
      keyboard: new InlineKeyboard().text("Markets", "nav:markets").text("My plans", "nav:plans"),
    };
  }

  /**
   * Keys of coins Tangem can swap from my USDC. Cached 10 min only when every coin is buyable, so a coin
   * left out by a momentary Tangem answer is checked again next time instead of staying hidden.
   */
  async function buyableKeys() {
    if (marketsCache && Date.now() - marketsCache.at < MARKETS_TTL_MS) return marketsCache.keys;
    const wallet = await W.loadWallet();
    const usdc = wallet.filter((t) => C.isUsdc(t) && t.address);
    const coins = C.usableCoins().filter((c) => !C.isUsdc(c));
    const pairs = usdc.length && coins.length ? await W.swappablePairs(usdc, coins) : new Set();
    const keys = new Set();
    for (const coin of coins) {
      const address = await W.addressOn(coin.network);
      const swappable = usdc.some((u) => pairs.has(`${u.key}>${coin.key}`));
      if (address && swappable) keys.add(coin.key);
      else console.log(`Markets: ${coin.symbol} not buyable now (${address ? "Tangem can't swap to it from your USDC" : `no ${coin.network} address in the wallet`})`);
    }
    marketsCache = keys.size === coins.length ? { at: Date.now(), keys } : null;
    return keys;
  }

  /** Coins buyable with my USDC, with prices. As /dca it's the coin picker for a new plan. */
  async function marketsScreen({ forPlan = false } = {}) {
    const keys = await buyableKeys();
    const coins = C.usableCoins().filter((c) => keys.has(c.key));
    const unavailable = C.usableCoins().filter((c) => !C.isUsdc(c) && !keys.has(c.key));
    const priced = await getPrices(coins.map((c) => c.coingeckoId));
    const lines = coins.map((c) => {
      const p = priced.prices[c.coingeckoId];
      return `<b>${F.esc(c.symbol)}</b> ${p ? `${F.usd(p.usd)} ${F.change(p.change24h)}` : "—"}`;
    });
    const keyboard = new InlineKeyboard();
    coins.forEach((c, i) => {
      keyboard.text(c.symbol, `m:${C.shortId(c.key)}`);
      if (i % 3 === 2) keyboard.row();
    });
    keyboard.row().text("Search", "m:search");
    if (forPlan) keyboard.text("What's DCA?", "nav:dca");
    return {
      text: [
        forPlan ? "<b>New DCA plan</b>" : "<b>Markets</b>",
        forPlan ? "Pick the coin you want to buy on a schedule." : "Tap a coin to set up a plan.",
        "",
        ...(lines.length ? lines : ["No coins can be bought with your USDC right now."]),
        ...(unavailable.length ? ["", `<i>Not available right now: ${F.esc(unavailable.map((c) => c.symbol).join(", "))}</i>`] : []),
        "",
        pricesFooter(priced, " · buys use Tangem's best price"),
      ].join("\n"),
      keyboard,
    };
  }

  function planTitle(plan) {
    return `<b>${F.esc(plan.coin.symbol)}</b> · ${F.amount(plan.amount)} ${F.esc(plan.pay.symbol)} ${F.describeSchedule(plan.schedule)}`;
  }

  function goalLine(plan, withForecast = false) {
    if (plan.stop?.type !== "goal") return null;
    const progress = E.progressOf(plan);
    const have = plan.stop.unit === "usd" ? progress.spent : progress.received;
    const pct = Math.min(100, (have / Number(plan.stop.target)) * 100);
    let line = `${F.bar(pct)} ${Math.floor(pct)}% of ${F.esc(F.goalLabel(plan.stop, plan.coin.symbol))}`;
    if (withForecast) {
      const f = E.forecastOf(plan);
      if (f?.date) line += ` · on track for ${F.shortDate(f.date, tz())}`;
    }
    return line;
  }

  function planLines(plan, detailed = false) {
    const lines = [planTitle(plan)];
    const goal = goalLine(plan, detailed);
    if (goal) lines.push(goal);
    const streak = E.streakOf(plan);
    if (streak.current || streak.best) lines.push(F.streakText(plan.schedule.freq, streak.current, streak.best));
    if (plan.status === "active") {
      if (E.waitingFor(plan)) lines.push("A buy is waiting for your approval");
      const next = E.nextBuyAt(plan);
      if (next) lines.push(detailed ? `Next buy: ${F.whenLong(next, tz())} (in ${F.countdown(next)})` : `Next buy in ${F.countdown(next)}`);
    } else {
      lines.push(plan.status === "finished" ? "Finished" : "Paused");
    }
    if (detailed) {
      lines.push(`Stops ${F.esc(F.stopText(plan.stop, plan.coin.symbol))}`);
      lines.push(`Pays with ${F.esc(plan.pay.symbol)} on ${F.esc(plan.pay.networkName)}`);
    }
    if (plan.note) lines.push(`<i>${F.esc(plan.note)}</i>`);
    return lines;
  }

  function plansScreen() {
    const plans = state.plans;
    const keyboard = new InlineKeyboard();
    for (const plan of plans) {
      keyboard.text(`${plan.coin.symbol} · ${F.FREQ_LABEL[plan.schedule.freq]}${plan.status === "active" ? "" : ` (${plan.status})`}`, `pl:v:${plan.id}`).row();
    }
    keyboard.text("New plan", "nav:markets").text(state.pausedAll ? "Resume everything" : "Pause everything", state.pausedAll ? "pause:off" : "pause:on");
    const header = state.pausedAll ? "<b>Your plans</b> · everything is paused" : "<b>Your plans</b>";
    const body = plans.length ? plans.map((p) => planLines(p).join("\n")).join("\n\n") : "No plans yet. Pick a coin in Markets to start.";
    return { text: `${header}\n\n${body}`, keyboard };
  }

  function planScreen(plan, notice = null) {
    const keyboard = new InlineKeyboard();
    if (plan.status === "active") {
      keyboard.text("Buy now", `pl:buy:${plan.id}`).text("Edit amount", `pl:amt:${plan.id}`).row();
      keyboard.text("Edit goal", `pl:goal:${plan.id}`).text("Pause", `pl:pause:${plan.id}`).row();
      keyboard.text("Delete", `pl:del:${plan.id}`).row();
    } else {
      keyboard.text("Restart", `pl:rs:${plan.id}`).text("Delete", `pl:del:${plan.id}`).row();
    }
    keyboard.text("‹ My plans", "nav:plans");
    const lines = planLines(plan, true);
    if (notice) lines.push("", notice);
    return { text: lines.join("\n"), keyboard };
  }

  const STATUS_TEXT = {
    COMPLETED: "✅ Done",
    WAITING: "⏳ Waiting",
    PENDING: "⏳ Waiting",
    REPLACED: "🔁 Replaced",
    FAILED: "❌ Failed",
    EXPIRED: "❌ Expired",
    ERROR: "❌ Check Tangem",
  };

  function historyLine(e) {
    const got = e.received ? F.amount(e.received) : e.estimate ? `about ${F.amount(e.estimate)}` : null;
    const trade = `${F.amount(e.paid)} ${F.esc(e.pay.symbol)} → ${got ? `${got} ` : ""}${F.esc(e.coin.symbol)}`;
    let status = STATUS_TEXT[e.status] ?? F.esc(e.status);
    if (e.status === "MISSED") {
      const plan = E.getPlan(e.planId);
      status = `⏭ Missed ${plan ? F.periodWords(plan.schedule.freq).that : ""}`.trim();
    }
    if (e.status === "COMPLETED" && e.completedAt && F.shortDate(e.completedAt, tz()) !== F.shortDate(e.createdAt, tz())) {
      status += ` (approved ${F.weekday(e.completedAt, tz())})`;
    }
    return `${F.shortDate(e.createdAt, tz())} · ${trade} · ${status}`;
  }

  function historyFilter(filter) {
    if (filter === "all") return { entries: history, coin: null };
    const entries = history.filter((e) => C.shortId(e.coin.key) === filter);
    return { entries, coin: entries[0]?.coin ?? null };
  }

  function coinSummaryLines(coin, entries) {
    const price = coin.coingeckoId ? cg.peekPrices([coin.coingeckoId]).prices[coin.coingeckoId]?.usd ?? null : null;
    const s = coinSummary(entries, price);
    const sym = F.esc(coin.symbol);
    const lines = [`<b>${sym} summary</b>`, `Bought ${F.amount(s.bought)} ${sym} for ${F.usd(s.spent)}`];
    lines.push(`Average price ${F.usd(s.avgPrice)} · now ${price != null ? F.usd(price) : "not available"}`);
    if (s.worth != null && s.bought > 0) {
      lines.push(`Worth now ${F.usd(s.worth)} ${s.change >= 0 ? "▲" : "▼"} ${F.usd(Math.abs(s.change))} (${Math.abs(s.changePct ?? 0).toFixed(1)}%)`);
    }
    const plan = state.plans.find((p) => p.coin.key === coin.key && p.status === "active") ?? state.plans.find((p) => p.coin.key === coin.key);
    const streak = plan ? E.streakOf(plan) : null;
    lines.push(`Done ${s.done} · missed ${s.missed}${streak ? ` · streak ${streak.current} · best ${streak.best}` : ""}`);
    return lines;
  }

  function historyScreen(filter = "all", page = 0) {
    const { entries, coin } = historyFilter(filter);
    const slice = entries.slice(page * HISTORY_PAGE, (page + 1) * HISTORY_PAGE);
    const lines = [coin ? `<b>History · ${F.esc(coin.symbol)}</b>` : "<b>History</b>", ""];
    if (coin && page === 0) lines.push(...coinSummaryLines(coin, entries), "");
    lines.push(...(slice.length ? slice.map(historyLine) : ["No buys yet."]));

    const keyboard = new InlineKeyboard();
    const coins = [...new Map(history.map((e) => [e.coin.key, e.coin])).values()].slice(0, 6);
    if (coins.length > 1 || filter !== "all") {
      keyboard.text(filter === "all" ? "All ✓" : "All", "h:all:0");
      coins.forEach((c) => keyboard.text(C.shortId(c.key) === filter ? `${c.symbol} ✓` : c.symbol, `h:${C.shortId(c.key)}:0`));
      keyboard.row();
    }
    if (page > 0) keyboard.text("‹ Newer", `h:${filter}:${page - 1}`);
    if ((page + 1) * HISTORY_PAGE < entries.length) keyboard.text("Older ›", `h:${filter}:${page + 1}`);
    if (keyboard.inline_keyboard.at(-1)?.length) keyboard.row();
    keyboard.text("Export CSV", `hx:${filter}`);
    return { text: lines.join("\n"), keyboard };
  }

  function settingsScreen() {
    const s = state.settings;
    const check = (on) => (on ? " ✓" : "");
    const keyboard = new InlineKeyboard()
      .text(`Every 3h${check(s.reminderHours === 3)}`, "st:rem:3")
      .text(`Every 6h${check(s.reminderHours === 6)}`, "st:rem:6")
      .text(`Every 12h${check(s.reminderHours === 12)}`, "st:rem:12")
      .text(`Off${check(!s.reminderHours)}`, "st:rem:0").row()
      .text(`Quiet hours ${s.quiet.start}–${s.quiet.end} · Change`, "st:quiet").row()
      .text(`Low USDC alert: On${check(s.lowUsdc)}`, "st:low:1").text(`Off${check(!s.lowUsdc)}`, "st:low:0").row()
      .text(`Amounts on cards: Hide${check(!s.showAmounts)}`, "st:amt:0").text(`Show${check(s.showAmounts)}`, "st:amt:1").row()
      .text("Start over", "st:over");
    const text = [
      "<b>Settings</b>",
      "",
      `Reminders for buys waiting for approval: ${s.reminderHours ? `every ${s.reminderHours}h` : "off"}`,
      `Quiet hours (no reminders or alerts): ${s.quiet.start}–${s.quiet.end}`,
      `Low USDC alert: ${s.lowUsdc ? "on" : "off"}`,
      `Amounts on share cards: ${s.showAmounts ? "shown" : "hidden"}`,
    ].join("\n");
    return { text, keyboard };
  }

  const pauseScreen = () =>
    state.pausedAll
      ? { text: "⏸ Everything is paused. No buys will be prepared.", keyboard: new InlineKeyboard().text("Resume", "pause:off") }
      : { text: "Everything is running. Plans buy at their next scheduled time.", keyboard: new InlineKeyboard().text("Pause everything", "pause:on").text("My plans", "nav:plans") };

  // ---- Plan setup form (one message that updates as you tap) ----

  const formStep = (f) => {
    if (f.mode === "amount") return "amount";
    if (f.mode === "goal") return f.stop ? "done" : "stop";
    if (!f.amount) return "amount";
    if (!f.freq) return "freq";
    if (f.freq === "days" && !f.every) return "every";
    if (f.freq !== "daily" && !f.weekday) return "day";
    if (!f.timeOk) return "time";
    if (!f.stop) return "stop";
    return f.changing ? "change" : "summary";
  };

  /** For "every X days": the first date with the chosen weekday whose buy time is still ahead. */
  function anchorFor(weekday, time) {
    const now = DateTime.now().setZone(tz());
    const [hour, minute] = time.split(":").map(Number);
    for (let i = 0; i < 8; i++) {
      const day = now.plus({ days: i }).set({ hour, minute, second: 0, millisecond: 0 });
      if (day.weekday === weekday && day > now) return day.toISODate();
    }
    return now.toISODate();
  }

  const draftSchedule = (f) => ({
    freq: f.freq,
    weekday: f.freq === "daily" ? null : f.weekday,
    every: f.freq === "days" ? f.every : null,
    anchor: f.freq === "days" ? anchorFor(f.weekday, f.time) : null,
    time: f.time,
  });

  function scheduleSoFar(f) {
    if (!f.freq) return null;
    if (f.freq === "daily") return `Every day at ${f.time}`;
    if (f.freq === "days") return f.every ? `Every ${f.every} days${f.weekday ? `, starting ${WEEKDAYS[f.weekday - 1]}` : ""} at ${f.time}` : "Every few days";
    if (!f.weekday) return f.freq === "weekly" ? "Weekly" : "Monthly";
    const day = WEEKDAY_NAMES[f.weekday - 1];
    return f.freq === "weekly" ? `Every ${day} at ${f.time}` : `First ${day} of every month at ${f.time}`;
  }

  const CUSTOM_PROMPTS = {
    amount: "Type the amount in USDC, for example 15.",
    every: "Type the number of days between buys, for example 3.",
    time: "Type the time as HH:MM, for example 18:30.",
    buys: "Type the number of buys, for example 8.",
    date: "Type the last date as DD/MM/YYYY.",
    gcoin: "Type how much of the coin you want, for example 1.5.",
    gusd: "Type the dollar amount, for example 1000.",
  };

  function formKeyboard(f) {
    const kb = new InlineKeyboard();
    if (f.input) return kb.text("‹ Back", "w:back");
    const cancel = () => kb.row().text("Cancel", "w:x");
    switch (formStep(f)) {
      case "amount":
        ["5", "10", "25"].forEach((a) => kb.text(`${a} USDC`, `w:amt:${a}`));
        kb.text("Custom", "w:amt:c");
        return cancel();
      case "freq":
        kb.text("Daily", "w:f:daily").text("Weekly", "w:f:weekly").row().text("Monthly", "w:f:monthly").text("Every X days", "w:f:days");
        return cancel();
      case "every":
        return kb.text("Type a number", "w:in:every");
      case "day":
        WEEKDAYS.forEach((d, i) => {
          kb.text(d, `w:d:${i + 1}`);
          if (i === 3) kb.row();
        });
        return cancel();
      case "time":
        kb.text(`Keep ${f.time}`, "w:t:ok").text("Change", "w:in:time");
        return cancel();
      case "stop":
        switch (f.sub) {
          case "buys":
            ["4", "12", "26"].forEach((n) => kb.text(`${n} buys`, `w:sb:${n}`));
            return kb.text("Custom", "w:in:buys").row().text("‹ Back", "w:s:main");
          case "date":
            kb.text("1 month", "w:sd:1").text("3 months", "w:sd:3").text("6 months", "w:sd:6").row();
            return kb.text("Custom date", "w:in:date").row().text("‹ Back", "w:s:main");
          case "goal":
            kb.text(`Amount of ${f.coin.symbol}`, "w:s:gcoin").text("Dollars invested", "w:s:gusd").row();
            return kb.text("‹ Back", "w:s:main");
          case "gcoin":
            ["0.5", "1", "2", "5"].forEach((n) => kb.text(`${n} ${f.coin.symbol}`, `w:gc:${n}`));
            return kb.row().text("Custom", "w:in:gcoin").text("‹ Back", "w:s:goal");
          case "gusd":
            ["100", "250", "500"].forEach((n) => kb.text(`$${n}`, `w:gu:${n}`));
            return kb.text("Custom", "w:in:gusd").row().text("‹ Back", "w:s:goal");
          default:
            kb.text("Never", "w:s:never").text("After X buys", "w:s:buys").row().text("On a date", "w:s:date").text("At a goal", "w:s:goal");
            return cancel();
        }
      case "summary":
        return kb.text("Start", "w:start").text("Change", "w:chg");
      case "change":
        kb.text("Amount", "w:c:amount").text("How often", "w:c:freq").row().text("Day & time", "w:c:time").text("Stop when", "w:c:stop").row();
        if (f.payOptions.length > 1) kb.text("Pay with", "w:c:pay").row();
        return kb.text("‹ Back", "w:c:back");
      default:
        return kb;
    }
  }

  const STEP_PROMPTS = {
    amount: "How much per buy?",
    freq: "How often?",
    day: (f) => (f.freq === "monthly" ? "Which day? (the first one of each month)" : f.freq === "days" ? "Which day is the first buy?" : "Which day?"),
    time: (f) => `What time? Buys happen at ${f.time} unless you change it.`,
    stop: (f) =>
      ({ buys: "Stop after how many buys?", date: "Stop on which date?", goal: "What kind of goal?", gcoin: `How much ${f.coin.symbol}?`, gusd: "How many dollars in total?" })[f.sub] ??
      "Stop when?",
    pay: "Pay with which USDC?",
    change: "What do you want to change?",
  };

  function perBuyCoin(f) {
    if (f.estimate) return Number(f.estimate);
    if (!f.price) return null;
    return (Number(f.amount) * (f.usdcPrice ?? 1)) / f.price;
  }

  function summaryText(f) {
    const schedule = draftSchedule(f);
    const sym = F.esc(f.coin.symbol);
    let when = F.describeSchedule(schedule);
    if (f.freq === "days") when += `, starting ${F.weekdayLong(DateTime.fromISO(schedule.anchor, { zone: tz() }).toMillis(), tz())}`;
    const lines = ["✅ Here's your plan", `${F.amount(f.amount)} USDC ${when}`];
    const per = perBuyCoin(f);
    if (per) lines.push(`About ${F.amount(per)} ${sym} each time`);
    const fc = forecast({
      schedule, stop: f.stop, amount: f.amount, progress: { buys: 0, received: 0, spent: 0 }, perBuyCoin: per, nowMs: Date.now(), tz: tz(),
    });
    if (fc?.kind === "goal" && fc.date) {
      const target = F.esc(F.goalLabel(f.stop, f.coin.symbol));
      lines.push(f.stop.unit === "usd"
        ? `You'll have invested ${target} around ${F.shortDate(fc.date, tz())} (${F.plural(fc.buys, "buy")})`
        : `You'll reach ${target} around ${F.shortDate(fc.date, tz())} (${F.plural(fc.buys, "buy")})`);
    } else if (fc?.kind === "buys") lines.push(`Stops after ${F.plural(f.stop.count, "buy")}`);
    else if (fc?.kind === "date") lines.push(fc.date ? `Last buy around ${F.shortDate(fc.date, tz())}` : "No buys before that date");
    else if (fc?.kind === "never") lines.push("No end date");
    if (f.payOptions.length > 1) lines.push(`Paid with USDC on ${F.esc(f.pay.token.networkName)}`);
    return lines.join("\n");
  }

  function formText(f) {
    const step = formStep(f);
    if (step === "summary" || (step === "change" && !f.input)) {
      const note = f.error ? `\n\n<i>${F.esc(f.error)}</i>` : "";
      return step === "summary" ? `${summaryText(f)}${note}` : `${summaryText(f)}\n\n${STEP_PROMPTS.change}`;
    }
    const sym = F.esc(f.coin.symbol);
    const head =
      f.mode === "new" ? `<b>Buy ${sym}</b>${f.price ? ` · ${F.usd(f.price)}` : ""}` : `<b>${sym} plan</b> · ${f.mode === "amount" ? "edit amount" : "edit goal"}`;
    const lines = [head];
    if (f.mode === "new") {
      if (f.amount) lines.push(`Amount: ${F.amount(f.amount)} USDC`);
      const sched = scheduleSoFar(f);
      if (sched) lines.push(`How often: ${sched}`);
      if (f.stop) lines.push(`Stop: ${F.esc(F.stopText(f.stop, f.coin.symbol))}`);
      if (f.pay) lines.push(`Pay with: USDC on ${F.esc(f.pay.token.networkName)}`);
    } else if (f.mode === "amount") {
      lines.push(`Now: ${F.amount(f.current)} USDC per buy. The new amount applies from the next buy.`);
    } else {
      lines.push(`Now: stops ${F.esc(F.stopText(f.currentStop, f.coin.symbol))}. The change applies from the next buy.`);
    }
    const prompt = f.input ? CUSTOM_PROMPTS[f.input] : typeof STEP_PROMPTS[step] === "function" ? STEP_PROMPTS[step](f) : STEP_PROMPTS[step];
    lines.push("", f.error ? `<i>${F.esc(f.error)}</i>\n${prompt}` : prompt);
    return lines.join("\n");
  }

  async function renderForm(f) {
    return edit(f.msgId, formText(f), withMenu(formKeyboard(f)));
  }

  /** Opens the setup form for a coin on the message `msg` (edited in place). */
  async function openSetup(ctx, coin) {
    const wallet = await W.loadWallet();
    const usdc = wallet.filter((t) => C.isUsdc(t) && t.address);
    const pairs = usdc.length ? await W.swappablePairs(usdc, [coin]) : new Set();
    const payTokens = usdc.filter((t) => pairs.has(`${t.key}>${coin.key}`));
    if (!payTokens.length) throw new W.UserError(`You need USDC in your Tangem wallet on a network that can buy ${coin.symbol}.`);
    const balances = await W.loadBalances(payTokens);
    const payOptions = payTokens
      .map((token) => ({ token, balance: balances.get(token.key) ?? null }))
      .sort((a, b) => Number(b.balance ?? -1) - Number(a.balance ?? -1));
    const priced = await getPrices([coin.coingeckoId, C.USDC_COINGECKO_ID]);
    form = {
      mode: "new",
      msgId: ctx.callbackQuery.message.message_id,
      coin,
      price: priced.prices[coin.coingeckoId]?.usd ?? null,
      usdcPrice: priced.prices[C.USDC_COINGECKO_ID]?.usd ?? null,
      payOptions,
      pay: payOptions[0],
      amount: null, freq: null, every: null, weekday: null, time: "09:00", timeOk: false, stop: null,
      sub: null, input: null, error: null, changing: false, estimate: null,
    };
    input = null;
    await renderForm(form);
  }

  /** Before the summary: a price estimate from Tangem when CoinGecko has no price for the coin (read-only). */
  async function ensureEstimate(f) {
    if (f.mode !== "new" || f.price || f.estimate || formStep(f) !== "summary") return;
    try {
      const { best } = await W.bestPrice(f.pay.token, f.coin, f.amount);
      f.estimate = best.toAmount;
    } catch (err) {
      f.error = err.message;
    }
  }

  /** Applies a finished edit form (amount or goal) to its plan. */
  async function finishEditForm(f) {
    let plan;
    try {
      plan = f.mode === "amount" ? await E.editAmount(f.planId, f.amount) : await E.editStop(f.planId, f.stop);
    } catch (err) {
      if (!(err instanceof W.UserError)) throw err;
      Object.assign(f, { error: err.message, amount: f.mode === "amount" ? null : f.amount, stop: f.mode === "goal" ? null : f.stop });
      return renderForm(f);
    }
    form = null;
    const notice = f.mode === "amount" ? "New amount saved. It applies from the next buy." : "Goal saved. It applies from the next buy.";
    const screen = planScreen(plan, notice);
    await edit(f.msgId, screen.text, withMenu(screen.keyboard));
  }

  const monthsAhead = (n) => DateTime.now().setZone(tz()).plus({ months: n }).toISODate();

  /** Sets a typed or tapped value on the form; returns an error message or null. */
  function setFormValue(f, field, raw) {
    const text = String(raw).trim().replace(/^\$/, "").replace(",", ".");
    const positive = () => AMOUNT_RE.test(text) && Number(text) > 0;
    switch (field) {
      case "amount":
        if (!positive() || Number(text) > 1_000_000) return "That isn't a valid amount.";
        if ((text.split(".")[1] ?? "").length > 6) return "Use at most 6 decimal places.";
        f.amount = String(Number(text));
        f.estimate = null;
        return null;
      case "every": {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1 || n > 365) return "Use a whole number of days from 1 to 365.";
        f.every = n;
        return null;
      }
      case "time": {
        const time = parseTime(text);
        if (!time) return "Use a time like 09:00 or 18:30.";
        f.time = time;
        f.timeOk = true;
        return null;
      }
      case "buys": {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1 || n > 1000) return "Use a whole number of buys, at least 1.";
        f.stop = { type: "buys", count: n };
        return null;
      }
      case "date": {
        const date = parseDate(text);
        if (!date) return "Use a date like 31/03/2027.";
        if (date <= DateTime.now().setZone(tz()).toISODate()) return "Pick a date after today.";
        f.stop = { type: "date", date };
        return null;
      }
      case "gcoin":
      case "gusd":
        if (!positive()) return "Use a number bigger than 0.";
        f.stop = { type: "goal", unit: field === "gusd" ? "usd" : "coin", target: String(Number(text)) };
        return null;
      default:
        return "Unknown field";
    }
  }

  async function afterFormChange(f) {
    if (f.mode !== "new" && formStep(f) === "done") return finishEditForm(f);
    if (f.mode === "amount" && f.amount) return finishEditForm(f);
    if (f.mode === "new" && f.changing && f.changeTarget) {
      // Back to the summary once the changed section is filled in again.
      const step = formStep({ ...f, changing: false });
      if (step === "summary") f.changing = false;
    }
    await ensureEstimate(f);
    return renderForm(f);
  }

  // ---- Owner only (others get one pointer to the demo per day), offline updates dropped by polling ----

  /** Someone else wrote to the bot in a private chat: one reply per person per day, otherwise silence. */
  async function answerStranger(ctx) {
    if (!ctx.message || ctx.chat?.type !== "private" || !ctx.from) return;
    const today = DateTime.now().setZone(tz()).toISODate();
    const replies = (state.strangerReplies ??= {});
    if (replies[ctx.from.id] === today) return;
    for (const [id, day] of Object.entries(replies)) if (day !== today) delete replies[id];
    replies[ctx.from.id] = today;
    save();
    await ctx.reply(STRANGER_REPLY, { link_preview_options: { is_disabled: true } }).catch(() => {});
  }

  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== ownerId) return answerStranger(ctx);
    if (ctx.message?.text?.startsWith("/")) {
      input = null;
      if (form) form.input = null;
    }
    await next();
  });

  // ---- Commands ----

  bot.command("start", async (ctx) => {
    if (ctx.match === "share") return show(ctx, plansScreen());
    return show(ctx, welcomeScreen());
  });
  bot.command("help", (ctx) => ctx.reply(HELP, { ...html, reply_markup: withMenu() }));
  bot.command("portfolio", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    return show(ctx, await portfolioScreen());
  });
  bot.command("dca", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    return show(ctx, await marketsScreen({ forPlan: true }));
  });
  bot.command("markets", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    return show(ctx, await marketsScreen());
  });
  bot.command("plans", (ctx) => show(ctx, plansScreen()));
  bot.command("history", (ctx) => show(ctx, historyScreen()));
  bot.command("settings", (ctx) => show(ctx, settingsScreen()));
  bot.command("pause", async (ctx) => {
    if (!state.pausedAll) await E.setPausedAll(true);
    return show(ctx, pauseScreen());
  });

  // ---- Navigation ----

  const SCREENS = {
    start: welcomeScreen,
    dca: dcaScreen,
    portfolio: portfolioScreen,
    markets: marketsScreen,
    plans: plansScreen,
    settings: settingsScreen,
  };
  // nav:<screen> edits the message the button is on; navn:<screen> (on alerts and buy messages) sends a new one.
  bot.callbackQuery(/^nav(n?):(\w+)$/, async (ctx) => {
    const [, fresh, name] = ctx.match;
    const screen = SCREENS[name];
    await ctx.answerCallbackQuery();
    if (!screen) return;
    if (name === "portfolio" || name === "markets") await ctx.replyWithChatAction("typing");
    input = null;
    const { text, keyboard, home } = await screen();
    if (fresh) await ctx.reply(text, { ...html, reply_markup: home ? keyboard : withMenu(keyboard) });
    else await show(ctx, { text, keyboard, home });
  });

  bot.callbackQuery(/^pause:(on|off)$/, async (ctx) => {
    await E.setPausedAll(ctx.match[1] === "on");
    await ctx.answerCallbackQuery({ text: ctx.match[1] === "on" ? "Paused" : "Resumed" });
    await show(ctx, pauseScreen());
  });

  // ---- Markets, search, setup ----

  bot.callbackQuery(/^m:search$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    input = { kind: "search", msgId: ctx.callbackQuery.message.message_id };
    await show(ctx, { text: "Type the name of a coin to search.", keyboard: new InlineKeyboard().text("Cancel", "nav:markets") });
  });

  bot.callbackQuery(/^m:(\w{10})$/, async (ctx) => {
    const coin = C.coinByShortId(ctx.match[1]);
    if (!coin) return ctx.answerCallbackQuery({ text: "That coin isn't in your list anymore." });
    await ctx.answerCallbackQuery();
    await ctx.replyWithChatAction("typing");
    await openSetup(ctx, coin);
  });

  async function runSearch(query) {
    const results = (await cg.search(query)).slice(0, 5);
    const { networks } = await W.getResources();
    const platforms = await cg.assetPlatforms().catch(() => []);
    const nativeOf = new Map(platforms.map((p) => [p.id, p.nativeCoinId]));
    const wallet = await W.getWallet();
    const found = new Map();
    for (const r of results) {
      let info;
      try {
        info = await cg.coinPlatforms(r.id);
      } catch {
        continue;
      }
      const base = { coingeckoId: r.id, name: info.name ?? r.name, symbol: String(info.symbol ?? r.symbol).toUpperCase(), logoUrl: info.image ?? r.image ?? null };
      for (const p of info.platforms) {
        if (!networks.has(p.platformId) || p.decimals == null || !p.contractAddress) continue;
        const key = W.assetKey(p.platformId, p.contractAddress);
        found.set(key, { ...base, network: p.platformId, contractAddress: p.contractAddress, decimals: p.decimals, key });
      }
      for (const network of networks.keys()) {
        if (network !== r.id && nativeOf.get(network) !== r.id) continue;
        const native = wallet.find((t) => t.network === network && t.contractAddress === W.NATIVE_CONTRACT);
        if (!native) continue; // native decimals only come from the wallet
        const key = W.assetKey(network, W.NATIVE_CONTRACT);
        found.set(key, { ...base, network, contractAddress: W.NATIVE_CONTRACT, decimals: native.decimals, key });
      }
    }
    const candidates = [...found.values()].slice(0, 50);
    const usdc = wallet.filter((t) => C.isUsdc(t) && t.address);
    if (!usdc.length || !candidates.length) return [];
    const pairs = await W.swappablePairs(usdc, candidates);
    const ok = candidates.filter((c) => usdc.some((u) => pairs.has(`${u.key}>${c.key}`)));
    for (const c of ok) c.networkName = await W.networkName(c.network);
    return ok.slice(0, 8);
  }

  const candidateLabel = (c) => `${c.symbol} · ${c.networkName} · ${F.shortContract(c.contractAddress)}`;

  async function handleSearch(ctx, query) {
    await ctx.replyWithChatAction("typing");
    const results = await runSearch(query);
    search = { results, msgId: input.msgId };
    input = null;
    const kb = new InlineKeyboard();
    results.forEach((c, i) => kb.text(candidateLabel(c), `sr:${i}`).row());
    kb.text("Search again", "m:search").text("Cancel", "nav:markets");
    const text = results.length
      ? [`<b>Matches for “${F.esc(query)}”</b>`, "Only coins Tangem can buy with your USDC are shown.", "", ...results.map((c) => `${F.esc(c.name)} (${F.esc(c.symbol)}) · ${F.esc(c.networkName)} · <code>${F.esc(F.shortContract(c.contractAddress))}</code>`)].join("\n")
      : `No coin Tangem can buy with your USDC matched “${F.esc(query)}”.`;
    await edit(search.msgId, text, withMenu(kb));
  }

  bot.callbackQuery(/^sr:(\d+)$/, async (ctx) => {
    const c = search?.results[Number(ctx.match[1])];
    if (!c) return ctx.answerCallbackQuery({ text: "This search expired. Search again." });
    await ctx.answerCallbackQuery();
    const text = [
      "Is this the right one? Check the contract on CoinGecko.",
      "",
      `<b>${F.esc(c.name)} (${F.esc(c.symbol)})</b> on ${F.esc(c.networkName)}`,
      c.contractAddress === W.NATIVE_CONTRACT ? "Native coin of the network" : `Contract: <code>${F.esc(c.contractAddress)}</code>`,
      `https://www.coingecko.com/en/coins/${encodeURIComponent(c.coingeckoId)}`,
    ].join("\n");
    await show(ctx, { text, keyboard: new InlineKeyboard().text("Add", `sa:${ctx.match[1]}`).text("Cancel", "nav:markets") });
  });

  bot.callbackQuery(/^sa:(\d+)$/, async (ctx) => {
    const c = search?.results[Number(ctx.match[1])];
    if (!c) return ctx.answerCallbackQuery({ text: "This search expired. Search again." });
    const coin = C.addCoin({ symbol: c.symbol, name: c.name, network: c.network, contractAddress: c.contractAddress, decimals: c.decimals, coingeckoId: c.coingeckoId, logoUrl: c.logoUrl });
    marketsCache = null;
    search = null;
    await ctx.answerCallbackQuery({ text: `${coin.symbol} added` });
    await show(ctx, await marketsScreen());
  });

  // ---- Form buttons ----

  bot.callbackQuery(/^w:(\w+)(?::(.+))?$/, async (ctx) => {
    const f = form;
    if (!f || f.msgId !== ctx.callbackQuery.message?.message_id) {
      return ctx.answerCallbackQuery({ text: "This setup expired. Start again from Markets or My plans." });
    }
    await ctx.answerCallbackQuery();
    const [, action, value] = ctx.match;
    f.error = null;
    switch (action) {
      case "x":
        form = null;
        input = null;
        if (f.mode !== "new") {
          const plan = E.getPlan(f.planId);
          return show(ctx, plan ? planScreen(plan) : plansScreen());
        }
        return show(ctx, await marketsScreen());
      case "back":
        f.input = null;
        input = null;
        break;
      case "in":
        f.input = value;
        input = { kind: "form", field: value };
        break;
      case "amt":
        if (value === "c") {
          f.input = "amount";
          input = { kind: "form", field: "amount" };
        } else setFormValue(f, "amount", value);
        break;
      case "f":
        f.freq = value;
        f.every = null;
        if (value === "daily") f.weekday = null;
        if (value === "days") {
          f.input = "every";
          input = { kind: "form", field: "every" };
        }
        break;
      case "d":
        f.weekday = Number(value);
        break;
      case "t":
        f.timeOk = true;
        break;
      case "s":
        if (value === "never") f.stop = { type: "never" };
        else f.sub = value === "main" ? null : value;
        break;
      case "sb":
        setFormValue(f, "buys", value);
        break;
      case "sd":
        f.stop = { type: "date", date: monthsAhead(Number(value)) };
        break;
      case "gc":
        setFormValue(f, "gcoin", value);
        break;
      case "gu":
        setFormValue(f, "gusd", value);
        break;
      case "p":
        f.pay = f.payOptions[Number(value)] ?? f.pay;
        f.estimate = null;
        f.changeTarget = null;
        f.changing = false;
        break;
      case "chg":
        f.changing = true;
        break;
      case "c":
        f.changeTarget = value;
        if (value === "back") {
          f.changing = false;
          f.changeTarget = null;
        } else if (value === "amount") f.amount = null;
        else if (value === "freq") Object.assign(f, { freq: null, every: null, weekday: null, timeOk: false });
        else if (value === "time") Object.assign(f, { weekday: null, timeOk: false });
        else if (value === "stop") Object.assign(f, { stop: null, sub: null });
        else if (value === "pay") return edit(f.msgId, `${summaryText(f)}\n\n${STEP_PROMPTS.pay}`, withMenu(formKeyboardPay(f)));
        break;
      case "start": {
        const coin = { ...f.coin };
        const pay = f.pay.token;
        const plan = await E.createPlan({
          coin,
          pay: { symbol: pay.symbol, network: pay.network, networkName: pay.networkName, contractAddress: pay.contractAddress, key: pay.key },
          amount: f.amount,
          schedule: draftSchedule(f),
          stop: f.stop,
        });
        form = null;
        const next = E.nextBuyAt(plan);
        return show(ctx, {
          text: `Your ${F.esc(coin.symbol)} plan is on.${next ? ` First buy: ${F.whenLong(next, tz())}.` : ""}\nYou'll get a message here when it's ready to approve.`,
          keyboard: new InlineKeyboard().text("My plans", "nav:plans"),
        });
      }
    }
    if (f.stop && f.sub) f.sub = null;
    await afterFormChange(f);
  });

  function formKeyboardPay(f) {
    const kb = new InlineKeyboard();
    f.payOptions.forEach((o, i) =>
      kb.text(`USDC · ${o.token.networkName} (${o.balance != null ? F.amount(o.balance) : "balance not available"})`, `w:p:${i}`).row(),
    );
    return kb.text("‹ Back", "w:c:back");
  }

  // ---- Plans ----

  bot.callbackQuery(/^pl:(\w+):(\w+)$/, async (ctx) => {
    const [, action, id] = ctx.match;
    const plan = E.getPlan(id);
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "This plan was deleted." });
      return show(ctx, plansScreen());
    }
    const msgId = ctx.callbackQuery.message.message_id;
    switch (action) {
      case "v":
        await ctx.answerCallbackQuery();
        return show(ctx, planScreen(plan));
      case "buy":
        return buyNowButton(ctx, plan, () => show(ctx, planScreen(plan)));
      case "amt":
        await ctx.answerCallbackQuery();
        form = { mode: "amount", planId: id, msgId, coin: plan.coin, current: plan.amount, amount: null, payOptions: [], input: null, error: null };
        return renderForm(form);
      case "goal":
        await ctx.answerCallbackQuery();
        form = { mode: "goal", planId: id, msgId, coin: plan.coin, currentStop: plan.stop, stop: null, sub: null, payOptions: [], input: null, error: null };
        return renderForm(form);
      case "pause":
        await E.pausePlan(id);
        await ctx.answerCallbackQuery({ text: "Paused" });
        return show(ctx, planScreen(plan));
      case "rs":
        await ctx.answerCallbackQuery();
        return show(ctx, {
          text: `${planLines(plan).join("\n")}\n\nRestart this plan?`,
          keyboard: new InlineKeyboard().text("Keep progress", `pl:rsk:${id}`).text("Start fresh", `pl:rsf:${id}`).row().text("Cancel", `pl:v:${id}`),
        });
      case "rsk":
      case "rsf":
        await E.restart(id, action === "rsk" ? "keep" : "fresh");
        await ctx.answerCallbackQuery({ text: "Restarted" });
        return show(ctx, planScreen(plan, action === "rsf" ? "Started fresh. Your history is kept." : null));
      case "del":
        await ctx.answerCallbackQuery();
        return show(ctx, {
          text: `${planLines(plan).join("\n")}\n\nDelete this plan? Your history stays.`,
          keyboard: new InlineKeyboard().text("Delete", `pl:dely:${id}`).text("Cancel", `pl:v:${id}`),
        });
      case "dely":
        await E.deletePlan(id);
        await ctx.answerCallbackQuery({ text: "Deleted" });
        return show(ctx, plansScreen());
      default:
        return ctx.answerCallbackQuery();
    }
  });

  /** Buy now / Get a fresh price: one request per tap, guarded against double taps. */
  async function buyNowButton(ctx, plan, after) {
    if (busy.has(plan.id)) return ctx.answerCallbackQuery({ text: "Already getting the best price…" });
    busy.add(plan.id);
    await ctx.answerCallbackQuery({ text: "Getting the best price…" });
    try {
      await E.buyNow(plan.id);
    } catch (err) {
      const kb = err.waiting ? new InlineKeyboard().text("Get a fresh price", `fr:${err.waiting.id}`) : undefined;
      await ctx.reply(F.esc(errorText(err)), { ...html, reply_markup: kb });
    } finally {
      busy.delete(plan.id);
    }
    if (after) await after();
  }

  bot.callbackQuery(/^fr:(\w+)$/, async (ctx) => {
    const id = ctx.match[1];
    if (busy.has(id)) return ctx.answerCallbackQuery({ text: "Already getting a fresh price…" });
    busy.add(id);
    await ctx.answerCallbackQuery({ text: "Getting a fresh price…" });
    try {
      await E.freshPrice(id);
    } catch (err) {
      await ctx.reply(F.esc(errorText(err)), html);
    } finally {
      busy.delete(id);
    }
  });

  bot.callbackQuery(/^g:(double|none|stop):(\w+)$/, async (ctx) => {
    const [, choice, id] = ctx.match;
    const plan = await E.afterGoal(id, choice);
    await ctx.answerCallbackQuery();
    const note =
      choice === "double" ? `New goal: ${F.esc(F.goalLabel(plan.stop, plan.coin.symbol))}. Your plan keeps going.`
      : choice === "none" ? "Your plan keeps going with no goal."
      : "Your plan is stopped. Restart it anytime from My plans.";
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("Share", `sh:${id}`).text("My plans", "navn:plans") }).catch(() => {});
    await ctx.reply(note, html);
  });

  bot.callbackQuery(/^dip:(buy|ok)(?::(\w+))?$/, async (ctx) => {
    if (ctx.match[1] === "ok") {
      await ctx.answerCallbackQuery();
      return ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    }
    const plan = E.getPlan(ctx.match[2]);
    if (!plan) return ctx.answerCallbackQuery({ text: "That plan was deleted." });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    return buyNowButton(ctx, plan);
  });

  bot.callbackQuery(/^cr:(use|keep):(\w+):(\w{10})$/, async (ctx) => {
    const [, choice, planId, short] = ctx.match;
    const token = (await W.getWallet()).find((t) => C.isUsdc(t) && C.shortId(t.key) === short);
    const plan = E.getPlan(planId);
    if (!plan || !token) return ctx.answerCallbackQuery({ text: "This suggestion expired." });
    await ctx.answerCallbackQuery();
    if (choice === "use") {
      const old = plan.pay.networkName;
      await E.setPay(planId, token);
      return show(ctx, { text: `From the next buy, your ${F.esc(plan.coin.symbol)} plan pays with USDC on ${F.esc(token.networkName)} instead of ${F.esc(old)}.`, keyboard: new InlineKeyboard() });
    }
    await E.keepPay(planId, token.key);
    return show(ctx, { text: `OK, your ${F.esc(plan.coin.symbol)} plan keeps paying with USDC on ${F.esc(plan.pay.networkName)}.`, keyboard: new InlineKeyboard() });
  });

  bot.callbackQuery(/^mv:(keep|how):(\w+)$/, async (ctx) => {
    const plan = E.getPlan(ctx.match[2]);
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === "keep") return ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    const net = F.esc(plan?.pay.networkName ?? "this network");
    return show(ctx, {
      text: [
        `How to pay less in fees: move some USDC from ${net} to a cheaper network once.`,
        "",
        `1. In the Tangem app, open your USDC on ${net}.`,
        "2. Tap Swap and pick USDC on a cheaper network, such as Arbitrum or Base (add that network in Tangem first if you don't see it).",
        "3. Approve it with your card.",
        "",
        "Next time AutoStack prepares a buy, it checks your USDC on that network too and suggests switching when it's cheaper.",
      ].join("\n"),
      keyboard: new InlineKeyboard(),
    });
  });

  // ---- History ----

  bot.callbackQuery(/^h:(\w+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, historyScreen(ctx.match[1], Number(ctx.match[2])));
  });

  bot.callbackQuery(/^hx:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const { entries } = historyFilter(ctx.match[1]);
    const csv = [
      "date,paid,received,coin,network,status",
      ...entries.map((e) =>
        [
          DateTime.fromMillis(e.createdAt, { zone: tz() }).toFormat("yyyy-MM-dd HH:mm"),
          `${e.paid} ${e.pay.symbol}`,
          e.received ?? (e.estimate ? `about ${e.estimate}` : ""),
          e.coin.symbol,
          e.coin.network,
          e.status,
        ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","),
      ),
    ].join("\n");
    await ctx.replyWithDocument(new InputFile(Buffer.from(csv + "\n"), "autostack-history.csv"));
  });

  // ---- Settings ----

  bot.callbackQuery(/^st:(\w+)(?::(\w+))?$/, async (ctx) => {
    const [, key, value] = ctx.match;
    await ctx.answerCallbackQuery();
    switch (key) {
      case "rem":
        E.updateSettings({ reminderHours: Number(value) });
        break;
      case "low":
        E.updateSettings({ lowUsdc: value === "1" });
        break;
      case "amt":
        E.updateSettings({ showAmounts: value === "1" });
        break;
      case "quiet":
        input = { kind: "quiet", msgId: ctx.callbackQuery.message.message_id };
        return show(ctx, { text: "Type your quiet hours as HH:MM-HH:MM, for example 23:00-08:00.", keyboard: new InlineKeyboard().text("Cancel", "nav:settings") });
      case "over":
        return show(ctx, {
          text: "Start over? This deletes all your plans and resets their streaks. Your history and wallet stay as they are.",
          keyboard: new InlineKeyboard().text("Yes, start over", "st:overy").text("Cancel", "nav:settings"),
        });
      case "overy":
        await E.startOver();
        return show(ctx, { text: "All plans deleted. Pick a coin in Markets to start again.", keyboard: new InlineKeyboard().text("Markets", "nav:markets") });
    }
    await show(ctx, settingsScreen());
  });

  // ---- Share cards ----

  async function shareCard(plan) {
    const progress = E.progressOf(plan);
    const streak = E.streakOf(plan);
    const words = F.periodWords(plan.schedule.freq);
    const goal = plan.stop?.type === "goal" ? plan.stop : null;
    const have = goal ? (goal.unit === "usd" ? progress.spent : progress.received) : null;
    const f = goal ? E.forecastOf(plan) : null;
    const coin = C.coinByKey(plan.coin.key) ?? plan.coin;
    let amountsLine = null;
    if (state.settings.showAmounts) {
      amountsLine = goal
        ? goal.unit === "usd" ? `${F.usd(have)} of ${F.goalLabel(goal, plan.coin.symbol)}` : `${F.amount(have)} of ${F.goalLabel(goal, plan.coin.symbol)}`
        : `${F.amount(progress.received)} ${plan.coin.symbol} stacked`;
    }
    return renderCard({
      coinSymbol: plan.coin.symbol,
      title: goal ? `Goal: ${F.goalLabel(goal, plan.coin.symbol)}` : `Stacking ${plan.coin.symbol}`,
      logoPath: coin.coingeckoId ? await ensureLogo({ coingeckoId: coin.coingeckoId, logoUrl: coin.logoUrl }) : null,
      percent: goal ? Math.min(100, (have / Number(goal.target)) * 100) : null,
      streak: streak.current,
      bestStreak: streak.best,
      periodWord: words.cardWord,
      onTrackDate: f?.date && plan.status === "active" ? F.shortDate(f.date, tz()) : null,
      amountsLine,
    });
  }

  bot.callbackQuery(/^sh:(\w+)$/, async (ctx) => {
    const plan = E.getPlan(ctx.match[1]);
    if (!plan) return ctx.answerCallbackQuery({ text: "That plan was deleted." });
    await ctx.answerCallbackQuery({ text: "Making your card…" });
    await ctx.replyWithChatAction("upload_photo");
    const png = await shareCard(plan);
    const username = bot.botInfo.username;
    const msg = await ctx.replyWithPhoto(new InputFile(png, "autostack.png"), {
      caption: `Forward this card, or post it in any chat by typing @${username} and a space.`,
    });
    const fileId = msg.photo?.at(-1)?.file_id;
    if (fileId) {
      state.cards.unshift({ fileId, planId: plan.id, at: Date.now() });
      state.cards.splice(20);
      save();
    }
  });

  bot.on("inline_query", async (ctx) => {
    const results = state.cards.slice(0, 10).map((c, i) => ({ type: "photo", id: `card${i}`, photo_file_id: c.fileId }));
    await ctx.answerInlineQuery(results, {
      cache_time: 0,
      is_personal: true,
      ...(results.length ? {} : { button: { text: "Make a share card first", start_parameter: "share" } }),
    });
  });

  // ---- Typed input ----

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const current = input;
    if (!current) return ctx.reply("Not sure what you mean. Try /start or /help.");
    const cleanup = () => ctx.deleteMessage().catch(() => {});
    if (current.kind === "search") {
      await cleanup();
      return handleSearch(ctx, text);
    }
    if (current.kind === "quiet") {
      const [start, end] = text.split(/\s*[-–]\s*/).map(parseTime);
      await cleanup();
      if (!start || !end) {
        return edit(current.msgId, "That didn't look right. Type your quiet hours as HH:MM-HH:MM, for example 23:00-08:00.", withMenu(new InlineKeyboard().text("Cancel", "nav:settings")));
      }
      input = null;
      E.updateSettings({ quiet: { start, end } });
      const s = settingsScreen();
      return edit(current.msgId, s.text, withMenu(s.keyboard));
    }
    if (current.kind === "form" && form) {
      await cleanup();
      const error = setFormValue(form, current.field, text);
      if (error) {
        form.error = error;
        return renderForm(form);
      }
      form.error = null;
      form.input = null;
      input = null;
      if (form.stop && form.sub) form.sub = null;
      return afterFormChange(form);
    }
    input = null;
    return ctx.reply("Not sure what you mean. Try /start or /help.");
  });

  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery({ text: "This button expired." }));

  bot.catch(async ({ ctx, error }) => {
    const text = errorText(error);
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: text.slice(0, 190), show_alert: true }).catch(() => ctx.reply(F.esc(text), html));
      } else {
        await ctx.reply(F.esc(text), html);
      }
    } catch (err) {
      console.error("Error reply failed:", err.message);
    }
  });

  // ---- Engine events ----

  const sym = (x) => F.esc(x.coin.symbol);

  const handlers = {
    async buyReady(entry, plan, { streakNotice, replaced, wasExpired } = {}) {
      const words = F.periodWords(plan.schedule.freq);
      const trade = `${F.amount(entry.paid)} ${F.esc(entry.pay.symbol)} → about ${F.amount(entry.estimate)} ${sym(entry)}`;
      let text;
      if (streakNotice) {
        text = [
          `You didn't buy ${words.last}, so your streak is back to 0 (best: ${streakNotice.best}).`,
          `${words.this} buy is ready. Approve any day to start again.`,
          "",
          trade,
          approveBlock(entry),
        ].join("\n");
      } else {
        text = [
          ...(wasExpired ? ["Your last request had expired, so here's a new one."] : []),
          "🟡 Your buy is ready",
          trade,
          approveBlock(entry),
        ].join("\n");
      }
      const msg = await sendWithLink(text, entry.link).catch((err) => {
        console.error("Buy message failed:", err.message);
        return null;
      });
      entry.messageId = msg?.message_id ?? null;
      save();
      if (replaced?.messageId) await edit(replaced.messageId, `Replaced by a fresh price below.\n${historyLine(replaced)}`);
    },

    async buyDone(entry, plan) {
      const kb = new InlineKeyboard();
      const lines = [];
      if (plan) {
        const progress = E.progressOf(plan);
        lines.push(`Done ✅ You now have ${F.amount(progress.received)} ${sym(plan)}`);
        const goal = goalLine(plan, true);
        if (goal) lines.push(goal);
        const streak = E.streakOf(plan);
        if (streak.current) lines.push(`🔥 ${F.streakText(plan.schedule.freq, streak.current, streak.best)}`);
        kb.text("Share", `sh:${plan.id}`).text("My plans", "navn:plans");
      } else {
        lines.push(`Done ✅ ${F.amount(entry.received ?? entry.estimate)} ${sym(entry)} bought`);
      }
      if (entry.reminderMessageId) await bot.api.deleteMessage(ownerId, entry.reminderMessageId).catch(() => {});
      const edited = entry.messageId && (await edit(entry.messageId, lines.join("\n"), kb));
      if (!edited) await notify(lines.join("\n"), { reply_markup: kb });
    },

    async buyMissed(entry, plan) {
      if (!entry.messageId) return;
      const that = F.periodWords(plan.schedule.freq).that;
      await edit(entry.messageId, `Missed: your ${sym(entry)} buy for ${that} wasn't approved in time. If you still approve it in Tangem, it counts when it completes.\n${approveBlock(entry)}`);
    },

    async buyExpired(entry) {
      const text = `Your ${sym(entry)} buy request expired before it was approved.`;
      const kb = new InlineKeyboard().text("Get a fresh price", `fr:${entry.id}`);
      if (!(entry.messageId && (await edit(entry.messageId, text, kb)))) await notify(text, { reply_markup: kb });
    },

    async buyFailed(entry) {
      const text = `❌ Your ${sym(entry)} buy didn't go through. Check the Tangem app for details.`;
      const kb = new InlineKeyboard().text("Get a fresh price", `fr:${entry.id}`);
      if (!(entry.messageId && (await edit(entry.messageId, text, kb)))) await notify(text, { reply_markup: kb });
    },

    async reminder(entry) {
      if (entry.reminderMessageId) await bot.api.deleteMessage(ownerId, entry.reminderMessageId).catch(() => {});
      const text = [`🔔 Your ${sym(entry)} buy is still waiting`, approveBlock(entry), "Price changed a lot?"].join("\n");
      const msg = await sendWithLink(text, entry.link, new InlineKeyboard().text("Get a fresh price", `fr:${entry.id}`)).catch((err) => {
        console.error("Reminder failed:", err.message);
        return null;
      });
      entry.reminderMessageId = msg?.message_id ?? null;
      save();
    },

    async goalReached(plan) {
      const entries = E.planEntries(plan).filter((e) => e.status === "COMPLETED" && e.completedAt >= (plan.progressFrom ?? 0));
      const progress = E.progressOf(plan);
      const avg = progress.received > 0 ? progress.spent / progress.received : null;
      const streak = E.streakOf(plan);
      const goal = F.esc(F.goalLabel(plan.stop, plan.coin.symbol));
      const what = plan.stop.unit === "usd" ? `${goal} invested in ${sym(plan)}` : `${goal} stacked`;
      const next = { ...plan.stop, target: String(Number(plan.stop.target) * 2) };
      const kb = new InlineKeyboard()
        .text("Share", `sh:${plan.id}`).text(`New goal: ${F.goalLabel(next, plan.coin.symbol)}`, `g:double:${plan.id}`).row()
        .text("Keep stacking, no goal", `g:none:${plan.id}`).text("Stop", `g:stop:${plan.id}`);
      await notify(`🎉 You did it: ${what}! Average price ${F.usd(avg)} · ${F.plural(entries.length, "buy")} · best streak ${streak.best}`, { reply_markup: kb });
    },

    async planFinished(plan) {
      const progress = E.progressOf(plan);
      const why = plan.finishedReason === "date" ? "reached its end date" : `is complete: ${F.plural(progress.buys, "buy")} done`;
      await notify(`Your ${sym(plan)} plan ${why}. You stacked ${F.amount(progress.received)} ${sym(plan)}.`, {
        reply_markup: new InlineKeyboard().text("Share", `sh:${plan.id}`).text("My plans", "navn:plans"),
      });
    },

    async planProblem(plan, note) {
      await notify(`Your ${sym(plan)} plan: ${F.esc(note)}`, { reply_markup: new InlineKeyboard().text("My plans", "navn:plans") });
    },

    async lowUsdc({ payToken, have, need, nextDue, uncounted, plans }) {
      const day = F.weekdayLong(nextDue, tz());
      const net = F.esc(payToken.networkName);
      const needText = plans.length > 1 ? `your plans need ${F.amount(need)} in the next 7 days` : `the plan needs ${F.amount(need)}`;
      const lines =
        have == null
          ? [`💳 Your USDC balance on ${net} can't be read, so it can't be checked before ${day}'s buy. ${needText[0].toUpperCase()}${needText.slice(1)}.`]
          : [`💳 Not enough USDC for ${day}'s buy. You have ${have.toFixed(2)} USDC on ${net}, ${needText}. Top up your USDC in Tangem before ${F.dayTime(nextDue, tz())}.`];
      if (uncounted.length) lines.push(`USDC on ${F.esc(uncounted.join(", "))} isn't counted (balance not available).`);
      await notify(lines.join("\n"));
    },

    async dip({ coin, pct, price, avg, plan }) {
      const kb = new InlineKeyboard();
      if (plan) kb.text("Buy now", `dip:buy:${plan.id}`);
      kb.text("OK", "dip:ok");
      await notify(`📉 ${F.esc(coin.symbol)} is ${pct}% below your average buy price. Now ${F.usd(price)} · your average ${F.usd(avg)}`, { reply_markup: kb });
    },

    async cheaperRoute(plan, { alt, currentFee, altFee }) {
      const kb = new InlineKeyboard()
        .text(`Use ${alt.networkName} USDC`, `cr:use:${plan.id}:${C.shortId(alt.key)}`)
        .text(`Keep ${plan.pay.networkName}`, `cr:keep:${plan.id}:${C.shortId(alt.key)}`);
      await notify(
        `💡 Cheaper way to buy ${sym(plan)}: pay with your USDC on ${F.esc(alt.networkName)}. Fees about ${F.usd(currentFee)} vs ${F.usd(altFee)}. This buy stays as it is; a switch applies from the next one.`,
        { reply_markup: kb },
      );
    },

    async moveTip(plan, { currentFee }) {
      const kb = new InlineKeyboard().text(`Keep ${plan.pay.networkName}`, `mv:keep:${plan.id}`).text("Show me how", `mv:how:${plan.id}`);
      await notify(
        `💡 Fees on your ${sym(plan)} buy are about ${F.usd(currentFee)}, more than 5% of ${F.amount(plan.amount)} USDC. Moving some USDC to a cheaper network once could lower the fees on every buy.`,
        { reply_markup: kb },
      );
    },

    async loginExpired() {
      if (loginExpiredSent) return;
      loginExpiredSent = true;
      await notify(LOGIN_EXPIRED);
    },
  };

  return { bot, handlers, notify };
}
