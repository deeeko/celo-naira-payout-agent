// "Pay in naira from CELO" (corridor celo-cngn). Direct owner payouts only: never payment links, "Get paid" or autopilot.
//   Textile has no CELO -> cNGN pair, so this is TWO swaps and a payout:
//     leg 1: sell CELO, buy USDT      leg 2: sell exactly the USDT leg 1 delivered, buy cNGN      payout: the cNGN received
//   Two swaps means two Textile fees, and each swap must clear Textile's ~$1 minimum (so ~20 CELO or more).
//   The USD value counted against MAX_USD / MAX_DAILY_USD is the USDT bought in leg 1 (preview, firm quote, measured).
//   The agent wallet always keeps MIN_CELO_RESERVE CELO (plus a gas margin) for network fees.
// Dry-run by default. Real money moves only with execute=true AND a typed "yes" (or yes=true from --yes).
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { AGENT_ADDRESS, ATTRIBUTION_CODE, CELO_GAS_MARGIN, CELO_MIN_USDT, MAX_SLIPPAGE_BPS, MIN_CELO_RESERVE } from "./config.mjs";
import { loadAccount, makeClients } from "./chain.mjs";
import {
  assertCeloMinimum, assertCeloReserve, assertRecipient, assertSlippage, getPayCorridor, measuredReceived, parseCeloAmount,
  resolveContact,
} from "./guards.mjs";
import { BLOCKED_RECIPIENTS, balanceOf, checkCaps, confirm, loadContacts, log, transfersTo } from "./pay.mjs";
import { receiptLink, receiptNo, receiptNoLink } from "./requests.mjs";
import { firmQuote, preview, submit } from "./textile.mjs";

const fmt6 = (u) => formatUnits(u, 6);
const fmt18 = (u) => formatUnits(u, 18);
const MIN_USDT_UNITS = parseUnits(CELO_MIN_USDT, 6);
const reserveUnits = () => parseUnits(MIN_CELO_RESERVE, 18);
const marginUnits = () => parseUnits(CELO_GAS_MARGIN, 18);
const ONE_USDT = parseUnits("1", 6);
const WHOLE_CELO = parseUnits("1", 18);

/**
 * Smallest CELO sale that clears the ~$1.05 minimum at the previewed price (`sellUnits` CELO -> `usdtUnits` USDT),
 * rounded up to whole CELO. Falls back to 20 CELO when there is no usable price.
 */
export function minCeloSell(sellUnits, usdtUnits) {
  const s = BigInt(sellUnits);
  const u = BigInt(usdtUnits);
  if (s <= 0n || u <= 0n) return 20n * WHOLE_CELO;
  const need = (s * MIN_USDT_UNITS + u - 1n) / u;
  return ((need + WHOLE_CELO - 1n) / WHOLE_CELO) * WHOLE_CELO;
}

/** Leg 2 sells what leg 1 delivered, but never more than leg 1's firm quote (the amount that already passed the caps). */
export const leg2SellAmount = (usdtGot, quotedUsdt) => (usdtGot > quotedUsdt ? quotedUsdt : usdtGot);

/** The confirmed leg-2 preview, scaled to the USDT actually sold: the cNGN the firm quote must come close to. */
export const scaledPreviewBuy = (pv2, requestedUsdt, sellUsdt) =>
  (BigInt(pv2.buyAmount) * BigInt(sellUsdt)) / BigInt(pv2.sellAmount ?? requestedUsdt);

/** The exact command that finishes a celo-cngn payout whose leg 1 succeeded: sell the USDT and pay in naira. */
export const finishCommand = (to, usdtUnits) =>
  `node src/agent.mjs pay --to ${/\s/.test(String(to)) ? JSON.stringify(String(to)) : to} --amount ${fmt6(usdtUnits)} --corridor usdt-cngn --execute`;

/** Two free previews: CELO -> USDT, then USDT -> cNGN for the USDT leg 1 would buy. No wallet, sends nothing. */
export async function celoQuote(amount) {
  const c = getPayCorridor("celo-cngn");
  const { str, units } = parseCeloAmount(amount);
  const pv1 = await preview(c.sellToken.address, c.viaToken.address, units.toString());
  if (pv1.status !== "preview") throw new Error(`No indicative CELO -> USDT price right now (${pv1.status}${pv1.reason ? `: ${pv1.reason}` : ""}).`);
  const usdt = BigInt(pv1.buyAmount);
  let pv2 = null;
  let leg2Error = null;
  try {
    pv2 = await preview(c.viaToken.address, c.buyToken.address, usdt.toString());
    if (pv2.status !== "preview") { leg2Error = `${pv2.status}${pv2.reason ? `: ${pv2.reason}` : ""}`; pv2 = null; }
  } catch (e) {
    leg2Error = e.message;
  }
  return { c, amountStr: str, sellUnits: units, pv1, usdt, pv2, leg2Error, belowMinimum: usdt < MIN_USDT_UNITS };
}

/** One-line estimate for `quote` and the dry run. */
export function describeQuote({ amountStr, pv1, usdt, pv2 }) {
  const fee1 = pv1.feeAmount != null ? ` (Textile fee ${fmt18(BigInt(pv1.feeAmount))} CELO)` : "";
  const leg2 = pv2 ? ` -> ~${fmt6(BigInt(pv2.buyAmount))} cNGN${pv2.feeAmount != null ? ` (fee ${pv2.feeAmount} base units)` : ""}` : " -> (no cNGN price right now)";
  return `${amountStr} CELO -> ~${fmt6(usdt)} USDT${fee1}${leg2}. Indicative: two swaps, two Textile fees.`;
}

/**
 * Everything that needs no wallet key and sends nothing: contact + allow-list, the ~$1 minimum, the USD caps (on leg 1's
 * preview), and an indicative price for leg 2.
 */
export async function celoPreflight({ to, amount, agent }) {
  const { contacts, own } = loadContacts();
  const recipient = assertRecipient(resolveContact(to, contacts), {
    agent,
    own,
    blocked: BLOCKED_RECIPIENTS, // includes the CELO token contract
  });
  const q = await celoQuote(amount);
  assertCeloMinimum(q.usdt, MIN_USDT_UNITS);
  checkCaps(q.usdt);
  if (!q.pv2) throw new Error(`No indicative USDT -> cNGN price right now (${q.leg2Error}). Nothing was sent.`);
  return { ...q, recipient };
}

/** Exactly `amount` of `token` for `spender`: reset a different nonzero allowance to 0 first, then approve exactly. */
async function approveExactly({ pub, wallet, owner, token, spender, amount, hashes, resetKey, approveKey, label }) {
  const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  if (allowance === amount) return;
  if (allowance > 0n) {
    hashes[resetKey] = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, 0n] });
    const rr = await pub.waitForTransactionReceipt({ hash: hashes[resetKey] });
    if (rr.status !== "success") throw new Error(`${label} allowance reset reverted (${hashes[resetKey]}).`);
  }
  hashes[approveKey] = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  const ar = await pub.waitForTransactionReceipt({ hash: hashes[approveKey] });
  if (ar.status !== "success") throw new Error(`${label} approval reverted (${hashes[approveKey]}).`);
}

const notExpired = (q, label) => {
  if (Date.now() >= Date.parse(q.quote.expiresAt)) throw new Error(`${label} quote expired before it was sent. Run again for a fresh quote.`);
};

/** Checks every transaction hash for our attribution tag. */
async function tagCheck(pub, hashes) {
  const tags = {};
  for (const [k, h] of Object.entries(hashes)) {
    try { tags[k] = (await verifyTx({ client: pub, hash: h }))?.codes ?? null; } catch { tags[k] = null; }
  }
  return { tags, untagged: Object.keys(hashes).filter((k) => !tags[k]?.includes(ATTRIBUTION_CODE)) };
}

export async function payFromCelo({ to, amount, execute = false, yes = false } = {}) {
  const account = loadAccount({ required: execute });
  const agentAddr = account?.address ?? AGENT_ADDRESS;
  const pre = await celoPreflight({ to, amount, agent: agentAddr });
  const { c, amountStr, sellUnits, pv1, pv2, usdt, recipient } = pre;
  const minSell = minCeloSell(sellUnits, usdt);
  const CELO = c.sellToken;
  const USDT = c.viaToken;
  const CNGN = c.buyToken;
  console.log(`Preview [celo-cngn] for ${to} (${recipient}): ${describeQuote(pre)}`);
  console.log(`  Counted against the caps as ${fmt6(usdt)} USD (the USDT from swap 1). The agent keeps at least ${MIN_CELO_RESERVE} CELO for gas.`);

  if (!execute) {
    // Read-only: would the agent wallet keep its gas reserve?
    try {
      const { pub } = makeClients(undefined);
      const bal = await pub.getBalance({ address: agentAddr });
      assertCeloReserve(bal, sellUnits, reserveUnits(), marginUnits(), minSell);
      console.log(`  Gas reserve OK: the agent wallet (${agentAddr}) holds ${fmt18(bal)} CELO.`);
    } catch (e) {
      if (e?.celoReserve) throw e;
      console.warn(`  Could not read the agent's CELO balance (${e.message}); the gas reserve is checked again before any real run.`);
    }
    console.log("DRY RUN: nothing was sent. Add --execute to run this for real.");
    return { dryRun: true, preview: pv1, preview2: pv2 };
  }

  const { pub, wallet } = makeClients(account);
  const me = account.address;
  for (const [t, want] of [[CELO, 18], [USDT, 6], [CNGN, 6]]) {
    const d = await pub.readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" });
    if (Number(d) !== want) throw new Error(`${t.symbol} reports ${d} decimals, expected ${want}. Aborting.`);
  }
  const [celoBal, usdtBefore, cngnBefore] = await Promise.all([
    pub.getBalance({ address: me }),
    balanceOf(pub, USDT.address, me),
    balanceOf(pub, CNGN.address, me),
  ]);
  assertCeloReserve(celoBal, sellUnits, reserveUnits(), marginUnits(), minSell);

  if (!yes && !(await confirm(
    `About to sell ${amountStr} CELO for USDT, swap that USDT to cNGN (two swaps, two fees) and pay ${to} on Celo MAINNET.`,
  ))) {
    console.log("Cancelled. Nothing was sent.");
    return { cancelled: true };
  }

  const hashes = {};
  const st = {
    paid: false, leg1Done: false, usdtGot: 0n, sellUsdt: 0n, tooSmall: false, leg2Done: false, cngnGot: 0n, takerPays1: 0n, takerPays2: 0n,
  };
  try {
    return await send({ pv2 });
  } catch (e) {
    await reportFailure(e);
    throw e;
  }

  async function send({ pv2 }) {
    // ---- Leg 1: CELO -> USDT ----
    const q1 = await firmQuote(account, CELO.address, USDT.address, sellUnits.toString());
    assertSlippage(pv1.buyAmount, q1.quote.buyAmount, MAX_SLIPPAGE_BPS);
    const takerPays1 = BigInt(q1.quote.takerPays);
    if (takerPays1 > sellUnits) throw new Error("Swap 1 quote asks for more CELO than requested. Aborting.");
    if (BigInt(q1.transactions.swap.value ?? 0) !== 0n) throw new Error("Swap 1 asks for a native CELO value; only the approved amount may move. Aborting.");
    const quotedUsdt = BigInt(q1.quote.buyAmount);
    assertCeloMinimum(quotedUsdt, MIN_USDT_UNITS);
    checkCaps(quotedUsdt); // the binding cap check: leg 2 never sells more USDT than this
    assertCeloReserve(await pub.getBalance({ address: me }), takerPays1, reserveUnits(), marginUnits(), minSell);
    st.takerPays1 = takerPays1;
    console.log(`Swap 1 firm quote: pay ${fmt18(takerPays1)} CELO, receive ${fmt6(quotedUsdt)} USDT`);
    notExpired(q1, "Swap 1");
    await approveExactly({
      pub, wallet, owner: me, token: CELO.address, spender: q1.quote.reactor, amount: takerPays1, hashes,
      resetKey: "reset1", approveKey: "approval1", label: "CELO",
    });
    notExpired(q1, "Swap 1");
    const s1 = q1.transactions.swap;
    hashes.swap1 = await wallet.sendTransaction({ to: s1.to, data: s1.data, value: 0n });
    const r1 = await pub.waitForTransactionReceipt({ hash: hashes.swap1 });
    if (r1.status !== "success") throw new Error(`Swap 1 reverted (${hashes.swap1}). The CELO was not sold.`);
    st.leg1Done = true;
    await submit(q1.rfqId, q1.claimToken, hashes.swap1).catch(() => {});
    const usdtGot = measuredReceived((await balanceOf(pub, USDT.address, me)) - usdtBefore, transfersTo(r1.logs, USDT.address, me));
    if (usdtGot <= 0n) throw new Error(`Swap 1 succeeded but no USDT was measured. Check ${hashes.swap1}.`);
    st.usdtGot = usdtGot;
    console.log(`Swap 1 done: received ${fmt6(usdtGot)} USDT.`);
    if (usdtGot < ONE_USDT) {
      st.tooSmall = true;
      throw new Error(
        `Swap 1 delivered only ${fmt6(usdtGot)} USDT, below Textile's ~$1 minimum per swap, so swap 2 cannot run. ` +
        `That USDT stays in the agent wallet (${me}).`,
      );
    }
    // Never sell more than the firm quote that passed the caps; any extra USDT stays in the agent wallet.
    const sellUsdt = leg2SellAmount(usdtGot, quotedUsdt);
    st.sellUsdt = sellUsdt;

    // ---- Leg 2: the measured USDT (at most the quoted amount) -> cNGN ----
    const pv2b = await preview(USDT.address, CNGN.address, sellUsdt.toString());
    if (pv2b.status !== "preview") {
      throw new Error(`No USDT -> cNGN price right now (${pv2b.status}${pv2b.reason ? `: ${pv2b.reason}` : ""}).`);
    }
    const q2 = await firmQuote(account, USDT.address, CNGN.address, sellUsdt.toString());
    assertSlippage(pv2b.buyAmount, q2.quote.buyAmount, MAX_SLIPPAGE_BPS); // against a fresh preview
    // ...and against the preview the owner confirmed, scaled to the USDT actually sold.
    assertSlippage(scaledPreviewBuy(pv2, usdt, sellUsdt).toString(), q2.quote.buyAmount, MAX_SLIPPAGE_BPS);
    const takerPays2 = BigInt(q2.quote.takerPays);
    if (takerPays2 > sellUsdt) throw new Error("Swap 2 quote asks for more USDT than this payout may sell. Aborting.");
    if (BigInt(q2.transactions.swap.value ?? 0) !== 0n) throw new Error("Swap 2 asks for a native CELO value. Aborting.");
    st.takerPays2 = takerPays2;
    console.log(`Swap 2 firm quote: pay ${fmt6(takerPays2)} USDT, receive ${fmt6(BigInt(q2.quote.buyAmount))} cNGN`);
    notExpired(q2, "Swap 2");
    await approveExactly({
      pub, wallet, owner: me, token: USDT.address, spender: q2.quote.reactor, amount: takerPays2, hashes,
      resetKey: "reset2", approveKey: "approval2", label: "USDT",
    });
    notExpired(q2, "Swap 2");
    const s2 = q2.transactions.swap;
    hashes.swap2 = await wallet.sendTransaction({ to: s2.to, data: s2.data, value: 0n });
    const r2 = await pub.waitForTransactionReceipt({ hash: hashes.swap2 });
    if (r2.status !== "success") throw new Error(`Swap 2 reverted (${hashes.swap2}).`);
    st.leg2Done = true;
    await submit(q2.rfqId, q2.claimToken, hashes.swap2).catch(() => {});
    const cngnGot = measuredReceived((await balanceOf(pub, CNGN.address, me)) - cngnBefore, transfersTo(r2.logs, CNGN.address, me));
    if (cngnGot <= 0n) throw new Error(`Swap 2 succeeded but no cNGN was measured. Check ${hashes.swap2}.`);
    st.cngnGot = cngnGot;

    // ---- Payout: exactly the measured cNGN ----
    hashes.payout = await wallet.writeContract({ address: CNGN.address, abi: erc20Abi, functionName: "transfer", args: [recipient, cngnGot] });
    const pr = await pub.waitForTransactionReceipt({ hash: hashes.payout });
    if (pr.status !== "success") throw new Error(`Payout reverted (${hashes.payout}).`);
    st.paid = true;

    // ---- Tags on every transaction, receipt, log ----
    const { tags, untagged } = await tagCheck(pub, hashes);
    const receiptUrl = receiptLink({ payout: hashes.payout, swap: hashes.swap2 });
    const no = receiptNo(hashes.payout);
    log({
      corridor: c.id, to, recipient, receiptNo: no,
      sold: { token: "CELO", amount: fmt18(takerPays1) },
      via: { token: "USDT", received: fmt6(usdtGot), sold: fmt6(takerPays2) },
      paid: { token: CNGN.symbol, amount: fmt6(cngnGot) },
      usd: fmt6(sellUsdt), cngnPaid: fmt6(cngnGot),
      hashes, tags, untagged, receiptUrl,
    });
    console.log(`Paid ${fmt6(cngnGot)} cNGN to ${to} (sold ${fmt18(takerPays1)} CELO -> ${fmt6(usdtGot)} USDT -> cNGN).`);
    if (usdtGot > takerPays2) console.log(`  ${fmt6(usdtGot - takerPays2)} USDT left over from swap 1 stays in the agent wallet.`);
    for (const [k, h] of Object.entries(hashes)) console.log(`  ${k}: https://celoscan.io/tx/${h}  tag=${JSON.stringify(tags[k])}`);
    console.log(`Receipt ${no}: ${receiptNoLink(no)}`);
    console.log(`  full receipt link: ${receiptUrl}`);
    if (untagged.length) {
      console.error(`WARNING: missing attribution tag ${ATTRIBUTION_CODE} on: ${untagged.join(", ")}. These will not be credited.`);
      process.exitCode = 1;
    }
    return {
      hashes, tags, untagged, receiptUrl, receiptNo: no, receiptNoUrl: receiptNoLink(no),
      sold: fmt18(takerPays1), usd: fmt6(sellUsdt), paid: fmt6(cngnGot),
    };
  }

  /** After a failure: say exactly where the funds are and how to finish, tag-check what was sent, and keep an audit line. */
  async function reportFailure(e) {
    if (e && typeof e === "object" && Object.keys(hashes).length) e.hashes = { ...hashes };
    let where;
    if (st.paid) {
      where = `${to} WAS paid (payout ${hashes.payout}); only the receipt/log step after it failed. Do not pay again.`;
    } else if (!st.leg1Done) {
      where = hashes.swap1
        ? `Swap 1 (${hashes.swap1}) did not confirm as successful. Check it on celoscan before running again.`
        : "No CELO was sold. Nothing needs finishing.";
    } else if (!st.leg2Done) {
      if (st.tooSmall) {
        where = `STOPPED after swap 1. ${fmt6(st.usdtGot)} USDT stays in the agent wallet (${me}). ` +
          `It is below Textile's ~$1 minimum, so it cannot be converted to cNGN on its own. ${to} was NOT paid.`;
      } else if (st.usdtGot > 0n) {
        const finish = st.sellUsdt > 0n ? st.sellUsdt : st.usdtGot;
        where = `STOPPED after swap 1. ${fmt6(st.usdtGot)} USDT is in the agent wallet (${me}).` +
          (hashes.swap2 ? ` Swap 2 (${hashes.swap2}) did not confirm as successful: check it first; if it reverted the USDT is still there.` : "") +
          `\nTo finish paying ${to} in naira, run:\n  ${finishCommand(to, finish)}`;
      } else {
        where = `STOPPED after swap 1 (${hashes.swap1}): the USDT received could not be measured. Run "node src/agent.mjs status" to see the agent's USDT, then:\n  node src/agent.mjs pay --to ${to} --amount <USDT> --corridor usdt-cngn --execute`;
      }
    } else {
      where = payoutFailedNote({ to, recipient, agent: me, cngnUnits: st.cngnGot, payoutHash: hashes.payout });
    }
    console.error(`celo-cngn payout failed: ${e?.message ?? e}\n${where}`);
    if (Object.keys(hashes).length) {
      const { tags, untagged } = await tagCheck(pub, hashes);
      for (const [k, h] of Object.entries(hashes)) console.error(`  ${k}: https://celoscan.io/tx/${h}  tag=${JSON.stringify(tags[k])}`);
      if (untagged.length) console.error(`WARNING: missing attribution tag ${ATTRIBUTION_CODE} on: ${untagged.join(", ")}.`);
      process.exitCode = 1;
      // Audit line only. Stored under `txs` (not `hashes`) so it never counts as a payout in the daily cap.
      if (!st.paid) try { log({
        corridor: c.id, to, recipient, status: "incomplete", error: String(e?.message ?? e),
        sold: st.takerPays1 ? { token: "CELO", amount: fmt18(st.takerPays1) } : undefined,
        usdtInAgent: st.leg1Done && !st.leg2Done ? fmt6(st.usdtGot) : undefined,
        cngnInAgent: st.leg2Done ? fmt6(st.cngnGot) : undefined,
        txs: { ...hashes }, tags, untagged,
      }); } catch { /* the console output above is the record */ }
    }
  }
}

/**
 * What to tell the owner when swap 2 succeeded but the cNGN payout did not: who should have been paid, exactly how much
 * cNGN is waiting in the agent wallet, and a command this CLI supports to settle it safely.
 */
export function payoutFailedNote({ to, recipient, agent, cngnUnits, payoutHash }) {
  const name = /\s/.test(String(to)) ? JSON.stringify(String(to)) : to;
  const lines = [`STOPPED after swap 2. ${to} was NOT paid.`];
  if (payoutHash) lines.push(`Check the payout tx first: https://celoscan.io/tx/${payoutHash} (if it reverted, nothing left the agent wallet).`);
  if (cngnUnits > 0n) {
    lines.push(`The agent wallet (${agent}) holds the ${fmt6(cngnUnits)} cNGN from swap 2.`);
    lines.push(`It was meant for ${to} at ${recipient}: exactly ${fmt6(cngnUnits)} cNGN.`);
    lines.push("This CLI has no command that sends raw cNGN. You can send exactly that amount to that address from the agent wallet yourself,");
    lines.push(`or pay ${to} in US dollars instead (sells that cNGN for USDT; DRY RUN first, then add --execute):`);
    lines.push(`  node src/agent.mjs pay --to ${name} --amount ${fmt6(cngnUnits)} --corridor cngn-usdt`);
  } else {
    lines.push(`The cNGN from swap 2 could not be measured. It was meant for ${to} at ${recipient}.`);
    lines.push('Run "node src/agent.mjs status" to see the agent\'s cNGN, then send it to that address yourself, or pay in US dollars:');
    lines.push(`  node src/agent.mjs pay --to ${name} --amount <cNGN> --corridor cngn-usdt`);
  }
  return lines.join("\n");
}
