# Celo Naira Payout Agent

An agent that pays out in **cNGN** (Nigerian naira stablecoin) on **Celo mainnet**.
A payer sends USD₮ to the agent; the agent converts it on **Textile FX** and pays the recipient in cNGN.
Built for the *Agents Open for Business* hackathon, **Track 3: Stablecoin Corridors (Textile FX)**.

**Live site:** https://deeeko.github.io/celo-naira-payout-agent/ — a live quote, the agent's ERC-8004 identity,
its transactions with the attribution tag decoded from each one, and a tool to verify any Celo transaction's tag.

> Status: work in progress. The mainnet run, its transaction links and the named user are added below once they exist. Nothing here is claimed before it happens.

## The job it does

Sending money to Nigeria is slow and expensive. This agent does one narrow job:

1. A payer sends USD₮ to the agent's wallet on Celo.
2. The agent asks Textile FX for a price (USD₮ to cNGN), checks it, and swaps.
3. It sends exactly what the swap delivered to an **allow-listed recipient** in Nigeria.
4. The recipient can cash cNGN out to naira (for example via cngn.co).

Every transaction (approval, swap, payout, identity registration) carries the attribution tag
`celo_7360953d1b53`, attached once where the wallet client is built (`src/chain.mjs`) using
`@celo/attribution-tags`. After each payout the agent reads every transaction it sent back from the chain,
flags any that is missing the tag, and exits with an error if one is.

## Safety is enforced in code, not by the AI

| Rule | Where |
|---|---|
| Dry run by default. Real money moves only with `--execute` and typing `yes` | `src/pay.mjs` |
| Per-payout cap (`MAX_USD`, default 25) | `src/guards.mjs` |
| Recipient must be an allow-listed contact. The agent, the builder's own wallets, token contracts and the zero address are blocked | `src/guards.mjs` |
| Aborts if the firm quote is more than 3% worse than the free preview | `src/guards.mjs` |
| Aborts if the quote expired during approval | `src/pay.mjs` |
| Approves exactly the USD₮ the firm quote needs, to the quote's contract (built by the agent, not taken from the quote) | `src/pay.mjs` |
| Pays out the *measured* cNGN balance change, never an assumed amount | `src/pay.mjs` |
| Private key lives in a file outside the repo, is never printed, and is git-ignored | `src/chain.mjs` |

The optional AI layer (`ask`) only returns a contact **name** and an **amount**. Code resolves the name to an
address and applies every rule above. With no API key it falls back to a plain parser, so the agent works without one.

## Use

```bash
npm install
npm test                                   # unit tests for the safety rules and tagging

node src/agent.mjs keygen                  # creates the agent wallet (key is never printed)
node src/agent.mjs status                  # balances, tag and cap
node src/agent.mjs quote --amount 10       # free live price, no wallet needed
node src/agent.mjs pay --to ada --amount 10             # DRY RUN
node src/agent.mjs ask "send $10 to ada"                # DRY RUN, plain language
node src/agent.mjs pay --to ada --amount 10 --execute   # real, asks for confirmation
node src/agent.mjs register --execute      # ERC-8004 identity on Celo mainnet
node src/agent.mjs verify 0x<txhash>       # shows the attribution tag on-chain
```

Copy `contacts.example.json` to `contacts.json` and add the recipient (git-ignored).

## How it follows the rules

- **Celo mainnet only.** Chain 42220. Textile's sandbox does not cover Celo, so the swap path is checked with free live previews and unit tests, and the real run uses a small amount.
- **No self-trading or arbitrage.** The agent makes one conversion per payout and is not a market maker.
- **Independent users.** The payer and recipient are people outside the team whose wallets the builder did not fund (see *Status*).
- **ERC-8004 identity.** `src/register8004.mjs` registers the agent and writes its id back into the registration file.
- **Textile quotes without an API key.** A signed proof of wallet control (no funds moved) is sent only if Textile asks for it.

## Files

```
src/config.mjs        addresses, limits, tag
src/guards.mjs        safety rules (unit-tested)
src/textile.mjs       Textile FX RFQ v2 client
src/pay.mjs           the payout flow
src/intent.mjs        plain-language request parser (optional AI)
src/register8004.mjs  ERC-8004 registration
src/chain.mjs         wallet and attribution-tagged client
src/agent.mjs         command line
site/                 the live site (GitHub Pages): overview, quote, transactions, agent, verify, docs
scripts/fetch-rate.mjs  refreshes the site's Textile FX rate every 30 min (read-only GitHub Action)
```

## Status (updated as it happens)

- [x] Agent built, 8 unit tests passing
- [x] Live Textile price preview on Celo mainnet works
- [x] ERC-8004 identity registered on Celo mainnet: agentId 10079, tags verified on-chain
  ([register](https://celoscan.io/tx/0x080d54275f02a722a3b0daa408f02a1af760e29f9e39092a9a48d22b964cf62e),
  [update URI](https://celoscan.io/tx/0x4a342d9d0c7417211839b75edf7a9343e461b3dbe101aa39e53e14a09e7df309))
- [ ] Tagged mainnet run: USD₮ to cNGN to a named recipient
- [ ] Named user and what they used it for

License: MIT
