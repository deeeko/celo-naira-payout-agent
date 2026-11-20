// Central, auditable configuration. Everything that touches money lives here or in guards.mjs.
import os from "node:os";
import path from "node:path";
import { celo } from "viem/chains";

export const CHAIN = celo; // Celo mainnet, chain id 42220. This event only counts mainnet.

export const TEXTILE_API = process.env.TEXTILE_API ?? "https://api.textilecredit.com/v2";

// Token addresses from the official Agents Open for Business page (Celo mainnet).
// Both tokens use 6 decimals on Celo (cNGN's is also re-checked on-chain before any real payout).
export const TOKENS = {
  USDT: { symbol: "USDT", address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6 },
  CNGN: { symbol: "cNGN", address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f", decimals: 6 },
};

// The two supported corridors (same ids as site/assets/core.js CORRIDORS).
// The amount a user types is always in the SELL token. `usd` says how the USD value used for the caps is measured.
export const CORRIDORS = {
  "usdt-cngn": { id: "usdt-cngn", sell: "USDT", buy: "CNGN", usd: "sell", blurb: "pay someone in naira" },
  "cngn-usdt": { id: "cngn-usdt", sell: "CNGN", buy: "USDT", usd: "buy", blurb: "pay someone in dollars" },
};
export const DEFAULT_CORRIDOR = "usdt-cngn";

// ERC-8004 Identity Registry on Celo mainnet (docs.celo.org/build/agents/8004).
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
// ERC-8004 Reputation Registry (proxy) on Celo mainnet. Never a payout recipient.
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

// The deployed agent's public address. Used by `watch` in dry-run mode when no key file is present.
export const AGENT_ADDRESS = process.env.AGENT_ADDRESS ?? "0x8a695cf54CB44753c8b784EB36d266f748617a1e";

// Issued by Loops House when the entry was created. A public code, not a secret.
export const ATTRIBUTION_CODE = process.env.ATTRIBUTION_CODE ?? "celo_7360953d1b53";
if (!/^[a-z0-9_]{1,32}$/.test(ATTRIBUTION_CODE)) {
  throw new Error("ATTRIBUTION_CODE must be 1-32 chars of a-z, 0-9, _");
}

// Hard ceiling per payout in USD. Enforced in code, never delegated to the AI layer.
export const MAX_USD = process.env.MAX_USD ?? "25";
// Hard ceiling on the USD value paid out in any rolling 24 hours (computed from receipts.jsonl).
export const MAX_DAILY_USD = process.env.MAX_DAILY_USD ?? "100";
// Hard ceiling on the USD value paid to any ONE wallet in a rolling 24 hours ("Get paid" registrations).
export const MAX_WALLET_DAILY_USD = process.env.MAX_WALLET_DAILY_USD ?? "25";

// Blockscout API, used to discover "Get paid" registrations (transactions TO the agent).
export const EXPLORER_API = (process.env.BLOCKSCOUT_API ?? "https://celo.blockscout.com/api/v2").replace(/\/+$/, "");

// Max allowed gap between the free preview and the firm quote (basis points).
export const MAX_SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS ?? 300);

// Public site that renders payment links and receipts.
export const SITE_URL = (process.env.SITE_URL ?? "https://deeeko.github.io/celo-naira-payout-agent").replace(/\/+$/, "");

const root = path.join(import.meta.dirname, "..");
export const KEY_FILE =
  process.env.CELO_AGENT_KEY_FILE ?? path.join(os.homedir(), ".celo-naira-agent", "agent.json");
export const CONTACTS_FILE = process.env.CONTACTS_FILE ?? path.join(root, "contacts.json");
export const LOG_FILE = process.env.RECEIPTS_FILE ?? path.join(root, "receipts.jsonl");
export const REQUESTS_FILE = process.env.REQUESTS_FILE ?? path.join(root, "requests.json");
export const WATCH_STATE_FILE = process.env.WATCH_STATE_FILE ?? path.join(root, "watch-state.json");
export const REGISTRATIONS_STATE_FILE = process.env.REGISTRATIONS_STATE_FILE ?? path.join(root, "registrations-state.json");
