# Auto-Stack

Auto-Stack runs recurring buys and limit buys from your Tangem wallet, using the Tangem MCP server.

- **Recurring buy:** buy a fixed amount every N minutes, hours, days or weeks (for example 10 USDT → HYPE every week).
- **Limit buy:** check the price every minute and buy once you would receive at least your minimum.

For each buy, Auto-Stack compares every Express provider, picks the one that gives you the most,
and prepares the buy in Tangem. The Tangem app notifies you, and you approve or ignore the buy there.

**Auto-Stack never signs: you approve every buy in the Tangem app.**

Safety limits:

- At most 3 prepared buys per day, across all plans.
- "Pause all" stops every plan at once; nothing is prepared while it is on.
- A buy is prepared once and never retried automatically. If preparing fails, the plan stops with an error.
- Everything is paid out to your own address for that token.

## Setup

1. Install Node.js 20 or newer from <https://nodejs.org>.
2. In this folder, run:

   ```
   npm install
   npm start
   ```

3. Scan the QR code that appears with your own Tangem app to log in.
   Auto-Stack then opens at <http://localhost:3000>.

Keep the terminal open: plans only run while Auto-Stack is running.
If the Tangem login expires, stop Auto-Stack (Ctrl+C), run `npm start` again and scan the new QR code.

Your plans and prepared buys are saved in `plans.json` and `history.json` in this folder.

`npm run inspect` saves the Tangem MCP tool schemas to `tangem-schemas.json` (for development).

## Demo site

The Vercel site is a demo with sample data. It is not connected to any wallet and prepares no real buys.
To use your own wallet, run Auto-Stack on your computer as described above.
