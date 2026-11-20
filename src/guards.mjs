// Safety rules. Pure functions, unit-tested. The AI layer can never bypass these.
import { formatUnits, getAddress, isAddress, parseUnits, zeroAddress } from "viem";
import { CORRIDORS, TOKENS } from "./config.mjs";

/** Resolves a corridor id ("usdt-cngn" default, "cngn-usdt") to its sell/buy tokens. */
export function getCorridor(id) {
  const key = String(id ?? "usdt-cngn").trim().toLowerCase();
  const c = CORRIDORS[key];
  if (!c) throw new Error(`Unknown corridor "${id}". Use one of: ${Object.keys(CORRIDORS).join(", ")}`);
  return { ...c, sellToken: TOKENS[c.sell], buyToken: TOKENS[c.buy] };
}

/** Amount in the corridor's sell token: "10", "$10", "₦14,400.50". At most 6 decimals. */
export function parseAmount(input) {
  return parseUsd(String(input ?? "").trim().replace(/^[₦$]/, "").replace(/,/g, ""));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** USD value (6-dp base units) of one receipts.jsonl entry. Older usdt-cngn entries only have usdtSpent. */
export function receiptUsdUnits(entry) {
  const v = entry?.usd ?? entry?.usdtSpent;
  if (v == null || !/^\d+(\.\d{1,6})?$/.test(String(v))) return 0n;
  return parseUnits(String(v), 6);
}

/** Sum of USD paid out by executed payouts (entries with a payout hash) in the 24 h before `now`. */
export function dailyUsedUnits(entries, now = Date.now()) {
  let sum = 0n;
  for (const e of entries ?? []) {
    if (!e?.hashes?.payout) continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || t <= now - DAY_MS || t > now + 60_000) continue;
    sum += receiptUsdUnits(e);
  }
  return sum;
}

/** Throws if adding `addUnits` (6-dp USD) to what was already paid in the last 24 h exceeds `cap` (USD string). */
export function assertDailyCap(usedUnits, addUnits, cap) {
  const capUnits = parseUnits(String(cap), 6);
  if (usedUnits + addUnits > capUnits) {
    throw new Error(
      `This payout (${formatUnits(addUnits, 6)} USD) would take the last 24 h total to ${formatUnits(usedUnits + addUnits, 6)} USD, ` +
      `over the daily cap of ${cap} USD (MAX_DAILY_USD). Nothing was sent.`,
    );
  }
}

/** Sum of USD paid to ONE recipient wallet by executed payouts in the 24 h before `now` (any source: contacts or registrations). */
export function walletUsedUnits(entries, recipient, now = Date.now()) {
  const who = String(recipient ?? "").toLowerCase();
  if (!who) return 0n;
  return dailyUsedUnits((entries ?? []).filter((e) => String(e?.recipient ?? "").toLowerCase() === who), now);
}

/** Throws if adding `addUnits` to what this wallet already received in the last 24 h exceeds `cap` (USD string). */
export function assertWalletCap(usedUnits, addUnits, cap) {
  const capUnits = parseUnits(String(cap), 6);
  if (usedUnits + addUnits > capUnits) {
    throw new Error(
      `This payout (${formatUnits(addUnits, 6)} USD) would take this wallet's last 24 h total to ${formatUnits(usedUnits + addUnits, 6)} USD, ` +
      `over the per-wallet cap of ${cap} USD (MAX_WALLET_DAILY_USD). Nothing was sent.`,
    );
  }
}

/**
 * A refusal that will never pass, however often it is retried (self-payment, blocked recipient, a registration that
 * does not check out onchain). Autopilot logs it and moves on instead of stopping.
 */
export function refusal(message) {
  return Object.assign(new Error(message), { permanent: true });
}

/** The payer of a deposit must not be the wallet that gets paid (no self-payment / wash). */
export function assertNotSelfPayment(payer, recipient) {
  if (!isAddress(String(payer ?? "")) || !isAddress(String(recipient ?? ""))) throw refusal("Payer or recipient is not a valid address");
  if (String(payer).toLowerCase() === String(recipient).toLowerCase()) {
    throw refusal("The payer and the recipient are the same wallet (self-payment). Not paid.");
  }
}

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
