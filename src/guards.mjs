// Safety rules. Pure functions, unit-tested. The AI layer can never bypass these.
import { getAddress, isAddress, parseUnits, zeroAddress } from "viem";

/** "10", "$10", "10.5" -> "10" / "10.5". At most 6 decimals (USDT precision). */
export function parseUsd(input) {
  const t = String(input).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(t)) throw new Error(`Invalid amount: "${input}"`);
  if (parseUnits(t, 6) === 0n) throw new Error("Amount must be greater than zero");
  return t;
}

export function assertWithinCap(amount, cap) {
  if (parseUnits(amount, 6) > parseUnits(cap, 6)) {
    throw new Error(`Amount ${amount} exceeds the per-payout cap of ${cap} USD (MAX_USD)`);
  }
}

/** contacts.json: { "contacts": { "ada": "0x..." }, "own_wallets": ["0x..."] } */
export function parseContacts(raw) {
  const contacts = new Map();
  for (const [name, addr] of Object.entries(raw?.contacts ?? {})) {
    if (!isAddress(addr)) throw new Error(`Contact "${name}" has an invalid address`);
    contacts.set(name.trim().toLowerCase(), getAddress(addr));
  }
  const own = (raw?.own_wallets ?? []).map((a) => {
    if (!isAddress(a)) throw new Error("own_wallets contains an invalid address");
    return getAddress(a);
  });
  return { contacts, own };
}

export function resolveContact(name, contacts) {
  const addr = contacts.get(String(name ?? "").trim().toLowerCase());
  if (!addr) {
    const known = [...contacts.keys()].join(", ") || "(none)";
    throw new Error(`Unknown recipient "${name}". Known contacts: ${known}`);
  }
  return addr;
}

/**
 * The recipient must be an explicitly allow-listed contact, and must not be the agent itself,
 * one of the builder's own wallets, a token/registry contract, or the zero address.
 * (Hackathon rule too: self-payments and own wallets do not count as independent users.)
 */
export function assertRecipient(recipient, { agent, own = [], blocked = [] }) {
  if (!isAddress(recipient)) throw new Error("Recipient is not a valid address");
  const r = getAddress(recipient);
  // Compare lowercase. (Never `.map(getAddress)`: viem would read the array index as a chain id
  // and change the checksum, so letters-containing addresses would silently fail to match.)
  const deny = new Set([zeroAddress, agent, ...own, ...blocked].filter(Boolean).map((a) => String(a).toLowerCase()));
  if (deny.has(r.toLowerCase())) throw new Error("Recipient is blocked (agent, own wallet or contract)");
  return r;
}

/** Abort if the firm quote pays out materially less than the free preview promised. */
export function assertSlippage(previewBuy, firmBuy, maxBps) {
  const p = BigInt(previewBuy);
  const f = BigInt(firmBuy);
  if (p === 0n) throw new Error("Preview returned zero output");
  const shortfallBps = p > f ? ((p - f) * 10000n) / p : 0n;
  if (shortfallBps > BigInt(maxBps)) {
    throw new Error(`Firm quote is ${shortfallBps} bps worse than the preview (limit ${maxBps}). Aborting.`);
  }
}
