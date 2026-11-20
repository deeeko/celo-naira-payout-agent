// Central, auditable configuration. Everything that touches money lives here or in guards.mjs.
import os from "node:os";
import path from "node:path";
import { celo } from "viem/chains";

export const CHAIN = celo; // Celo mainnet, chain id 42220. This event only counts mainnet.

export const TEXTILE_API = process.env.TEXTILE_API ?? "https://api.textilecredit.com/v2";

// Token addresses from the official Agents Open for Business page (Celo mainnet).
export const TOKENS = {
  USDT: { symbol: "USDT", address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6 },
  CNGN: { symbol: "cNGN", address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f" },
};

// ERC-8004 Identity Registry on Celo mainnet (docs.celo.org/build/agents/8004).
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

// Issued by Loops House when the entry was created. A public code, not a secret.
export const ATTRIBUTION_CODE = process.env.ATTRIBUTION_CODE ?? "celo_7360953d1b53";
if (!/^[a-z0-9_]{1,32}$/.test(ATTRIBUTION_CODE)) {
  throw new Error("ATTRIBUTION_CODE must be 1-32 chars of a-z, 0-9, _");
}

// Hard ceiling per payout in USD. Enforced in code, never delegated to the AI layer.
export const MAX_USD = process.env.MAX_USD ?? "25";

// Max allowed gap between the free preview and the firm quote (basis points).
export const MAX_SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS ?? 300);

const root = path.join(import.meta.dirname, "..");
export const KEY_FILE =
  process.env.CELO_AGENT_KEY_FILE ?? path.join(os.homedir(), ".celo-naira-agent", "agent.json");
export const CONTACTS_FILE = process.env.CONTACTS_FILE ?? path.join(root, "contacts.json");
export const LOG_FILE = path.join(root, "receipts.jsonl");
