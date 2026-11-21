// Autopilot. Polls Celo (Forno) for ERC-20 Transfer events TO the agent on USDT and cNGN, matches each deposit to an
// open payment request (sell token + exact amount + time window), and pays that request's contact.
//   - DRY RUN unless --execute: prints what it would do; writes nothing (no cursor, no request changes).
//   - With --execute: first runs the pre-flight checks that send nothing (contact, caps incl. daily cap, preview). If they
//     fail it stops WITHOUT recording anything and without moving the cursor past the deposit, so the deposit matches
//     again on the next run. Otherwise it records the payer + deposit tx on the request, then runs the normal pay flow
//     (yes=true), so a crash can never pay the same request twice. Stops on any payout error (see `agent.mjs retry`).
//   - Unmatched deposits are logged and never paid. Transfers the agent itself caused (its own swaps) are ignored.
//   - Block cursor persists in watch-state.json (git-ignored). Ctrl+C stops cleanly between steps.
//   - "Get paid" registrations (src/registrations.mjs) are discovered from Blockscout every poll. A deposit that matches
//     the ACTIVE registration for its token + exact amount (at the deposit's block time) pays the registration's sender,
//     after the registration is re-read from the chain over RPC. Self-payment, blocked recipients and registrations that
//     do not check out are refused (logged, not paid, autopilot continues); caps and prices stop it like owner requests.
//     The deposit is recorded in registrations-state.json before paying: one payout per registration.
//   - A deposit that matches BOTH an owner request and a registration is ambiguous: logged, never paid.
//   - Deposits are only scanned up to the block Blockscout has indexed, so a fresh registration is never missed.
//   - nTag payments (src/ntags.mjs): a deposit whose transfer calldata carries an "NTP:<tag>" memo pays the tag's owner
//     (resolved strictly before the deposit, claim re-read over RPC). The memo wins: such a deposit is NEVER matched
//     against requests or registrations. Unknown tags and recipients that break the rules are refused (logged, not paid);
//     caps and prices stop autopilot exactly like registrations. Recorded in ntag-payments.json before paying.
import fs from "node:fs";
import { createPublicClient, formatUnits, http, parseAbiItem, parseUnits } from "viem";
import { AGENT_ADDRESS, CHAIN, TOKENS, WATCH_STATE_FILE } from "./config.mjs";
import { loadAccount } from "./chain.mjs";
import { getCorridor, refusal } from "./guards.mjs";
import { log, pay, preflight } from "./pay.mjs";
import { preview } from "./textile.mjs";
import { formatAmount, loadRequests, matchDeposit, receiptNoLink, requestStatus, saveRequests } from "./requests.mjs";
import {
  discoverRegistrations, indexedHeight, loadRegState, MAX_REG_HOURS, matchRegistration, registrationWindows, saveRegState,
  verifyRegistrationOnchain,
} from "./registrations.mjs";
import {
  decodeNtagMemo, discoverNtagOps, loadNtagPayments, ownerOf, resolveNtagsBefore, saveNtagPayments, verifyNtagOpOnchain,
} from "./ntags.mjs";

export const MAX_BLOCK_RANGE = 5000n; // Forno eth_getLogs limit
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SYMBOL = { [TOKENS.USDT.address.toLowerCase()]: "USDT", [TOKENS.CNGN.address.toLowerCase()]: "cNGN" };
const MAX_BACKOFF_MS = 5 * 60_000;

// ---------- nTag payments (pure, unit-tested) ----------

/** Corridor an nTag payment takes, by the token deposited: USDT -> usdt-cngn (owner gets naira), cNGN -> cngn-usdt. */
export function ntagCorridor(token) {
  const t = String(token ?? "").toLowerCase();
  if (t === TOKENS.USDT.address.toLowerCase()) return "usdt-cngn";
  if (t === TOKENS.CNGN.address.toLowerCase()) return "cngn-usdt";
  return null;
}

/**
 * Smallest nTag deposit autopilot considers, in the deposited token. USDT: Textile's ~$1 swap minimum. cNGN: a dust
 * floor well under $1 at any plausible rate; a cNGN deposit must also preview at >= NTAG_MIN_USD (checked live, see
 * ntagUsdFloor). Smaller deposits are refused (logged, not paid), so dust does not stop autopilot with a price error.
 */
export const NTAG_MIN = { "usdt-cngn": "1", "cngn-usdt": "1000" };
export const NTAG_MIN_USD = "1";

/**
 * cNGN deposits: a permanent refusal when the live preview says the naira is worth less than NTAG_MIN_USD (the site and
 * the ntag CLI never let a payer send less). No price right now is left to preflight, which stops autopilot as usual.
 */
export async function ntagUsdFloor(corridor, units, previewImpl = preview) {
  if (corridor !== "cngn-usdt") return;
  const pv = await previewImpl(TOKENS.CNGN.address, TOKENS.USDT.address, BigInt(units).toString());
  if (pv?.status === "preview" && BigInt(pv.buyAmount) < parseUnits(NTAG_MIN_USD, 6)) {
    throw refusal(`${formatUnits(BigInt(units), 6)} cNGN is worth about ${formatUnits(BigInt(pv.buyAmount), 6)} USD, below the ${NTAG_MIN_USD} USD minimum for nTag payments. Not paid.`);
  }
}

/**
 * Deposit base units (6 dp) -> the amount string pay() accepts, rounded DOWN to `places` decimals, plus the dust kept
 * back. pay() takes up to 6 decimals, so by default the whole deposit is paid. Never more than was received.
 */
export function ntagPayAmount(units, places = 6) {
  const v = BigInt(units);
  const step = 10n ** BigInt(6 - Math.min(6, Math.max(0, places)));
  const paid = v - (v % step);
  return { amount: formatUnits(paid, 6), units: paid, dust: v - paid };
}

const word = (h, i) => h.slice(8 + i * 64, 8 + (i + 1) * 64);

/**
 * What autopilot does with a deposit whose calldata carries an nTag memo. Pure: no RPC, no files.
 *   dep = { key, tag, token, value (bigint), payer, tx: { from, to, input }, block, position }
 *   ops = every nTag op discovered this poll; payments = ntag-payments.json (plus dry-run records); agent = agent address.
 * Returns { action: "handled" } | { action: "refuse", reason } |
 *         { action: "pay", tag, entry, op, corridor, amount, units, dust }.
 * The memo's transfer must be the deposit itself (sent to the token, to the agent, same amount, same sender), and the
 * owner is resolved from the ops strictly before the deposit's (block, position).
 */
export function classifyNtagDeposit(dep, ops, payments, agent) {
  if (payments?.[dep.key]) return { action: "handled" };
  const corridor = ntagCorridor(dep.token);
  if (!corridor) return { action: "refuse", reason: "token not accepted for nTag payments" };
  const h = String(dep.tx?.input ?? "").toLowerCase().replace(/^0x/, "");
  let memoValue = null;
  try { memoValue = BigInt("0x" + word(h, 1)); } catch { /* malformed: refused below */ }
  if (
    String(dep.tx?.to ?? "").toLowerCase() !== String(dep.token).toLowerCase()
    || word(h, 0).slice(24) !== String(agent).toLowerCase().replace(/^0x/, "")
    || memoValue !== BigInt(dep.value)
    || String(dep.tx?.from ?? "").toLowerCase() !== String(dep.payer ?? "").toLowerCase()
  ) return { action: "refuse", reason: "the nTag memo does not match this transfer" };
  const { amount, units, dust } = ntagPayAmount(dep.value);
  if (units < parseUnits(NTAG_MIN[corridor], 6)) return { action: "refuse", reason: `below the nTag minimum of ${NTAG_MIN[corridor]}` };
  const entry = ownerOf(resolveNtagsBefore(ops, dep.block, dep.position), dep.tag);
  if (!entry) return { action: "refuse", reason: "unknown nTag" };
  const op = (ops ?? []).find((o) => o.hash === entry.hash);
  if (!op) return { action: "refuse", reason: "nTag claim not found" };
  return { action: "pay", tag: dep.tag, entry, op, corridor, amount, units, dust };
}

/** Inclusive [from, to] block ranges of at most `size` blocks each. */
export function chunkRanges(from, to, size = MAX_BLOCK_RANGE) {
  const out = [];
  for (let a = BigInt(from); a <= BigInt(to); a += BigInt(size)) {
    const b = a + BigInt(size) - 1n;
    out.push([a, b < BigInt(to) ? b : BigInt(to)]);
  }
  return out;
}

/**
 * First block to scan when there is no saved cursor: far enough back to cover the oldest open request
 * (Celo block time ~1 s, plus a 2-minute margin), else the latest block.
 */
export function initialFromBlock(latest, requests, now = Date.now(), blockMs = 1000) {
  const open = requests.filter((r) => requestStatus(r, now) === "open");
  if (!open.length) return BigInt(latest);
  const oldest = Math.min(...open.map((r) => r.created));
  const back = BigInt(Math.ceil(Math.max(0, now - oldest) / blockMs) + 120);
  const from = BigInt(latest) - back;
  return from > 0n ? from : 0n;
}

/** Exponential backoff for RPC errors: interval, 2x, 4x ... capped at 5 minutes. */
export const backoffMs = (intervalMs, failures) => Math.min(intervalMs * 2 ** Math.max(0, failures), MAX_BACKOFF_MS);

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (msg) => console.log(`[${stamp()}] ${msg}`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function loadState() {
  try { return JSON.parse(fs.readFileSync(WATCH_STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) {
  const tmp = `${WATCH_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, WATCH_STATE_FILE);
}

class StopError extends Error {}

export async function watch({ execute = false, interval = 15 } = {}) {
  const intervalMs = Math.max(5, Number(interval) || 15) * 1000;
  const account = loadAccount({ required: execute });
  const agent = account?.address ?? AGENT_ADDRESS;
  // Forno. eth_getLogs over 5000 blocks can take >10 s (viem's default timeout), so allow 30 s.
  const pub = createPublicClient({ chain: CHAIN, transport: http(process.env.CELO_RPC_URL || undefined, { timeout: 30_000, retryCount: 2 }) });
  const state = execute ? loadState() : {};
  const dryMatched = new Map(); // dry run only: request id -> simulated deposit, in memory
  const dryRegMatched = new Map(); // dry run only: registration hash -> simulated deposit, in memory
  const dryNtag = new Map(); // dry run only: nTag deposit key -> simulated record, in memory
  let regs = []; // "Get paid" registrations, refreshed every poll
  let ntagOps = []; // every nTag op sent to the agent, refreshed every poll
  const seen = new Set();
  const blockTime = new Map();
  const txInfo = new Map(); // tx hash -> { from, to, input, index }

  // Ctrl+C: finish the current step, then exit. A second Ctrl+C exits immediately.
  let stopping = false;
  let wake = null;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    say("Stopping after the current step… (Ctrl+C again to force)");
    wake?.();
  };
  process.on("SIGINT", onSigint);
  const sleep = (ms) => new Promise((res) => { const t = setTimeout(res, ms); wake = () => { clearTimeout(t); res(); }; });

  const requests = () => {
    const list = loadRequests();
    for (const r of list) if (dryMatched.has(r.id)) r.deposit = dryMatched.get(r.id);
    return list;
  };

  const regState = () => {
    const s = loadRegState();
    for (const [h, d] of dryRegMatched) s[h] = { ...(s[h] ?? {}), deposit: d };
    return s;
  };

  const ntagPayments = () => {
    const s = loadNtagPayments();
    for (const [k, d] of dryNtag) s[k] = { ...(s[k] ?? {}), ...d };
    return s;
  };

  say(`Watching ${agent} for USDT and cNGN deposits every ${intervalMs / 1000}s. ${execute ? "EXECUTE MODE: matched requests are paid for real." : "DRY RUN: nothing is paid or saved. Add --execute to pay."}`);
  const open = requests().filter((r) => requestStatus(r) === "open");
  say(`${open.length} open request(s)${open.length ? ": " + open.map((r) => `${r.id} ${r.amount} ${getCorridor(r.dir).sellToken.symbol} for ${r.name}`).join(", ") : ". Create one with: node src/agent.mjs request --to NAME --amount N"}`);

  let cursor = null; // last fully processed block
  let failures = 0;
  let caughtUp = false;

  async function handle(l) {
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) return;
    const token = l.address;
    const sym = SYMBOL[token.toLowerCase()] ?? "token";
    const value = l.args.value;
    const payer = l.args.from;
    if (value === 0n) return;

    // Ignore transfers the agent caused itself (e.g. the output of its own swap).
    if (!txInfo.has(l.transactionHash)) {
      const t = await pub.getTransaction({ hash: l.transactionHash });
      txInfo.set(l.transactionHash, { from: t.from, to: t.to, input: t.input, index: t.transactionIndex });
    }
    const tx = txInfo.get(l.transactionHash);
    if (tx.from.toLowerCase() === agent.toLowerCase()) return;

    if (!blockTime.has(l.blockNumber)) blockTime.set(l.blockNumber, Number((await pub.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
    const timeMs = blockTime.get(l.blockNumber);
    seen.add(key); // only after the RPC lookups succeeded, so a failed lookup is retried, never skipped
    const amount = formatAmount(value);
    const list = requests();
    const rstate = regState();
    const handled = (d) => d?.tx === l.transactionHash && d?.logIndex === l.logIndex;
    if (list.some((r) => handled(r.deposit)) || Object.values(rstate).some((r) => handled(r.deposit))) {
      say(`Deposit ${l.transactionHash} was already handled. Skipping.`);
      return;
    }
    // A transfer memo naming an nTag wins: such a deposit is never matched against requests or registrations.
    const tag = decodeNtagMemo(tx.input);
    if (tag) return handleNtag(l, tag, { sym, amount, payer, timeMs, tx });
    const req = matchDeposit({ token, value, timeMs }, list);
    const rm = matchRegistration({ token, value, timeMs }, regs, rstate);
    if (req && rm) {
      say(`Ambiguous deposit: ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) matches request ${req.id} AND registration ${rm.reg.hash}. NOT paid; settle it by hand.`);
      if (execute) log({ type: "ambiguous_deposit", requestId: req.id, registrationId: rm.reg.hash, token: sym, amount, from: payer, tx: l.transactionHash, block: String(l.blockNumber) });
      return;
    }
    if (rm?.used) {
      say(`Deposit ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) matches registration ${rm.reg.hash}, which was already used (one payout per registration). NOT paid.`);
      if (execute) log({ type: "unmatched_deposit", reason: "registration already used", registrationId: rm.reg.hash, token: sym, amount, from: payer, tx: l.transactionHash, block: String(l.blockNumber) });
      return;
    }
    if (rm) return handleRegistration(l, rm.reg, { sym, amount, payer, timeMs });
    if (!req) {
      say(`Unmatched deposit: ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}). No open request has this exact amount and token. NOT paid.`);
      if (execute) log({ type: "unmatched_deposit", token: sym, amount, from: payer, tx: l.transactionHash, block: String(l.blockNumber) });
      return;
    }
    const deposit = { payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber), at: new Date(timeMs).toISOString() };
    say(`Matched ${req.id}: ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) -> pay ${req.name} via ${req.dir}.`);

    if (!execute) {
      try {
        await pay({ to: req.name, amount: req.amount, corridor: req.dir, execute: false, requestId: req.id });
        dryMatched.set(req.id, deposit);
      } catch (e) {
        say(`DRY RUN: pre-flight fails right now: ${e.message}. With --execute the deposit would NOT be recorded and autopilot would stop here.`);
      }
      return;
    }

    // Pre-flight (sends nothing): contact + allow-list, both caps incl. the daily cap, and a live preview.
    // If it fails, the request is left untouched and the cursor stays before this deposit, so after the owner fixes
    // the cause and restarts, the same deposit matches again. Nothing has been recorded or paid.
    try {
      await preflight({ to: req.name, amount: req.amount, corridor: req.dir, agent });
    } catch (e) {
      saveState({ cursor: String(cursor), updatedAt: new Date().toISOString() }); // pin the rescan point before this deposit
      log({ type: "preflight_failed", requestId: req.id, token: sym, amount, from: payer, tx: l.transactionHash, block: String(l.blockNumber), error: e.message });
      throw new StopError(
        `Pre-flight failed for ${req.id}: ${e.message}. NOTHING was recorded or paid; the deposit stays in the agent wallet ` +
        `and ${req.id} is still open. Fix the cause, then run "watch --execute" again: it rescans from block ${cursor + 1n} and matches this deposit again. Stopping.`,
      );
    }

    // Record the deposit BEFORE paying: one payout per request, even if we crash mid-flow.
    const fresh = loadRequests();
    const r = fresh.find((x) => x.id === req.id);
    r.deposit = deposit;
    saveRequests(fresh);
    try {
      const res = await pay({ to: r.name, amount: r.amount, corridor: r.dir, execute: true, yes: true, requestId: r.id });
      const after = loadRequests();
      const done = after.find((x) => x.id === r.id);
      Object.assign(done, { paidAt: new Date().toISOString(), hashes: res.hashes, receiptUrl: res.receiptUrl, receiptNo: res.receiptNo, paid: res.paid });
      saveRequests(after);
      say(`Paid ${r.id}. Receipt ${res.receiptNo}: ${receiptNoLink(res.receiptNo)}`);
      if (res.untagged?.length) throw new StopError(`Payout ${r.id} sent, but ${res.untagged.join(", ")} lack the attribution tag. Stopping to investigate.`);
    } catch (e) {
      if (e instanceof StopError) throw e;
      const after = loadRequests();
      const failed = after.find((x) => x.id === r.id);
      failed.error = e.message;
      if (e.hashes) failed.hashes = e.hashes;
      saveRequests(after);
      throw new StopError(
        `Payout for ${r.id} failed: ${e.message}. The deposit is recorded on the request; it is not retried automatically. ` +
        `Fix the cause, then "node src/agent.mjs retry --request ${r.id}" (dry run; add --execute to pay). Stopping.`,
      );
    }
  }

  async function handleRegistration(l, reg, { sym, amount, payer, timeMs }) {
    const deposit = { payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber), at: new Date(timeMs).toISOString() };
    const id = reg.hash.toLowerCase();
    const args = { to: reg.req.n, amount: reg.req.a, corridor: reg.req.d, recipientAddress: reg.from, payer, registrationId: reg.hash };
    say(`Matched registration ${reg.hash}: ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) -> pay ${reg.req.n} (${short(reg.from)}) via ${reg.req.d}.`);

    if (!execute) {
      try {
        await verifyRegistrationOnchain(pub, reg, agent);
        await pay({ ...args, execute: false });
        dryRegMatched.set(id, deposit);
      } catch (e) {
        say(e.permanent
          ? `DRY RUN: would refuse: ${e.message} With --execute this is logged and autopilot carries on.`
          : `DRY RUN: pre-flight fails right now: ${e.message}. With --execute the deposit would NOT be recorded and autopilot would stop here.`);
      }
      return;
    }

    // Pre-flight (sends nothing): the registration re-read over RPC, recipient rules (not the payer, agent, own wallets,
    // contracts, zero), per-payout / daily / per-wallet caps and a live preview.
    let from;
    try {
      ({ from } = await verifyRegistrationOnchain(pub, reg, agent));
      await preflight({ ...args, recipientAddress: from, agent });
    } catch (e) {
      if (e.permanent) {
        say(`Refused deposit ${l.transactionHash} for registration ${reg.hash}: ${e.message} The deposit stays in the agent wallet. Continuing.`);
        log({ type: "refused_deposit", registrationId: reg.hash, token: sym, amount, from: payer, tx: l.transactionHash, block: String(l.blockNumber), error: e.message });
        return;
      }
      saveState({ cursor: String(cursor), updatedAt: new Date().toISOString() }); // pin the rescan point before this deposit
      log({ type: "preflight_failed", registrationId: reg.hash, token: sym, amount, from: payer, tx: l.transactionHash, block: String(l.blockNumber), error: e.message });
      throw new StopError(
        `Pre-flight failed for registration ${reg.hash}: ${e.message}. NOTHING was recorded or paid; the deposit stays in the agent wallet. ` +
        `Fix the cause, then run "watch --execute" again: it rescans from block ${cursor + 1n} and matches this deposit again. Stopping.`,
      );
    }

    // Record the deposit BEFORE paying: one payout per registration, even if we crash mid-flow.
    const fresh = loadRegState();
    fresh[id] = {
      id, hash: reg.hash, from, name: reg.req.n, amount: reg.req.a, dir: reg.req.d, exp: reg.req.e,
      ...(reg.req.m ? { note: reg.req.m } : {}), deposit,
    };
    saveRegState(fresh);
    try {
      const res = await pay({ ...args, recipientAddress: from, execute: true, yes: true });
      const after = loadRegState();
      Object.assign(after[id], { paidAt: new Date().toISOString(), hashes: res.hashes, receiptUrl: res.receiptUrl, receiptNo: res.receiptNo, paid: res.paid });
      saveRegState(after);
      say(`Paid registration ${reg.hash}. Receipt ${res.receiptNo}: ${receiptNoLink(res.receiptNo)}`);
      if (res.untagged?.length) throw new StopError(`Payout for ${reg.hash} sent, but ${res.untagged.join(", ")} lack the attribution tag. Stopping to investigate.`);
    } catch (e) {
      if (e instanceof StopError) throw e;
      const after = loadRegState();
      after[id].error = e.message;
      if (e.hashes) after[id].hashes = e.hashes;
      saveRegState(after);
      throw new StopError(
        `Payout for registration ${reg.hash} failed: ${e.message}. The deposit is recorded; it is not retried automatically. ` +
        `Fix the cause, then "node src/agent.mjs retry --registration ${reg.hash}" (dry run; add --execute to pay). Stopping.`,
      );
    }
  }

  async function handleNtag(l, tag, { sym, amount, payer, timeMs, tx }) {
    const key = `${l.transactionHash}:${l.logIndex}`.toLowerCase();
    const deposit = { payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber), at: new Date(timeMs).toISOString() };
    const where = { ntag: tag, token: sym, amount, from: payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber) };
    const d = classifyNtagDeposit({
      key, tag, token: l.address, value: l.args.value, payer, tx, block: l.blockNumber, position: l.transactionIndex ?? tx.index,
    }, ntagOps, ntagPayments(), agent);
    if (d.action === "handled") {
      say(`Deposit ${l.transactionHash} for @${tag} was already handled. Skipping.`);
      return;
    }
    if (d.action === "refuse") {
      say(`Refused deposit ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) for @${tag}: ${d.reason}. NOT paid; the deposit stays in the agent wallet. Continuing.`);
      if (execute) log({ type: "refused_deposit", reason: d.reason, ...where });
      return;
    }
    const args = { to: `@${tag}`, amount: d.amount, corridor: d.corridor, recipientAddress: d.entry.owner, payer, ntag: tag };
    say(`nTag payment: ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) -> pay @${tag} (${short(d.entry.owner)}) via ${d.corridor}.`);
    if (d.dust > 0n) say(`  Paying ${d.amount} ${sym}; ${formatUnits(d.dust, 6)} ${sym} of dust stays in the agent wallet.`);
    const record = (from) => ({
      id: key, tag, name: `@${tag}`, from, owner: from, claim: d.entry.hash, ...(d.entry.name ? { ownerName: d.entry.name } : {}),
      token: sym, amount: d.amount, dir: d.corridor, ...(d.dust > 0n ? { dust: formatUnits(d.dust, 6) } : {}), deposit,
    });

    if (!execute) {
      try {
        await verifyNtagOpOnchain(pub, d.op, agent);
        await ntagUsdFloor(d.corridor, d.units);
        await pay({ ...args, execute: false });
        dryNtag.set(key, record(d.entry.owner));
      } catch (e) {
        say(e.permanent
          ? `DRY RUN: would refuse: ${e.message} With --execute this is logged and autopilot carries on.`
          : `DRY RUN: pre-flight fails right now: ${e.message}. With --execute the deposit would NOT be recorded and autopilot would stop here.`);
      }
      return;
    }

    // Pre-flight (sends nothing): the winning claim re-read over RPC, recipient rules (not the payer, agent, own wallets,
    // contracts, zero), per-payout / daily / per-wallet caps and a live preview.
    let from;
    try {
      ({ from } = await verifyNtagOpOnchain(pub, d.op, agent));
      await ntagUsdFloor(d.corridor, d.units);
      await preflight({ ...args, recipientAddress: from, agent });
    } catch (e) {
      if (e.permanent) {
        say(`Refused deposit ${l.transactionHash} for @${tag}: ${e.message} The deposit stays in the agent wallet. Continuing.`);
        log({ type: "refused_deposit", reason: "nTag payment refused", ...where, error: e.message });
        return;
      }
      saveState({ cursor: String(cursor), updatedAt: new Date().toISOString() }); // pin the rescan point before this deposit
      log({ type: "preflight_failed", ...where, error: e.message });
      throw new StopError(
        `Pre-flight failed for the nTag payment to @${tag}: ${e.message}. NOTHING was recorded or paid; the deposit stays in the agent wallet. ` +
        `Fix the cause, then run "watch --execute" again: it rescans from block ${cursor + 1n} and matches this deposit again. Stopping.`,
      );
    }

    // Record the deposit BEFORE paying: one payout per deposit, even if we crash mid-flow.
    const fresh = loadNtagPayments();
    if (fresh[key]) { say(`Deposit ${l.transactionHash} for @${tag} was already handled. Skipping.`); return; }
    fresh[key] = record(from);
    saveNtagPayments(fresh);
    try {
      const res = await pay({ ...args, recipientAddress: from, execute: true, yes: true });
      const after = loadNtagPayments();
      Object.assign(after[key], { paidAt: new Date().toISOString(), hashes: res.hashes, receiptUrl: res.receiptUrl, receiptNo: res.receiptNo, paid: res.paid });
      saveNtagPayments(after);
      say(`Paid @${tag}. Receipt ${res.receiptNo}: ${receiptNoLink(res.receiptNo)}`);
      if (res.untagged?.length) throw new StopError(`Payout to @${tag} sent, but ${res.untagged.join(", ")} lack the attribution tag. Stopping to investigate.`);
    } catch (e) {
      if (e instanceof StopError) throw e;
      const after = loadNtagPayments();
      after[key].error = e.message;
      if (e.hashes) after[key].hashes = e.hashes;
      saveNtagPayments(after);
      throw new StopError(
        `Payout to @${tag} failed: ${e.message}. The deposit is recorded; it is not retried automatically. ` +
        `Fix the cause, then "node src/agent.mjs retry --ntag ${key}" (dry run; add --execute to pay). Stopping.`,
      );
    }
  }

  try {
    while (!stopping) {
      try {
        const latest = await pub.getBlockNumber();
        // Blockscout's indexed height FIRST, then the registrations: every registration in a block <= that height is
        // in the list, and deposits are scanned only up to that height.
        const indexed = await indexedHeight();
        const from0 = cursor ?? (state.cursor != null ? BigInt(state.cursor) : latest);
        const sinceSec = Math.floor(Date.now() / 1000) - Number(latest > from0 ? latest - from0 : 0n) - (MAX_REG_HOURS + 24) * 3600;
        regs = await discoverRegistrations({ agent, sinceSec });
        ntagOps = await discoverNtagOps({ agent }); // all of them, every poll: tags are permanent
        if (cursor == null) {
          cursor = state.cursor != null ? BigInt(state.cursor) : initialFromBlock(latest, [...requests(), ...registrationWindows(regs)]) - 1n;
          say(`Scanning from block ${cursor + 1n} (latest ${latest}). ${regs.length} "Get paid" registration(s) and ${ntagOps.length} nTag op(s) found.`);
        }
        const head = indexed < latest ? indexed : latest;
        const chunks = chunkRanges(cursor + 1n, head);
        if (chunks.length > 2) say(`Catching up on ${head - cursor} blocks in ${chunks.length} queries…`);
        for (const [i, [from, to]] of chunks.entries()) {
          if (stopping) break;
          if (chunks.length > 2 && i > 0 && i % 5 === 0) say(`  …block ${from} (${i}/${chunks.length})`);
          const logs = await pub.getLogs({
            address: [TOKENS.USDT.address, TOKENS.CNGN.address], event: TRANSFER, args: { to: agent }, fromBlock: from, toBlock: to, strict: true,
          });
          logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
          for (const l of logs) {
            await handle(l); // a payout is never interrupted mid-flow by Ctrl+C
            if (stopping) break;
          }
          if (stopping) break; // leave the cursor before this chunk so nothing is skipped
          cursor = to;
          if (execute) saveState({ cursor: String(cursor), updatedAt: new Date().toISOString() });
        }
        if (failures > 0 || (chunks.length > 0 && !caughtUp)) {
          if (!stopping) say(`Up to date at block ${cursor}. Waiting for deposits… (Ctrl+C to stop)`);
          caughtUp = true;
        }
        failures = 0;
      } catch (e) {
        if (e instanceof StopError) throw e;
        const wait = backoffMs(intervalMs, failures++);
        say(`RPC error: ${e.shortMessage ?? e.message}. Retrying in ${Math.round(wait / 1000)}s.`);
        await sleep(wait);
        continue;
      }
      if (!stopping) await sleep(intervalMs);
    }
    say("Stopped.");
  } finally {
    process.off("SIGINT", onSigint);
  }
}
