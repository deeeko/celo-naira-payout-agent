// Autopilot. Polls Celo (Forno) for ERC-20 Transfer events TO the agent on USDT and cNGN, matches each deposit to an
// open payment request (sell token + exact amount + time window), and pays that request's contact.
//   - DRY RUN unless --execute: prints what it would do; writes nothing (no cursor, no request changes).
//   - With --execute: first runs the pre-flight checks that send nothing (contact, caps incl. daily cap, preview). If they
//     fail it stops WITHOUT recording anything and without moving the cursor past the deposit, so the deposit matches
//     again on the next run. Otherwise it records the payer + deposit tx on the request, then runs the normal pay flow
//     (yes=true), so a crash can never pay the same request twice. Stops on any payout error (see `agent.mjs retry`).
//   - Unmatched deposits are logged and never paid. Transfers the agent itself caused (its own swaps) are ignored.
//   - Block cursor persists in watch-state.json (git-ignored). Ctrl+C stops cleanly between steps.
import fs from "node:fs";
import { createPublicClient, http, parseAbiItem } from "viem";
import { AGENT_ADDRESS, CHAIN, TOKENS, WATCH_STATE_FILE } from "./config.mjs";
import { loadAccount } from "./chain.mjs";
import { getCorridor } from "./guards.mjs";
import { log, pay, preflight } from "./pay.mjs";
import { formatAmount, loadRequests, matchDeposit, requestStatus, saveRequests } from "./requests.mjs";

export const MAX_BLOCK_RANGE = 5000n; // Forno eth_getLogs limit
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SYMBOL = { [TOKENS.USDT.address.toLowerCase()]: "USDT", [TOKENS.CNGN.address.toLowerCase()]: "cNGN" };
const MAX_BACKOFF_MS = 5 * 60_000;

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
  const seen = new Set();
  const blockTime = new Map();
  const txFrom = new Map();

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
    if (!txFrom.has(l.transactionHash)) txFrom.set(l.transactionHash, (await pub.getTransaction({ hash: l.transactionHash })).from);
    if (txFrom.get(l.transactionHash).toLowerCase() === agent.toLowerCase()) return;

    if (!blockTime.has(l.blockNumber)) blockTime.set(l.blockNumber, Number((await pub.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
    const timeMs = blockTime.get(l.blockNumber);
    seen.add(key); // only after the RPC lookups succeeded, so a failed lookup is retried, never skipped
    const list = requests();
    const amount = formatAmount(value);
    if (list.some((r) => r.deposit?.tx === l.transactionHash && r.deposit?.logIndex === l.logIndex)) {
      say(`Deposit ${l.transactionHash} was already handled. Skipping.`);
      return;
    }
    const req = matchDeposit({ token, value, timeMs }, list);
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
      Object.assign(done, { paidAt: new Date().toISOString(), hashes: res.hashes, receiptUrl: res.receiptUrl, paid: res.paid });
      saveRequests(after);
      say(`Paid ${r.id}. Receipt: ${res.receiptUrl}`);
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

  try {
    while (!stopping) {
      try {
        const latest = await pub.getBlockNumber();
        if (cursor == null) {
          cursor = state.cursor != null ? BigInt(state.cursor) : initialFromBlock(latest, requests()) - 1n;
          say(`Scanning from block ${cursor + 1n} (latest ${latest}).`);
        }
        const chunks = chunkRanges(cursor + 1n, latest);
        if (chunks.length > 2) say(`Catching up on ${latest - cursor} blocks in ${chunks.length} queries…`);
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
