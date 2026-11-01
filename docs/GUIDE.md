# Arthatula — the guide

Arthatula is a private money app for your phone and computer: log what
you spend, see where it went, keep a budget, and plan the months ahead.
Your copy runs on your own free Cloudflare account, so your numbers are
yours alone.

- [1. Get your own copy (5 minutes)](#1-get-your-own-copy-5-minutes)
- [2. Put it on your phone](#2-put-it-on-your-phone)
- [3. Your first ten minutes](#3-your-first-ten-minutes)
- [4. Finding your way around](#4-finding-your-way-around)
- [5. Turn on the AI (Gemini, Grok or others)](#5-turn-on-the-ai-gemini-grok-or-others)
- [6. Let your AI agent manage it (MCP)](#6-let-your-ai-agent-manage-it-mcp)
- [7. Getting updates](#7-getting-updates)
- [8. Bank sync (optional, technical)](#8-bank-sync-optional-technical)
- [9. Privacy and safety](#9-privacy-and-safety)
- [10. Help, something's wrong](#10-help-somethings-wrong)

---

## 1. Get your own copy (5 minutes)

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account
and a free [GitHub](https://github.com/signup) account. No credit card.

1. Click **Deploy to Cloudflare**:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nisarg0606/arthatula)

2. Sign in to Cloudflare and connect GitHub when asked. Cloudflare copies
   the project into your GitHub account.
3. It asks for **SETUP_SECRET**. Make up a long phrase (for example
   `purple-otter-wears-a-tiny-hat`) and **write it down** — you need it
   once, in step 5.
4. Leave everything else as it is and press **Deploy**. Cloudflare builds
   your app and creates its database. This takes a minute or two.
5. Open your app's address (it looks like
   `https://arthatula.<your-name>.workers.dev`). Enter the setup secret,
   then choose your **access code** — the password for your app, at
   least 12 characters. Each device stays signed in for 90 days.

That's it. There's no recovery for a forgotten access code, so keep it in
your password manager.

## 2. Put it on your phone

It works in any browser, but it feels like a real app from the Home Screen.

- **iPhone (Safari):** open your app → tap **Share** → **Add to Home
  Screen** → **Add**. Open it from the new icon; it runs full screen.
- **iPhone (Chrome):** tap **⋯** → **Add to Home Screen**.
- **Android (Chrome):** tap **⋮** → **Add to Home screen** (or
  **Install app**).

Sign in once on each device with your access code.

## 3. Your first ten minutes

1. **Tell it where you're starting.** Home → scroll to **Plan settings**
   at the bottom → enter today's balance in **Starting balance**. The app
   counts everything from today on top of it.
2. **Log something you spent today.** Tap the big **＋** in the middle
   of the tab bar, type what it was (for example "Coffee") and the amount,
   and tap **Add expense**. The category fills itself in.
3. **Set a budget.** Open **Budget**, pick a category, and type how much
   you want to spend on it each month.
4. **Look at Home.** "This month" shows what you've spent so far, what's
   left after bills, and whether each category is on pace.

## 4. Finding your way around

On a phone the bar at the bottom has the things you use most:

| Tab | What it's for |
|---|---|
| **Home** | Your overview: net worth, this month at a glance, alerts, the evening market recap, pace, charts and trends. You choose which cards show. |
| **Activity** | Every transaction. Search, filter, fix categories, and mark things reviewed. |
| **＋** | Add an expense. |
| **Budget** | How much you planned per category each month and how much is left. |
| **More** | Everything else (below). |

**More** opens a sheet with every section:

- **Accounts** — your bank and card accounts and their balances.
- **Cash flow** — money in vs out, month by month.
- **Recurring** — bills and subscriptions, and what's coming up.
- **Investments** — your brokerage and retirement accounts' value over
  time (from the daily balances your sync records), with an S&P 500 line to
  compare, and the evening **Market today** recap (see below).
- **Goals** — things you're saving for.
- **Splitwise** — your balances with friends (needs a Splitwise key in Settings).
- **Settings** — AI, Splitwise, market data, rules, categories, and security.
- **Month editor**, **Daily expenses**, **Cards**, **Bank** — the classic
  screens (on a computer, under **More** at the end of the tab bar): plan each month line by line, the daily expense log, credit-card
  statement cycles, and synced bank data.

Tips:

- Tap a category on Home to see exactly what it counted.
- **Heads up** on Home flags categories over budget and unusually big
  expenses from the last week.
- **Customize** (top of Home) picks which cards Home shows and their order.
  It's saved to your account, so every device gets the same layout.
  **Reset to default** brings everything back.
- In Budget, the **avg $…** chip is what you spent on average over the last
  three months. Tap it to plan that much.
- Give a category an emoji in **Settings → Categories** (tap the category).
- In lists, tap a row to edit it.
- The ◐ button at the top switches light and dark mode.
- The **eye** button next to it hides every amount (they show as `$•••`)
  so you can show the app to someone. Merchants, categories, dates and the
  shape of the charts stay visible. Tap it again to bring the numbers back;
  each device remembers its own setting.

### Market today (evening recap)

Every weekday after the US market closes, the app writes a short recap:
how the S&P 500, Nasdaq and Dow moved and what the day's headlines say
drove it. It shows on **Home** and **Investments**.

1. Get a free key at <https://finnhub.io/register> (copy it from the
   dashboard).
2. In your app: **Settings → Market data** → paste it → **Save key**.

The recap is written by your AI provider when one is set (only market
numbers and headlines are sent to it, never your balances); without one
you get a plain one-line version. It appears the first time you open the
app after 4:10 pm New York time. It's its own card on Home, so you can
hide or move it with **Customize**.

### Investments: connecting your brokerage

The **Investments** screen draws from the daily balances of your
investment accounts, so it fills in by itself once an account is there:

- **With bank sync (section 8):** link your brokerage (for example
  Robinhood, Fidelity or Vanguard) in Plaid the same way as your bank. If
  Plaid supports it (check your Plaid dashboard's institution list), its
  balance arrives every night and the graph grows day by day.
- **Without sync:** **Accounts → + Add account**, type **Investments**, and
  update its balance now and then. Each update adds a point to the graph.

The dashed **S&P 500** line compares your growth with the market from the
same starting value; it uses the Market today recaps, so it appears once
a few have been saved.

**Holdings** lists each stock, fund and cash position with its shares,
latest price, value and gain or loss against what you paid. They come
from the bank sync when it sends Plaid's investment holdings (needs
Plaid's Investments product on your Plaid account); a manual account
shows its balance only. Prices are the latest close your brokerage
reports, so they update once a day.

Don't use unofficial "Robinhood API" tools: they need your password and
break Robinhood's terms.

## 5. Turn on the AI (Gemini, Grok or others)

The AI sorts expenses into categories, answers questions in **Ask about
your budget** ("Can I afford $400 in January?"), and pre-checks bank
payments for you. Without it, the app sorts by keywords — everything
still works.

Pick one provider:

### Google Gemini (has a free tier)

1. Go to <https://aistudio.google.com/apikey> and sign in with Google.
2. Click **Create API key** and copy it.
3. In your app: **More → Settings → AI assistant**. Provider: **Google
   Gemini**. Paste the key and tap **Save**.

### xAI Grok

1. Go to <https://console.x.ai> and sign in.
2. Open **API Keys** → **Create API key**, and copy it. (xAI bills per
   use; add a little credit first.)
3. In your app: **More → Settings → AI assistant**. Provider: **xAI
   Grok**. Paste the key and tap **Save**. The model box can stay empty
   (it uses a fast, low-cost Grok model).

### OpenAI, OpenRouter, Groq, or another OpenAI-compatible service

1. Create an API key with the service.
2. In your app: **More → Settings → AI assistant**. Provider:
   **OpenAI-compatible**.
3. Fill in:
   - **API key** — your key.
   - **Model** — the model's name, e.g. `gpt-5-mini` (OpenAI) or
     `openai/gpt-5-mini` (OpenRouter).
   - **API base URL** — leave empty for OpenAI. For OpenRouter use
     `https://openrouter.ai/api/v1`; for Groq `https://api.groq.com/openai/v1`.
4. Tap **Save**.

The top of the app shows **✦ Grok: on** (or Gemini, or AI) when it's
working. Your key is stored only on your server and never shown again;
only its last four characters appear.

## 6. Let your AI agent manage it (MCP)

Your app is also an **MCP server**, so an AI agent you already use can
read your budget and add, change or delete expenses for you ("I spent
$18 on lunch", "what did I spend on groceries last month?", "how is my
food budget doing?").

**Step 1 — make a key for your agent.** In your app: **More → Settings →
Security → AI assistant (MCP) → Create MCP token**. It shows three things
once: the **address** (`https://<your-app>/api/mcp`), the **token**, and
a ready-made **config**. Copy them now; the token isn't shown again.

The token can only use the MCP tools: it can't open the app, change
settings or your access code. It appears in your sessions list with an
**MCP** badge — tap **Revoke** there to cut it off any time.

**Step 2 — connect your agent:**

- **Claude Code** — in a terminal:

  ```
  claude mcp add --transport http arthatula https://<your-app>/api/mcp --header "Authorization: Bearer <token>"
  ```

- **Cursor** — paste the config the app showed you into `.cursor/mcp.json`
  (or Cursor Settings → MCP → Add).
- **Claude Desktop** — its settings file only starts programs on your
  computer, so it reaches your app through a small bridge (needs
  [Node.js](https://nodejs.org)). Claude Desktop → Settings → Developer →
  **Edit Config**, add this, then restart Claude Desktop:

  ```json
  { "mcpServers": { "arthatula": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://<your-app>/api/mcp", "--header", "Authorization:${ARTHATULA_AUTH}"],
    "env": { "ARTHATULA_AUTH": "Bearer <token>" }
  } } }
  ```

- **Grok, Muse, or any other agent** — look for "add an MCP server" (it
  may be called a connector or tool). Choose **Streamable HTTP**, enter
  the address, and add a header `Authorization` with the value
  `Bearer <token>`. If your agent can only connect with a sign-in button
  (OAuth) and has no way to add a header, it can't connect yet.

To check Claude Code can reach it, run `claude mcp list`: your app should
say **✔ Connected**. Start a new Claude Code session to use it.

**Step 3 — try it.** Ask your agent: "Using Arthatula, how much have I
spent this month?" It should list what it found. Anything it adds shows
up in the app right away.

## 7. Getting updates

Your copy is yours: new versions of Arthatula don't reach it until you
say so.

1. Open your copy of the project on GitHub (Cloudflare created it in
   your account in step 1).
2. If GitHub shows **This branch is behind**, click **Sync fork** →
   **Update branch**.
3. Cloudflare notices and redeploys within a couple of minutes. Your data
   isn't touched.

## 8. Bank sync (optional, technical)

Arthatula can import your bank and card transactions through
[Plaid](https://plaid.com). This needs your own Plaid developer account
and a small program running on a computer that's always on, so it's for
people comfortable with a terminal. See the README's "Pairing the Plaid
sync script" and "What the app expects from the sync". Everything else in
the app works without it — you can add expenses by hand with **＋**.

## 9. Privacy and safety

- Your data lives in a database in **your** Cloudflare account. Nobody
  else's copy can read it — including the person who shared this app
  with you.
- The app is locked behind your access code. Manage signed-in devices in
  **Settings → Security**, and sign out any you don't recognize.
- If you turn on AI, the text of an expense (and for Ask, your question
  plus budget totals) is sent to the provider you chose. Without a key,
  nothing leaves your account.
- The market recap only asks Finnhub for public prices and headlines;
  nothing about you is sent to it. The AI that writes the recap gets
  only those numbers and headlines, never your balances.
- Showing the app to someone? Tap the **eye** button first. It only hides
  what's on screen: it doesn't lock the app, so don't hand over an
  unlocked phone.

## 10. Help, something's wrong

**"Setup is locked" when I open the app the first time.** The setup
secret wasn't set. Cloudflare dashboard → **Workers & Pages** → your app
→ **Settings → Variables and Secrets** → add a secret named
`SETUP_SECRET` → deploy again.

**I forgot the setup secret.** Set a new one the same way; it's only used
before an access code exists.

**I forgot my access code.** It can't be recovered. In the Cloudflare
dashboard you can delete the app's D1 database and deploy again to start
fresh (this erases your data — export it first from the Month editor if
you're still signed in somewhere).

**The badge says "Local only".** The app can't reach its database. Check
your connection and reload; if it stays, open the Cloudflare dashboard and
make sure the app has a D1 database bound as `DB`.

**The AI says my key is wrong.** Paste it again in Settings, check you
picked the right provider, and for Grok/OpenAI check your account has
credit.

**Market today says it couldn't get data.** "Check the key" means the
Finnhub key is wrong or was revoked: paste it again in **Settings →
Market data**. Other errors usually pass on their own; the app tries
again after 15 minutes.

**The Investments screen is empty.** It needs an account of type
**Investments** (see "Investments: connecting your brokerage"). The graph
needs at least two days of balances.

**On iPhone the page zooms or the bar is hard to tap.** Add the app to
your Home Screen (section 2): it then runs full screen, without Safari's
toolbar in the way.
