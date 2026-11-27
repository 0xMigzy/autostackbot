// The Telegram interface: commands, buttons and notifications. Only the owner gets answers.
import { Bot, GrammyError, InlineKeyboard } from "grammy";
import * as core from "./plans.js";

const STATUS_POLL_MS = 60_000;
const STATUS_WATCH_MS = 48 * 60 * 60_000; // stop following a buy after this long
const MAX_PENDING = 50;
const MESSAGE_LIMIT = 4000;
const UNITS = { m: 1, h: 60, d: 1440, w: 10080 };

export const HELP = [
  "AutoStackBot: automatic crypto buys from your Tangem wallet. You approve every one.",
  "/dca 10 USDC ETH 7d: buy every 7 days",
  "/limit 10 USDC BTC 0.0003: buy when the price is right",
  "/quote 10 USDC SOL: see the best price now",
  "/plans · /history · /wallet · /pauseall",
].join("\n");

export const COMMANDS = [
  { command: "start", description: "Start AutoStackBot" },
  { command: "help", description: "How to use AutoStackBot" },
  { command: "wallet", description: "Tokens and balances" },
  { command: "quote", description: "<amount> <from> <to>: best price now" },
  { command: "dca", description: "<amount> <from> <to> <every>: recurring buy" },
  { command: "limit", description: "<amount> <from> <to> <minReceive>: limit buy" },
  { command: "plans", description: "Your plans" },
  { command: "history", description: "Last 10 buys" },
  { command: "pauseall", description: "Pause every plan" },
  { command: "resumeall", description: "Resume every plan" },
];

const AMOUNT = /^(?:\d+\.?\d*|\.\d+)$/;

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** Friendly text for any error: login expired, a user/tool error message, or a generic failure. */
function errorText(err) {
  if (core.isAuthError(err)) return core.LOGIN_EXPIRED;
  if (err instanceof core.UserError || err instanceof core.ToolError) return err.message;
  console.error(err);
  return `Something went wrong: ${err?.message ?? err}`;
}

function parseEvery(text) {
  const match = /^(\d+)\s*([mhdw])$/i.exec(text ?? "");
  const minutes = match && Number(match[1]) * UNITS[match[2].toLowerCase()];
  if (!minutes) throw new core.UserError("Interval must look like 30m, 12h, 7d or 1w");
  return minutes;
}

function formatEvery(minutes) {
  for (const unit of ["w", "d", "h"]) {
    if (minutes % UNITS[unit] === 0) return `${minutes / UNITS[unit]}${unit}`;
  }
  return `${minutes}m`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function formatIn(iso) {
  let minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  const parts = [];
  for (const [unit, size] of [["d", 1440], ["h", 60], ["m", 1]]) {
    if (minutes >= size || (unit === "m" && !parts.length)) parts.push(`${Math.floor(minutes / size)}${unit}`);
    minutes %= size;
  }
  return parts.slice(0, 2).join(" ");
}

const symbolOf = (key, stored) => stored ?? core.cachedToken(key)?.symbol ?? key;

function planTitle(plan) {
  const from = symbolOf(plan.from, plan.fromSymbol);
  const to = symbolOf(plan.to, plan.toSymbol);
  return plan.type === "recurring"
    ? `🔁 DCA ${esc(plan.amount)} ${esc(from)} → ${esc(to)} every ${formatEvery(plan.everyMinutes)}`
    : `🎯 Limit ${esc(plan.amount)} ${esc(from)} → ${esc(to)} when ≥ ${esc(plan.minReceive)} ${esc(to)}`;
}

function planText(plan) {
  const lines = [`<b>${planTitle(plan)}</b>`];
  const fromNet = plan.fromNetwork ?? core.cachedToken(plan.from)?.networkName;
  const toNet = plan.toNetwork ?? core.cachedToken(plan.to)?.networkName;
  if (fromNet && toNet) lines.push(`Networks: ${esc(fromNet)} → ${esc(toNet)}`);
  const status =
    plan.status === "active" ? (plan.paused ? "⏸ paused" : "🟢 active")
    : plan.status === "done" ? "✅ done"
    : "⚠️ error";
  lines.push(`Status: ${status}`);
  if (plan.status === "active" && plan.type === "recurring") {
    lines.push(`Next buy: ${formatTime(plan.nextRunAt)} (in ${formatIn(plan.nextRunAt)})`);
  }
  if (plan.lastQuote) {
    lines.push(`Last quote: ${esc(plan.lastQuote.toAmount)} ${esc(symbolOf(plan.to, plan.toSymbol))} via ${esc(plan.lastQuote.providerName)}`);
  }
  if (plan.error) lines.push(`<i>${esc(plan.error)}</i>`);
  return lines.join("\n");
}

function planKeyboard(plan) {
  const kb = new InlineKeyboard();
  if (plan.status === "active") {
    if (!plan.paused) kb.text("▶️ Run now", `p:run:${plan.id}`);
    kb.text("✏️ Edit size", `p:edit:${plan.id}`).row();
    kb.text(plan.paused ? "▶️ Resume" : "⏸ Pause", `p:pause:${plan.id}`);
  }
  return kb.text("🗑 Delete", `p:del:${plan.id}`);
}

const STATUS_ICON = { COMPLETED: "✅", CREATED: "🕓", PENDING: "⏳" };
const statusIcon = (status) => STATUS_ICON[status] ?? (core.isFinalStatus(status) ? "❌" : "🔄");

function buyLine(entry) {
  const from = esc(symbolOf(entry.from, entry.fromSymbol));
  const to = esc(symbolOf(entry.to, entry.toSymbol));
  return `${esc(entry.amount)} ${from} → ~${esc(entry.toAmount)} ${to} via ${esc(entry.providerName)}`;
}

/** Splits lines into messages under Telegram's length limit. */
function chunks(lines) {
  const out = [""];
  for (const line of lines) {
    if (out.at(-1).length + line.length + 1 > MESSAGE_LIMIT) out.push("");
    out[out.length - 1] += (out.at(-1) ? "\n" : "") + line;
  }
  return out;
}

const tokenLabel = (t, siblings) =>
  `${t.symbol} · ${t.networkName}` +
  (siblings.filter((s) => s.networkId === t.networkId).length > 1 ? ` · …${t.contractAddress.slice(-6)}` : "");

export function createBot({ token, ownerId }) {
  const bot = new Bot(token);
  const html = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };

  // Pending commands waiting for a network pick, by short id.
  const pending = new Map();
  let nextPendingId = 1;
  // Plan whose size the next plain message sets.
  let awaitingAmount = null;
  // Plans with a Run now in flight, so a double tap cannot prepare two buys.
  const running = new Set();
  // Prepared buys being followed: intentId → { entry, messageId }.
  const watched = new Map();
  let watchTimer = null;
  let loginExpiredSent = false;

  async function notifyOwner(text, extra = {}) {
    try {
      return await bot.api.sendMessage(ownerId, text, { ...html, ...extra });
    } catch (err) {
      if (err instanceof GrammyError && /chat not found|bot was blocked/i.test(err.description)) {
        const username = bot.isInited() ? bot.botInfo.username : "<your bot>";
        console.error(`Cannot message you on Telegram: open https://t.me/${username} and press Start.`);
      } else {
        console.error("Telegram send failed:", err.message);
      }
      return null;
    }
  }

  // ---- Following prepared buys ----

  function watch(entry, messageId) {
    if (!entry.intentId || core.isFinalStatus(entry.status)) return;
    watched.set(entry.intentId, { entry, messageId });
  }

  async function pollWatched() {
    for (const [intentId, { entry, messageId }] of [...watched]) {
      let status;
      try {
        status = await core.intentStatus(intentId);
      } catch (err) {
        if (core.isAuthError(err)) return events.loginExpired();
        console.error(`Buy ${intentId}: status check failed:`, err.message);
        continue;
      }
      const reply = messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {};
      if (core.isFinalStatus(status)) {
        watched.delete(intentId);
        const text =
          status === "COMPLETED"
            ? `✅ <b>Buy completed</b>\n${buyLine(entry)}`
            : `❌ <b>Buy did not complete</b> (${esc(status)})\n${buyLine(entry)}\nCheck the Tangem app.`;
        await notifyOwner(text, reply);
      } else if (Date.now() - Date.parse(entry.time) > STATUS_WATCH_MS) {
        watched.delete(intentId);
        await notifyOwner(
          `🕓 Stopped following this buy after 48h (status ${esc(status)}):\n${buyLine(entry)}\nCheck the Tangem app.`,
          reply,
        );
      }
    }
  }

  // ---- Events from the plan module ----

  const events = {
    async buyPrepared(entry, plan) {
      const text = [
        `🛒 <b>Buy prepared</b> · ${planTitle(plan)}`,
        `Pay: ${esc(entry.amount)} ${esc(entry.fromSymbol)}${plan.fromNetwork ? ` (${esc(plan.fromNetwork)})` : ""}`,
        `Receive: ~${esc(entry.toAmount)} ${esc(entry.toSymbol)}${plan.toNetwork ? ` (${esc(plan.toNetwork)})` : ""}`,
        `Provider: ${esc(entry.providerName)}`,
        `Buys today: ${core.buysToday()} of ${core.DAILY_BUY_CAP}`,
        "",
        "Approve or ignore it in the Tangem app (it also sent you a notification).",
      ].join("\n");
      let message = entry.deeplink
        ? await bot.api
            .sendMessage(ownerId, text, { ...html, reply_markup: new InlineKeyboard().url("Approve in Tangem", entry.deeplink) })
            .catch((err) => {
              // Telegram only accepts http(s) and tg:// button links; then the deeplink goes in the text.
              if (!(err instanceof GrammyError && /url|button/i.test(err.description))) console.error("Telegram send failed:", err.message);
              return null;
            })
        : null;
      message ??= await notifyOwner(entry.deeplink ? `${text}\n\nApprove in Tangem: <code>${esc(entry.deeplink)}</code>` : text);
      watch(entry, message?.message_id);
    },
    async planError(plan) {
      await notifyOwner(`⚠️ <b>Plan stopped</b> · ${planTitle(plan)}\n${esc(plan.error)}`, {
        reply_markup: new InlineKeyboard().text("🗑 Delete", `p:del:${plan.id}`),
      });
    },
    async loginExpired() {
      if (loginExpiredSent) return;
      loginExpiredSent = true;
      await notifyOwner(`🔑 ${esc(core.LOGIN_EXPIRED)}`);
    },
  };

  // ---- Owner only ----

  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== ownerId) return; // everyone else is ignored silently
    if (ctx.message?.text?.startsWith("/")) awaitingAmount = null; // any command cancels an Edit size
    await next();
  });

  // ---- Token pick and command execution ----

  /** Resolves each symbol to a wallet token, asking with buttons when it is on several networks, then runs the command. */
  async function proceed(ctx, job) {
    for (const slot of ["from", "to"]) {
      if (job[slot].token) continue;
      const symbol = job[slot].symbol;
      const { all, usable } = await core.findTokens(symbol);
      if (!usable.length) {
        pending.delete(job.id);
        return ctx.reply(
          all.length
            ? `${esc(symbol)} is in your wallet only on networks Tangem Express can't swap.`
            : `Unknown token ${esc(symbol)}: it isn't in your Tangem wallet. See /wallet.`,
          html,
        );
      }
      if (usable.length === 1) {
        job[slot].token = usable[0];
        continue;
      }
      job[slot].choices = usable;
      const kb = new InlineKeyboard();
      usable.forEach((t, i) => kb.text(tokenLabel(t, usable), `pick:${job.id}:${slot}:${i}`).row());
      return ctx.reply(
        `${esc(usable[0].symbol)} is on several networks. Which one do you want to ${slot === "from" ? "pay with" : "receive"}?`,
        { ...html, reply_markup: kb },
      );
    }
    pending.delete(job.id);
    return job.run(ctx, job.from.token, job.to.token);
  }

  function startJob(ctx, fromSymbol, toSymbol, run) {
    const job = { id: (nextPendingId++).toString(36), from: { symbol: fromSymbol }, to: { symbol: toSymbol }, run };
    pending.set(job.id, job);
    if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    return proceed(ctx, job);
  }

  function parseTrade(ctx, usage, extra) {
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (args.length !== 3 + extra) throw new core.UserError(`Usage: ${usage}`);
    const [amount, from, to, last] = args;
    if (!AMOUNT.test(amount)) throw new core.UserError(`Amount must be a number such as 10 or 0.5. Usage: ${usage}`);
    return { amount, from, to, last };
  }

  // ---- Commands ----

  bot.command("start", (ctx) => ctx.reply(`👋 ${HELP}`));
  bot.command("help", (ctx) => ctx.reply(HELP));

  bot.command("wallet", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    const tokens = await core.loadWallet();
    const balances = await core.loadBalances(tokens);
    if (!tokens.length) return ctx.reply("Your Tangem wallet has no tokens yet.");
    const sorted = [...tokens].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.networkName.localeCompare(b.networkName));
    const lines = sorted.map((t) => {
      const balance = balances.get(t.key);
      const note = !t.expressSupported ? " <i>(no Express)</i>" : "";
      return `<b>${esc(t.symbol)}</b> · ${esc(t.networkName)}: ${balance != null ? esc(balance) : "—"}${note}`;
    });
    for (const text of chunks(["👛 <b>Wallet</b>", ...lines])) await ctx.reply(text, html);
  });

  bot.command("quote", async (ctx) => {
    const usage = "/quote <amount> <from> <to>, e.g. /quote 10 USDC SOL";
    const { amount, from, to } = parseTrade(ctx, usage, 0);
    await startJob(ctx, from, to, async (ctx, fromToken, toToken) => {
      await ctx.replyWithChatAction("typing");
      const q = await core.quote(fromToken.key, toToken.key, amount);
      if (!q.best) return ctx.reply(`❌ ${esc(q.error)}`, html);
      return ctx.reply(
        [
          `💱 <b>${esc(q.amount)} ${esc(q.from.symbol)} → ${esc(q.best.toAmount)} ${esc(q.to.symbol)}</b>`,
          `Networks: ${esc(q.from.networkName)} → ${esc(q.to.networkName)}`,
          `Best provider: ${esc(q.best.providerName)} (${esc(q.best.rateType)} rate)`,
          `${q.providersQuoted} of ${q.providersAsked} providers quoted`,
        ].join("\n"),
        html,
      );
    });
  });

  bot.command("dca", async (ctx) => {
    const usage = "/dca <amount> <from> <to> <every>, e.g. /dca 10 USDC ETH 7d";
    const { amount, from, to, last } = parseTrade(ctx, usage, 1);
    const everyMinutes = parseEvery(last);
    await startJob(ctx, from, to, async (ctx, fromToken, toToken) => {
      const plan = await core.createPlan({ type: "recurring", from: fromToken.key, to: toToken.key, amount, everyMinutes });
      return ctx.reply(`✅ Plan created\n\n${planText(plan)}`, { ...html, reply_markup: planKeyboard(plan) });
    });
  });

  bot.command("limit", async (ctx) => {
    const usage = "/limit <amount> <from> <to> <minReceive>, e.g. /limit 10 USDC BTC 0.0003";
    const { amount, from, to, last } = parseTrade(ctx, usage, 1);
    if (!AMOUNT.test(last)) throw new core.UserError(`minReceive must be a number such as 0.0003. Usage: ${usage}`);
    await startJob(ctx, from, to, async (ctx, fromToken, toToken) => {
      const plan = await core.createPlan({ type: "limit", from: fromToken.key, to: toToken.key, amount, minReceive: last });
      return ctx.reply(
        `✅ Plan created. I check the price every minute and prepare the buy once you'd get at least ${esc(last)} ${esc(toToken.symbol)}.\n\n${planText(plan)}`,
        { ...html, reply_markup: planKeyboard(plan) },
      );
    });
  });

  bot.command("plans", async (ctx) => {
    const plans = core.listPlans();
    if (!plans.length) return ctx.reply("No plans yet. Try /dca 10 USDC ETH 7d or /limit 10 USDC BTC 0.0003");
    const header = core.isPausedAll()
      ? "⏸ <b>All plans are paused.</b> /resumeall to resume."
      : `📋 <b>${plans.length} plan${plans.length > 1 ? "s" : ""}</b>`;
    await ctx.reply(`${header}\nBuys prepared today: ${core.buysToday()} of ${core.DAILY_BUY_CAP}`, html);
    for (const plan of plans) await ctx.reply(planText(plan), { ...html, reply_markup: planKeyboard(plan) });
  });

  bot.command("history", async (ctx) => {
    const items = core.listHistory(10);
    if (!items.length) return ctx.reply("No buys yet.");
    const lines = items.map(
      (e) => `${statusIcon(e.status)} ${esc(formatTime(e.time))} · ${buyLine(e)} · <b>${esc(e.status)}</b>`,
    );
    for (const text of chunks(["🧾 <b>Last buys</b>", ...lines])) await ctx.reply(text, html);
  });

  bot.command("pauseall", (ctx) => {
    core.setPausedAll(true);
    return ctx.reply("⏸ All plans paused. Nothing will be prepared until /resumeall.");
  });

  bot.command("resumeall", (ctx) => {
    core.setPausedAll(false);
    return ctx.reply("▶️ All plans resumed. Overdue DCA plans wait for their next slot.");
  });

  bot.command("cancel", (ctx) => ctx.reply("OK, nothing changed."));

  // ---- Buttons ----

  bot.callbackQuery(/^pick:(\w+):(from|to):(\d+)$/, async (ctx) => {
    const [, id, slot, index] = ctx.match;
    const job = pending.get(id);
    const token = job?.[slot].choices?.[Number(index)];
    if (!token || job[slot].token) return ctx.answerCallbackQuery({ text: "This choice expired. Send the command again." });
    job[slot].token = token;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`${esc(token.symbol)} on ${esc(token.networkName)} ✓`, html);
    await proceed(ctx, job);
  });

  /** Re-renders a plan message after a button press. */
  async function refreshPlan(ctx, plan) {
    await ctx.editMessageText(planText(plan), { ...html, reply_markup: planKeyboard(plan) }).catch((err) => {
      if (!(err instanceof GrammyError && /not modified/i.test(err.description))) throw err;
    });
  }

  bot.callbackQuery(/^p:(run|edit|pause|del|delyes|delno):(.+)$/, async (ctx) => {
    const [, action, id] = ctx.match;
    const plan = core.getPlan(id);
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "This plan no longer exists." });
      return ctx.editMessageReplyMarkup().catch(() => {});
    }
    switch (action) {
      case "run": {
        if (running.has(id)) return ctx.answerCallbackQuery({ text: "Already preparing this buy…" });
        running.add(id);
        await ctx.answerCallbackQuery({ text: "Getting the best quote and preparing the buy…" });
        try {
          await core.runNow(id);
        } catch (err) {
          // A plan that stopped with an error was already reported by planError.
          if (plan.status !== "error") await ctx.reply(`❌ ${esc(errorText(err))}`, html);
        } finally {
          running.delete(id);
        }
        return refreshPlan(ctx, plan);
      }
      case "edit":
        awaitingAmount = id;
        await ctx.answerCallbackQuery();
        return ctx.reply(
          `Send the new amount of ${esc(symbolOf(plan.from, plan.fromSymbol))} per buy (now ${esc(plan.amount)}). It applies from the next buy. /cancel to keep it.`,
          { ...html, reply_markup: { force_reply: true, input_field_placeholder: plan.amount } },
        );
      case "pause":
        core.togglePause(id);
        await ctx.answerCallbackQuery({ text: plan.paused ? "Paused" : "Resumed" });
        return refreshPlan(ctx, plan);
      case "del":
        await ctx.answerCallbackQuery();
        return ctx.editMessageText(`Delete this plan?\n\n${planText(plan)}`, {
          ...html,
          reply_markup: new InlineKeyboard().text("🗑 Yes, delete", `p:delyes:${id}`).text("Cancel", `p:delno:${id}`),
        });
      case "delyes":
        core.deletePlan(id);
        if (awaitingAmount === id) awaitingAmount = null;
        await ctx.answerCallbackQuery({ text: "Deleted" });
        return ctx.editMessageText(`🗑 Deleted: ${planTitle(plan)}`, html);
      case "delno":
        await ctx.answerCallbackQuery();
        return refreshPlan(ctx, plan);
    }
  });

  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery({ text: "This button expired." }));

  // ---- Edit size: the next plain message ----

  bot.on("message:text", async (ctx) => {
    if (!awaitingAmount) return ctx.reply("Not sure what you mean. /help");
    const amount = ctx.message.text.trim();
    if (!AMOUNT.test(amount)) return ctx.reply("That isn't a number. Send an amount such as 10 or 0.5, or /cancel.");
    try {
      const plan = await core.editPlanAmount(awaitingAmount, amount);
      awaitingAmount = null;
      return ctx.reply(
        `✅ New size ${esc(plan.amount)} ${esc(symbolOf(plan.from, plan.fromSymbol))}, from the next buy.\n\n${planText(plan)}`,
        { ...html, reply_markup: planKeyboard(plan) },
      );
    } catch (err) {
      if (err instanceof core.UserError && !/not found|done/i.test(err.message)) {
        return ctx.reply(`${esc(err.message)}. Send another amount, or /cancel.`, html);
      }
      awaitingAmount = null;
      throw err;
    }
  });

  bot.catch(async ({ ctx, error }) => {
    const text = errorText(error);
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: text.slice(0, 190), show_alert: true }).catch(() => ctx.reply(`❌ ${esc(text)}`, html));
      } else {
        await ctx.reply(`❌ ${esc(text)}`, html);
      }
    } catch (err) {
      console.error("Error reply failed:", err.message);
    }
  });

  return {
    bot,
    events,
    notifyOwner,
    /** Follows recent prepared buys from history, then every new one. */
    startWatching() {
      for (const entry of core.listHistory()) {
        if (Date.now() - Date.parse(entry.time) < STATUS_WATCH_MS) watch(entry);
      }
      let polling = false;
      watchTimer ??= setInterval(async () => {
        if (polling) return;
        polling = true;
        await pollWatched().finally(() => (polling = false));
      }, STATUS_POLL_MS);
    },
    stopWatching() {
      clearInterval(watchTimer);
      watchTimer = null;
    },
  };
}
