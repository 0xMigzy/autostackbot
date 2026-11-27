# AutoStackBot

AutoStackBot is a Telegram bot for automatic crypto buys from your Tangem wallet:

- **DCA (recurring) buys:** buy a fixed amount every N minutes, hours, days or weeks, e.g. `/dca 10 USDC ETH 7d`.
- **Limit buys:** check the price every minute and buy once you would receive at least your minimum,
  e.g. `/limit 10 USDC BTC 0.0003`.

It works with any token pair Tangem Express can swap, as long as both tokens are in your Tangem wallet.
For each buy it asks every Express provider for a quote, picks the one that gives you the most, and prepares
the buy in Tangem. The bot sends you the amounts, the provider and an "Approve in Tangem" link, and the
Tangem app notifies you. When the buy completes or fails, the bot tells you.

**AutoStackBot never signs: you approve every buy in the Tangem app.**

Safety limits:

- At most 3 prepared buys per day, across all plans.
- `/pauseall` stops every plan at once; nothing is prepared while a plan or all plans are paused.
- A buy is prepared once and never retried automatically. If preparing fails, the plan stops and the bot tells you.
- Everything is paid out to your own address for that token.
- The bot answers only your Telegram account and ignores everyone else.

## Setup

1. Install Node.js 20.12 or newer from <https://nodejs.org>.
2. **Create the bot:** in Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name
   (e.g. AutoStackBot) and a username ending in `bot`. BotFather replies with a token like `123456789:AA…`.
3. **Get your user ID:** open [@userinfobot](https://t.me/userinfobot) and send any message. It replies with
   your numeric ID.
4. **Create `.env`:** copy `.env.example` to `.env` and fill in both values:

   ```
   TELEGRAM_BOT_TOKEN=<token from BotFather>
   TELEGRAM_OWNER_ID=<your numeric user ID>
   ```

   `.env` holds secrets: never share or commit it (it is in `.gitignore`).
5. Open your bot in Telegram and press **Start**, so it is allowed to message you.
6. In this folder, run:

   ```
   npm install
   npm start
   ```

7. **QR login:** a browser opens with a QR code. Scan it with your own Tangem app to log in.
   Then the bot starts and sends you "🟢 AutoStackBot is online".

Keep the terminal open: plans only run while AutoStackBot is running. Press Ctrl+C to stop; the bot sends
"🔴 AutoStackBot is offline". If the Tangem login expires, the bot tells you: restart AutoStackBot and scan the QR.

## Commands

| Command | What it does |
| --- | --- |
| `/wallet` | Your tokens and balances |
| `/quote 10 USDC SOL` | Best price now, the provider, and how many providers quoted |
| `/dca 10 USDC ETH 7d` | Buy every 7 days (`30m`, `12h`, `7d`, `1w`, …) |
| `/limit 10 USDC BTC 0.0003` | Buy once 10 USDC gets you at least 0.0003 BTC |
| `/plans` | Each plan with Run now · Edit size · Pause/Resume · Delete |
| `/history` | Last 10 buys and their status |
| `/pauseall`, `/resumeall` | Pause or resume every plan |

Tokens are given by symbol. If a symbol is on several networks in your wallet, the bot asks which one.
A new size from "Edit size" applies from the next buy.

Your plans and prepared buys are saved in `plans.json` and `history.json` in this folder.

`npm run inspect` saves the Tangem MCP tool schemas to `tangem-schemas.json` (for development).
