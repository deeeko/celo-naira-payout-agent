// nTags: human handles (@ada) tied to a Celo wallet, claimed onchain from the owner's own wallet (site/account.html).
// A claim is a zero-value tx FROM the wallet TO the agent whose input is hex(utf8("NT1:" + JSON)) + attribution suffix,
// JSON {"t":"ada"} or {"t":"ada","n":"Ada Obi"}; {"t":""} releases the sender's tag. Paying a tag is an ordinary
// ERC-20 transfer to the agent with hex(utf8("NTP:" + tag)) appended after the standard 68 bytes. See site/_spec/NTAGS.md.
//
// Everything between the "ported" markers is a byte-identical copy of the nTags section of site/assets/core.js
// (test/ntags.test.mjs cross-checks them), so the site and the agent always agree on who owns a tag.
import fs from "node:fs";
import path from "node:path";
import { getAddress } from "viem";
import { AGENT_ADDRESS, ATTRIBUTION_CODE, EXPLORER_API, NTAG_PAYMENTS_FILE } from "./config.mjs";
import { refusal } from "./guards.mjs";

const AGENT = AGENT_ADDRESS;
const MARKER = "80218021802180218021802180218021"; // ERC-8021 suffix marker
const utf8Hex = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
const hexBytes = (h) => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
/** The ERC-8021 schema-0 suffix for this app's attribution code (same bytes as core.js tagSuffix()). */
export const tagSuffix = () => utf8Hex(ATTRIBUTION_CODE) + ATTRIBUTION_CODE.length.toString(16).padStart(2, "0") + "00" + MARKER;

// ---------- port: start ---------- (from site/assets/core.js; keep byte-for-byte identical)
export const NTAG_PREFIX = "NT1:";
export const NTAG_MEMO_PREFIX = "NTP:";
export const RELEASE_LOCK_DAYS = 30;
/** Tags nobody can claim. */
export const NTAG_RESERVED = new Set([
  "agent", "admin", "administrator", "root", "system", "support", "help", "official", "team", "staff", "mod", "moderator",
  "security", "celo", "minipay", "valora", "opera", "textile", "naira", "nairapayout", "payout", "payouts", "ntag", "ntags",
  "cngn", "usdt", "usdc", "tether", "cusd", "ceur", "wallet", "bank", "cbn", "null", "undefined", "anonymous", "everyone",
  "me", "you", "test", "demo", "api", "www", "app", "pay", "send", "receive",
]);
const NTAG_RESERVED_ERR = "this tag is reserved";
const NTAG_LOCK_SEC = RELEASE_LOCK_DAYS * 86400;
/** UI/CLI input only: trim, strip one leading "@", lowercase. The onchain JSON must already be in this form. */
export const normalizeNtag = (s) => String(s ?? "").trim().replace(/^@/, "").toLowerCase();
/** Tag rules (3-20 chars, a-z 0-9 _, starts with a letter, no "__", no trailing "_", not reserved). Error string or null. */
export function ntagError(t) {
  if (typeof t !== "string" || !t) return "enter a tag";
  if (/[A-Z]/.test(t)) return "use lowercase letters only";
  if (!/^[a-z0-9_]+$/.test(t)) return "use only letters, numbers and _";
  if (!/^[a-z]/.test(t)) return "must start with a letter";
  if (t.length < 3) return "must be at least 3 characters";
  if (t.length > 20) return "must be 20 characters or fewer";
  if (t.includes("__")) return "can't contain __";
  if (t.endsWith("_")) return "can't end with _";
  if (NTAG_RESERVED.has(t)) return NTAG_RESERVED_ERR;
  return null;
}
/** Display name rules (optional; 1-40 characters after trimming, no control characters). Error string or null. */
export function ntagNameError(n) {
  if (typeof n !== "string") return "invalid name";
  const v = n.trim();
  if (!v) return "name can't be blank";
  if (v.length > 40) return "name must be 40 characters or fewer";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) return "name can't contain control characters";
  return null;
}
/** Validates a decoded nTag op body: claim {t[,n]} or release {t:""}. Error string or null. */
export function ntagOpError(op) {
  if (!op || typeof op !== "object" || Array.isArray(op)) return "not an nTag op";
  const keys = Object.keys(op);
  if (keys.some((k) => k !== "t" && k !== "n")) return "unexpected field";
  if (typeof op.t !== "string") return "invalid tag";
  if (op.t === "") return "n" in op ? "a release has no name" : null;
  const err = ntagError(op.t);
  if (err) return err;
  if ("n" in op) return ntagNameError(op.n);
  return null;
}
const stripErc8021 = (input) => {
  let h = String(input ?? "").toLowerCase().replace(/^0x/, "");
  if (h.endsWith(MARKER)) {
    const len = parseInt(h.slice(-MARKER.length - 4, -MARKER.length - 2), 16);
    h = h.slice(0, -(MARKER.length + 4 + len * 2));
  }
  return h;
};
/** Calldata for a claim tx: hex("NT1:" + JSON) + this app's attribution suffix. Throws on an invalid tag or name. */
export function encodeNtagClaim({ t, n } = {}) {
  const name = typeof n === "string" ? n.trim() : n;
  const body = name ? { t, n: name } : { t };
  const err = body.t === "" ? "enter a tag" : ntagOpError(body);
  if (err) throw new Error(err);
  return "0x" + utf8Hex(NTAG_PREFIX + JSON.stringify(body)) + tagSuffix();
}
/** Calldata for a release tx (gives up the sender's current tag). */
export const encodeNtagRelease = () => "0x" + utf8Hex(NTAG_PREFIX + JSON.stringify({ t: "" })) + tagSuffix();
/** Parse a tx input as an nTag op (any trailing ERC-8021 suffix stripped). Returns the parsed JSON (unvalidated) or null. */
export function decodeNtagOp(input) {
  const h = stripErc8021(input);
  if (!h.startsWith(utf8Hex(NTAG_PREFIX))) return null;
  try { return JSON.parse(new TextDecoder().decode(hexBytes(h.slice(utf8Hex(NTAG_PREFIX).length)))); } catch { return null; }
}
/** Blockscout transaction item -> op item { hash, from, block, position, time, value, op }, or null (same filter as registrations). */
export function ntagOpFromItem(t, agent) {
  if (t?.status !== "ok" || t.to?.hash?.toLowerCase() !== String(agent).toLowerCase()) return null;
  const op = decodeNtagOp(t.raw_input);
  if (op == null) return null;
  return { hash: t.hash, from: t.from?.hash, block: Number(t.block_number ?? t.block), position: Number(t.position ?? 0), time: Math.floor(Date.parse(t.timestamp) / 1000), value: t.value == null ? "0" : String(t.value), op };
}
const ntagZeroValue = (v) => {
  if (v == null) return true;
  try { return BigInt(String(v)) === 0n; } catch { return false; }
};
/**
 * Replays VALID ops with time <= atSec in (block, position) order. Returns { tags: Map<tag, {owner (lower-case), name,
 * since (sec), hash, block, position}>, byOwner: Map<lower-case address, tag>, locks: Map<tag, {owner, until (sec)}>,
 * statuses: Map<hash, "claimed"|"renamed"|"released"|"taken"|"locked"|"reserved"|"invalid"|"noop"> }.
 */
export function resolveNtags(ops, atSec = Infinity) {
  const tags = new Map(), byOwner = new Map(), locks = new Map(), statuses = new Map();
  const list = (ops ?? []).filter((o) => o && Number(o.time) <= atSec)
    .sort((x, y) => Number(x.block) - Number(y.block) || Number(x.position) - Number(y.position));
  const release = (owner, time) => {
    const t = byOwner.get(owner);
    if (!t) return false;
    tags.delete(t);
    byOwner.delete(owner);
    locks.set(t, { owner, until: time + NTAG_LOCK_SEC });
    return true;
  };
  for (const o of list) {
    const from = String(o.from ?? "").toLowerCase();
    let err = ntagOpError(o.op);
    if (!err && !/^0x[0-9a-f]{40}$/.test(from)) err = "invalid sender";
    if (!err && from === AGENT.toLowerCase()) err = "agent";
    if (!err && !ntagZeroValue(o.value)) err = "non-zero value";
    if (err) { statuses.set(o.hash, err === NTAG_RESERVED_ERR ? "reserved" : "invalid"); continue; }
    const time = Number(o.time);
    const t = o.op.t;
    if (t === "") { statuses.set(o.hash, release(from, time) ? "released" : "noop"); continue; }
    const name = "n" in o.op ? o.op.n.trim() : null;
    const cur = tags.get(t);
    if (cur && cur.owner === from) {
      if (name != null && name !== cur.name) { cur.name = name; statuses.set(o.hash, "renamed"); }
      else statuses.set(o.hash, "noop");
      continue;
    }
    if (cur) { statuses.set(o.hash, "taken"); continue; }
    const lock = locks.get(t);
    if (lock && lock.until > time && lock.owner !== from) { statuses.set(o.hash, "locked"); continue; }
    release(from, time);
    locks.delete(t);
    tags.set(t, { owner: from, name, since: time, hash: o.hash, block: Number(o.block), position: Number(o.position) });
    byOwner.set(from, t);
    statuses.set(o.hash, "claimed");
  }
  return { tags, byOwner, locks, statuses };
}
/** State from only the ops strictly before (block, position): what a deposit at that spot pays. */
export const resolveNtagsBefore = (ops, block, position) => resolveNtags((ops ?? []).filter((o) =>
  o && (Number(o.block) < Number(block) || (Number(o.block) === Number(block) && Number(o.position) < Number(position)))));
/** The tag an address currently holds, or null. */
export const ntagOf = (state, address) => state.byOwner.get(String(address ?? "").toLowerCase()) ?? null;
/** The current entry { owner, name, since, hash, block, position } for a tag, or null. */
export const ownerOf = (state, tag) => state.tags.get(tag) ?? null;
/** "invalid" | "reserved" | "yours" | "taken" | "locked" | "free" for `forAddress` claiming `tag` at nowSec. */
export function ntagAvailability(state, tag, forAddress, nowSec = Math.floor(Date.now() / 1000)) {
  const err = ntagError(tag);
  if (err) return err === NTAG_RESERVED_ERR ? "reserved" : "invalid";
  const me = String(forAddress ?? "").toLowerCase();
  const cur = state.tags.get(tag);
  if (cur) return me && cur.owner === me ? "yours" : "taken";
  const lock = state.locks.get(tag);
  if (lock && lock.until > nowSec && lock.owner !== me) return "locked";
  return "free";
}
/** ERC-20 transfer(agent, units) calldata + hex("NTP:" + tag) memo + attribution suffix. Tokens ignore the extra bytes. */
export function encodeNtagTransfer(agent, units, tag) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(agent))) throw new Error("invalid agent address");
  const v = BigInt(units);
  if (v <= 0n || v >= 1n << 256n) throw new Error("invalid amount");
  const err = ntagError(tag);
  if (err) throw new Error(err);
  return "0xa9059cbb" + String(agent).toLowerCase().replace(/^0x/, "").padStart(64, "0") + v.toString(16).padStart(64, "0")
    + utf8Hex(NTAG_MEMO_PREFIX + tag) + tagSuffix();
}
/** The tag in a transfer's memo (suffix stripped, selector a9059cbb, then exactly "NTP:" + a valid tag), or null. */
export function decodeNtagMemo(input) {
  const h = stripErc8021(input);
  if (!/^[0-9a-f]*$/.test(h) || h.length % 2 || !h.startsWith("a9059cbb") || h.length <= 136) return null;
  const memo = new TextDecoder().decode(hexBytes(h.slice(136)));
  if (!memo.startsWith(NTAG_MEMO_PREFIX)) return null;
  const tag = memo.slice(NTAG_MEMO_PREFIX.length);
  return ntagError(tag) ? null : tag;
}
// ---------- port: end ----------

// ---------- discovery (Blockscout) ----------

async function getJson(url, fetchImpl = fetch, attempt = 0) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`Blockscout HTTP ${r.status}`), { retry: true });
    if (!r.ok) throw new Error(`Blockscout HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (attempt === 0 && (e.retry || e.name === "TypeError" || e.name === "TimeoutError" || e.name === "AbortError")) {
      await new Promise((res) => setTimeout(res, 1000));
      return getJson(url, fetchImpl, 1);
    }
    throw e;
  }
}

/**
 * Every nTag op ever sent to `agent`, oldest first. Paginates Blockscout /addresses/<agent>/transactions?filter=to
 * (newest first) to the END (tags are permanent, so there is no time window). More than `maxPages` pages -> throws, so a
 * partial list is never mistaken for the whole one. Failed transactions are ignored.
 */
export async function discoverNtagOps({ agent = AGENT, api = EXPLORER_API, fetchImpl = fetch, maxPages = 200 } = {}) {
  const ops = [];
  let next = null;
  for (let p = 0; p < maxPages; p++) {
    const qs = new URLSearchParams({ filter: "to", ...(next ?? {}) });
    const d = await getJson(`${api}/addresses/${agent}/transactions?${qs}`, fetchImpl);
    if (!Array.isArray(d?.items)) throw new Error("Unexpected Blockscout response (no items)");
    for (const t of d.items) {
      const o = ntagOpFromItem(t, agent);
      if (o) ops.push(o);
    }
    next = d.next_page_params ?? null;
    if (!next) return ops.sort((x, y) => x.block - y.block || x.position - y.position);
  }
  throw new Error(`More than ${maxPages} pages of transactions to the agent; refusing to work from a partial nTag list.`);
}

/**
 * Re-reads the winning claim over RPC (not Blockscout) before paying its owner: it must be a successful zero-value tx
 * to the agent from the same sender, at the same block and position, with the same decoded op. Any mismatch is a
 * permanent refusal. Returns { from (checksummed) }.
 */
export async function verifyNtagOpOnchain(pub, op, agent = AGENT) {
  const [tx, rc] = await Promise.all([pub.getTransaction({ hash: op.hash }), pub.getTransactionReceipt({ hash: op.hash })]);
  const bad = (why) => refusal(`nTag claim ${op.hash} does not check out onchain (${why}). Not paid.`);
  if (rc.status !== "success") throw bad("failed transaction");
  if (String(tx.to ?? "").toLowerCase() !== String(agent).toLowerCase()) throw bad("not sent to the agent");
  if (String(tx.from).toLowerCase() !== String(op.from ?? "").toLowerCase()) throw bad("different sender");
  if (Number(tx.blockNumber) !== Number(op.block) || Number(tx.transactionIndex) !== Number(op.position)) throw bad("different block or position");
  if (BigInt(tx.value ?? 0n) !== 0n) throw bad("non-zero value");
  const decoded = decodeNtagOp(tx.input);
  if (JSON.stringify(decoded) !== JSON.stringify(op.op)) throw bad("different content");
  const err = ntagOpError(decoded);
  if (err) throw bad(err);
  return { from: getAddress(tx.from) };
}

// ---------- local state (git-ignored) ----------

/** { [`${tx}:${logIndex}` lower-case]: { tag, owner, payer, token, amount, corridor, paidAt?, hashes?, receiptNo?, error?, ... } } */
export function loadNtagPayments(file = NTAG_PAYMENTS_FILE) {
  if (!fs.existsSync(file)) return {};
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return j && typeof j.payments === "object" && j.payments && !Array.isArray(j.payments) ? j.payments : {};
}

/** Atomic write (tmp + rename). */
export function saveNtagPayments(state, file = NTAG_PAYMENTS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ payments: state }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
