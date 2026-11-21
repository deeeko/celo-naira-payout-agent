# Celo Naira Payout Agent

An agent on **Celo mainnet** that converts between **USD₮** and **cNGN** (Nigerian naira stablecoin) on
**Textile FX** and pays an allow-listed recipient. It works in two corridors, can be paid through a
**payment link** that an **autopilot** settles automatically, and prints a **receipt** for every payout
that the payer can rate onchain.
Built for the *Agents Open for Business* hackathon, **Track 3: Stablecoin Corridors (Textile FX)**.

**Live site:** https://naira-payout.vercel.app/ (mirror: https://deeeko.github.io/celo-naira-payout-agent/) — a live quote for both corridors, payment
links, autopilot activity and receipts rebuilt from chain data, the agent's ERC-8004 identity and reviews,
its transactions with the attribution tag decoded from each one, and a tool to verify any Celo transaction's tag.

> Status: work in progress. The mainnet run, its transaction links and the named user are added below once they exist. Nothing here is claimed before it happens.

## What it does

| Corridor | Payer sends | Recipient gets | Amount typed in | Counted against the caps |
|---|---|---|---|---|
| `usdt-cngn` (default) | USD₮ | cNGN | USD₮ | the USD₮ sold |
| `cngn-usdt` | cNGN | USD₮ | naira (cNGN) | the USD₮ bought |
| `celo-cngn` (`pay` and `quote` only) | CELO (from the agent wallet) | cNGN | CELO | the USD₮ bought by the first swap |

**Pay in naira from CELO** (`celo-cngn`, `src/celo.mjs`). Textile has no CELO → cNGN pair, so this is **two swaps**
and **two Textile fees**: CELO → USD₮, then exactly the USD₮ that arrived → cNGN, then the cNGN received is paid out.
Each swap must clear Textile's minimum of about $1, so the first swap must preview at least 1.05 USD₮
(about 20 CELO at today's rate). The agent wallet always keeps `MIN_CELO_RESERVE` (default 2) CELO plus a 0.1 CELO gas
margin after selling, because CELO also pays its network fees. It is for direct owner payouts only: payment links,
"Get paid" registrations and autopilot refuse it. If the second swap or the payout fails after the first swap went
through, the agent stops and prints where the money is (for example "1.091835 USDT is in the agent wallet") and the exact
command that finishes the job: `node src/agent.mjs pay --to NAME --amount X --corridor usdt-cngn --execute`.

**One payout** (`pay`, `src/pay.mjs`), the same for both corridors:

1. Checks the recipient against the allow-list and the caps, and gets a free Textile FX preview. A dry run stops here.
2. With `--execute`: checks both tokens report 6 decimals, the wallet holds the amount and ~0.02 CELO, asks you to type `yes`, then gets a firm quote and checks it against the preview.
3. Approves exactly what the quote needs (resetting an old allowance first) and broadcasts Textile's swap. An expired quote is never sent.
4. Pays the recipient the *measured* balance change of the bought token, never more than the swap itself delivered.
5. Reads every transaction back from the chain, flags any missing the attribution tag, logs the payout to `receipts.jsonl` and prints a receipt link.

**Payment links and autopilot** (`src/requests.mjs`, `src/watch.mjs`):

1. `request --to ada --amount 5` adds a random 0.01–0.99 to the amount so it is unique among open requests (and within the per-payout cap), saves it in `requests.json` and prints the exact amount and a link: `https://naira-payout.vercel.app/pay.html#r=<token>`. The link carries only the public fields (name, amount, corridor, created, expiry, optional note).
2. The payer opens the link and sends exactly that amount to the agent from any Celo wallet ("Open in wallet", QR code, or by hand).
3. `watch --execute` reads ERC-20 Transfer events to the agent on USD₮ and cNGN (Forno `eth_getLogs`, at most 5000 blocks per query). A deposit matches an open request only if the token is the request's sell token, the value is the exact amount, and it arrived after the request was created and before it expired.
4. On a match it first runs the checks that send nothing: the contact in `contacts.json` and the allow-list, both caps (including the 24 h cap) and a live preview. If one fails it logs `preflight_failed`, records nothing and stops before that deposit, so the request stays open and the same deposit matches again once the owner fixes the cause and restarts `watch --execute`.
5. If the checks pass it saves the payer and deposit tx on the request **first**, then runs the normal payout for that request's contact, amount and corridor. Without `--execute` it prints what it would do and writes nothing.
6. If the payout itself then fails, the error is saved on the request and autopilot stops. `retry --request ID` re-runs that payout (a dry run unless `--execute`; `--execute` still asks you to type `yes` unless `--yes`). It refuses a request that is paid, has no recorded deposit or saved error, or already sent a swap or payout transaction.

**Receipts and reviews:** every executed payout prints and logs
`https://naira-payout.vercel.app/receipt.html#p=<payout>&s=<swap>[&r=<request>]`. The receipt page rebuilds
the payout, the swap, the effective rate and each transaction's tag from Celo in the browser. From it the payer can
rate the payout 1–5 stars with a `giveFeedback` transaction to the ERC-8004 Reputation Registry, sent from **their own
wallet**. The registry rejects ratings from the agent's owner or operators. The Agent page lists the ratings; "Verified
payer" is our own check that the reviewer has sent USD₮ or cNGN to the agent, since the registry cannot check that.

Every transaction the agent sends (reset, approval, swap, payout, identity registration) carries the attribution tag
`celo_7360953d1b53`, attached once where the wallet client is built (`src/chain.mjs`) using `@celo/attribution-tags`.

## Get paid: recipients register their own request (`src/registrations.mjs`)

Someone who wants to be paid (in naira from abroad, or in dollars) opens `get-paid.html` and sends one zero-value
transaction **from their own wallet** to the agent. Its input is `hex("NP1:" + JSON)` plus the attribution tag, with
JSON `{ "a": "5.03", "d": "usdt-cngn" | "cngn-usdt", "e": <expiry, unix seconds>, "n": "<name>", "m": "<note>" }`.
The recipient is the transaction's sender, proven by its signature, so it can't be mistyped. The name, note, amount
and wallet are public and permanent onchain. The link is `pay.html#tx=<registration hash>`.

1. `watch` reads registrations from Blockscout (`/addresses/<agent>/transactions?filter=to`, every page, failed
   transactions ignored) on every poll, and scans deposits only up to the block Blockscout has indexed, so a fresh
   registration is never missed.
2. Same-amount rule, shared with the site (ported from `site/assets/core.js` and cross-checked in
   `test/registrations.test.mjs`): among valid, unexpired registrations with the same corridor and exact amount, the
   earliest (block, then position) is **active**; later ones are **amount in use** and are never paid.
3. A deposit matches the active registration for its token and exact amount when it arrived at or after the
   registration and before its expiry (statuses are worked out at the deposit's own block time).
4. Before recording anything, the registration is read again over RPC (sender, content, block, position, time), and
   the checks run: the payer is not the recipient; the recipient is not the agent, an `own_wallets` entry, a token or
   ERC-8004 registry contract, or the zero address; per payout `MAX_USD`; rolling 24 h `MAX_DAILY_USD`; and per
   recipient wallet rolling 24 h `MAX_WALLET_DAILY_USD` (default 25).
   - Self-payment, a blocked recipient or a registration that doesn't check out is **refused**: logged as
     `refused_deposit`, not paid, and autopilot carries on. The deposit stays in the agent wallet.
   - A cap or a missing price stops autopilot without recording anything, exactly like owner requests.
5. The deposit is saved in `registrations-state.json` (git-ignored) **before** paying: one payout per registration.
   Then the normal payout runs and pays the bought token to the registration's sender.
6. A deposit that matches both an owner request and a registration is logged as `ambiguous_deposit` and never paid.
   `request` avoids the amounts of active registrations when it picks the cents.

```bash
node src/agent.mjs registrations                     # active | in-use | expired | invalid | received | paid
node src/agent.mjs retry --registration 0x<hash>     # DRY RUN of a failed registration payout (add --execute)
```

Owner requests (`requests.json`, `contacts.json`) work exactly as before.

## Receipt numbers

Every executed payout (`pay`, `watch`, `retry`) prints

```
Receipt NP-7F3A-91C2: https://naira-payout.vercel.app/receipt.html#NP-7F3A-91C2
```

The number is `NP-` plus the first 8 hex characters of the payout transaction hash, upper-case, so anyone can work
it out from the chain. It is stored as `receiptNo` in `receipts.jsonl` and on the paid request or registration.
The full `receipt.html#p=<payout>&s=<swap>` link is printed and stored too.

| Variable | Default | Controls |
|---|---|---|
| `MAX_WALLET_DAILY_USD` | `25` | Most USD paid to any one wallet in a rolling 24 h ("Get paid" payouts) |
| `REGISTRATIONS_STATE_FILE` | `registrations-state.json` (repo root) | "Get paid" deposits and payouts (written only with `--execute`) |
| `BLOCKSCOUT_API` | `https://celo.blockscout.com/api/v2` | Where registrations are discovered |

## Safety is enforced in code, not by the AI

| Rule | Where |
|---|---|
| Dry run by default. Real money moves only with `--execute`, and a manual payout also needs you to type `yes` (or `--yes`) | `src/pay.mjs` |
| Per-payout cap (`MAX_USD`, default 25). For `cngn-usdt` checked on the preview, the firm quote and the amount actually paid | `src/guards.mjs`, `src/pay.mjs` |
| Daily cap (`MAX_DAILY_USD`, default 100): USD value of executed payouts in `receipts.jsonl` over any rolling 24 h | `src/guards.mjs` |
| Recipient must be an allow-listed contact. The agent, the builder's own wallets, token and registry contracts and the zero address are blocked | `src/guards.mjs` |
| Aborts if the firm quote is more than 3% worse than the free preview (`MAX_SLIPPAGE_BPS`) or asks for more than the amount | `src/guards.mjs`, `src/pay.mjs` |
| Aborts if the quote expired during approval | `src/pay.mjs` |
| Approves exactly what the firm quote needs, on the sold token, to the quote's contract (built by the agent, not taken from the quote) | `src/pay.mjs` |
| Pays out the *measured* balance change, capped at what the swap delivered, never an assumed amount | `src/pay.mjs` |
| `request` refuses amounts whose cents suffix would pass `MAX_USD`, and naira links worth more than `MAX_USD` at the current preview | `src/requests.mjs`, `src/agent.mjs` |
| Autopilot pays only a deposit matching an open request the owner created (token, exact amount, time window) | `src/requests.mjs` |
| One payout per request: the deposit is saved on the request before paying | `src/watch.mjs` |
| Unmatched deposits are logged and never paid; the agent's own transfers (swap output) are ignored | `src/watch.mjs` |
| Autopilot checks contact, caps and price before recording a deposit; a failure records nothing, so the request is not used up | `src/watch.mjs`, `src/pay.mjs` |
| Autopilot stops on a payout error; the error is saved on the request and not retried automatically (the owner can run `retry`, which refuses once a swap or payout was sent) | `src/watch.mjs`, `src/agent.mjs` |
| `celo-cngn`: the USD₮ bought by swap 1 counts against `MAX_USD` and `MAX_DAILY_USD`, checked on the preview, the firm quote and the USD₮ actually received | `src/celo.mjs` |
| `celo-cngn`: refused below 1.05 USD₮ from swap 1 (Textile's ~$1 minimum per swap; about 20 CELO) | `src/guards.mjs`, `src/celo.mjs` |
| `celo-cngn`: refused unless the agent keeps `MIN_CELO_RESERVE` CELO (default 2) after selling plus a 0.1 CELO gas margin; checked in the dry run, before confirming and on the firm quote | `src/guards.mjs`, `src/celo.mjs` |
| `celo-cngn`: approves exactly what each firm quote needs (CELO on the GoldToken contract for swap 1, USD₮ for swap 2), resetting an old allowance first; each firm quote is checked against its own preview and never sent once expired | `src/celo.mjs` |
| `celo-cngn`: swap 2 sells exactly the USD₮ measured from swap 1 (balance change, capped by swap 1's transfers to the agent); the payout is the cNGN measured from swap 2 | `src/celo.mjs` |
| `celo-cngn`: a failure after swap 1 stops the run and prints where the funds are and the exact command to finish; every transaction sent (resets, approvals, both swaps, payout) is tag-checked, and any missing tag exits non-zero | `src/celo.mjs` |
| Private key lives in a file outside the repo, is never printed, and is git-ignored | `src/chain.mjs` |

The optional AI layer (`ask`) only returns a contact **name** and an **amount**. Code resolves the name to an
address and applies every rule above. With no API key it falls back to a plain parser, so the agent works without one.
Autopilot does not use the AI.

The website never holds keys and never moves the agent's money. The only transaction a page can ask for is the
payer's own rating, from the payer's wallet.

## Use

```bash
npm install
npm test                                   # unit tests: safety rules, tagging, links, matching, caps, retry, celo-cngn

node src/agent.mjs keygen                  # creates the agent wallet (key is never printed)
node src/agent.mjs status                  # balances, tag, caps, USD paid in the last 24 h, open requests
node src/agent.mjs quote --amount 10       # free live price, no wallet needed
node src/agent.mjs quote --corridor cngn-usdt --amount 14400
node src/agent.mjs quote --corridor celo-cngn --amount 20   # CELO -> USD₮ -> cNGN estimate (two previews)
node src/agent.mjs pay --to ada --amount 10             # DRY RUN
node src/agent.mjs ask "send $10 to ada"                # DRY RUN, plain language (usdt-cngn)
node src/agent.mjs pay --to ada --amount 10 --execute   # real, asks for confirmation
node src/agent.mjs pay --to ada --amount 20 --corridor celo-cngn   # DRY RUN: pay in naira from 20 CELO (two swaps)
node src/agent.mjs request --to ada --amount 5          # payment link with a unique amount
node src/agent.mjs requests                # list requests: open | received | paid | expired
node src/agent.mjs watch                   # autopilot DRY RUN: prints what it would pay
node src/agent.mjs watch --execute         # autopilot: pays matched requests
node src/agent.mjs retry --request r_ab12cd34   # DRY RUN of a failed autopilot payout (add --execute)
node src/agent.mjs register --execute      # ERC-8004 identity on Celo mainnet
node src/agent.mjs verify 0x<txhash>       # shows the attribution tag on-chain
```

| Command | Flags |
|---|---|
| `keygen` | — |
| `status` | — (needs the key file) |
| `quote` | `--amount N` (default 10 USD₮, ₦14,400 or 20 CELO), `--corridor ID` |
| `pay` | `--to NAME --amount N`, `--corridor ID` (incl. `celo-cngn`, amount in CELO, up to 6 decimals), `--execute`, `--yes` |
| `ask "TEXT"` | `--execute`, `--yes` (always `usdt-cngn`) |
| `request` | `--to NAME --amount N`, `--corridor ID`, `--note TEXT` (≤ 80 chars), `--hours H` (default 48, at most 168) |
| `requests` | — |
| `watch` | `--execute`, `--interval SECONDS` (default 15, minimum 5) |
| `retry` | `--request ID`, `--execute`, `--yes` (only a request with a recorded deposit, a saved error and no swap or payout sent) |
| `register` | `--repo URL`, `--execute` (needs the key file) |
| `verify <hash>` | — (needs the key file) |

`ID` is `usdt-cngn` (default) or `cngn-usdt`; `pay` and `quote` also take `celo-cngn` (`request` refuses it). `NAME` must be in `contacts.json` (case-insensitive).
Copy `contacts.example.json` to `contacts.json` and add the recipient (git-ignored).

Autopilot needs a computer that keeps `watch --execute` running with the key file; it pays only while running.
With `--execute` it saves its block cursor in `watch-state.json`, so after a restart it picks up deposits that arrived
while it was off. RPC errors back off up to 5 minutes; Ctrl+C stops cleanly between steps. A failed pre-flight check
(no price, a cap reached, a renamed contact) does not use up the request: nothing is recorded and the deposit matches
again on the next run. A payout that fails after the deposit was recorded is finished with `retry --request ID`.

## Configuration

| Variable | Default | Controls |
|---|---|---|
| `MAX_USD` | `25` | Largest single payout, in USD |
| `MAX_DAILY_USD` | `100` | Most USD paid out in any rolling 24 h |
| `MAX_SLIPPAGE_BPS` | `300` | Allowed gap between preview and firm quote (300 = 3%), per swap |
| `MIN_CELO_RESERVE` | `2` | CELO the agent wallet must still hold after a `celo-cngn` payout (it pays every network fee) |
| `CELO_GAS_MARGIN` | `0.1` | CELO set aside for the gas of a `celo-cngn` payout (up to 7 transactions), on top of the reserve |
| `ATTRIBUTION_CODE` | `celo_7360953d1b53` | Tag on every transaction (1–32 chars of a–z, 0–9, _) |
| `AGENT_ADDRESS` | `0x8a695cf54CB44753c8b784EB36d266f748617a1e` | Agent address used when there is no key file (`request`, dry-run `watch`) |
| `SITE_URL` | `https://naira-payout.vercel.app` | Site used in payment and receipt links |
| `CELO_AGENT_KEY_FILE` | `~/.celo-naira-agent/agent.json` | Agent private key, outside the repo |
| `CONTACTS_FILE` | `contacts.json` (repo root) | Allow-list and `own_wallets` |
| `RECEIPTS_FILE` | `receipts.jsonl` (repo root) | Executed payouts and unmatched deposits; the daily cap is counted from it |
| `REQUESTS_FILE` | `requests.json` (repo root) | Payment requests |
| `WATCH_STATE_FILE` | `watch-state.json` (repo root) | Autopilot block cursor (written only with `--execute`) |
| `CELO_RPC_URL` | Forno | RPC used by `watch` only (`src/watch.mjs`) |
| `TEXTILE_API` | `https://api.textilecredit.com/v2` | Textile FX RFQ endpoint |
| `ANTHROPIC_API_KEY` | not set | Optional, lets `ask` understand free-form requests |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model for `ask` (only with an API key) |

`contacts.json`, `receipts.jsonl`, `requests.json` and `watch-state.json` are git-ignored.

## How it follows the rules

- **Celo mainnet only.** Chain 42220. Textile's sandbox does not cover Celo, so the swap path is checked with free live previews and unit tests, and the real run uses a small amount.
- **No self-trading or arbitrage.** The agent makes one conversion per payout (two for `celo-cngn`, because Textile has no direct CELO → cNGN pair) and is not a market maker.
- **Independent users.** The payer and recipient are people outside the team whose wallets the builder did not fund (see *Status*).
- **ERC-8004 identity.** `src/register8004.mjs` registers the agent and writes its id back into the registration file. Payers can rate payouts in the ERC-8004 Reputation Registry.
- **Textile quotes without an API key.** A signed proof of wallet control (no funds moved) is sent only if Textile asks for it.

## Files

```
src/config.mjs        addresses, corridors, limits, tag, file paths
src/guards.mjs        safety rules: amounts, caps (per payout and 24 h), allow-list, slippage (unit-tested)
src/textile.mjs       Textile FX RFQ v2 client
src/pay.mjs           the payout flow, both stablecoin corridors
src/celo.mjs          pay in naira from CELO: two swaps (CELO -> USDT -> cNGN), gas reserve, recovery message
src/requests.mjs      payment requests: unique amounts, link encoding, deposit matching
src/watch.mjs         autopilot: watches deposits and pays matched requests
src/intent.mjs        plain-language request parser (optional AI)
src/register8004.mjs  ERC-8004 registration
src/chain.mjs         wallet and attribution-tagged client
src/agent.mjs         command line
test/                 unit tests (node --test)
site/                 the live site (GitHub Pages): overview, quote, transactions, agent (identity and reviews),
                      verify, docs, pay (payment links), autopilot (deposits and payouts), receipt (rebuilt from chain, rate a payout)
scripts/fetch-rate.mjs  refreshes the site's Textile FX rates (both corridors) every 30 min (read-only GitHub Action)
scripts/check-site.mjs  static checks run before every deploy
```

## Status (updated as it happens)

- [x] Agent built, 21 unit tests passing
- [x] Live Textile price preview on Celo mainnet works
- [x] ERC-8004 identity registered on Celo mainnet: agentId 10079, tags verified on-chain
  ([register](https://celoscan.io/tx/0x080d54275f02a722a3b0daa408f02a1af760e29f9e39092a9a48d22b964cf62e),
  [update URI](https://celoscan.io/tx/0x4a342d9d0c7417211839b75edf7a9343e461b3dbe101aa39e53e14a09e7df309))
- [x] Payment links, autopilot (`watch`), second corridor (`cngn-usdt`), receipts and reviews built
- [ ] Tagged mainnet run: USD₮ to cNGN to a named recipient
- [ ] Named user and what they used it for

License: MIT
