// The payout flow, for either corridor:
//   preview -> firm quote -> approve SELL token -> swap -> pay out the BUY token to the recipient.
//   usdt-cngn (default): sell USDT, pay cNGN.   cngn-usdt: sell cNGN, pay USDT.
// Dry-run by default. Real money moves only with execute=true AND an explicit confirmation (or yes=true,
// which only the CLI flag --yes and the watch --execute autopilot set).
import fs from "node:fs";
import readline from "node:readline/promises";
import { erc20Abi, formatUnits, parseEventLogs, parseUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import {
  ATTRIBUTION_CODE, CONTACTS_FILE, IDENTITY_REGISTRY, LOG_FILE, MAX_DAILY_USD, MAX_SLIPPAGE_BPS, MAX_USD, TOKENS,
} from "./config.mjs";
import { loadAccount, makeClients } from "./chain.mjs";
import {
  assertDailyCap, assertRecipient, assertSlippage, assertWithinCap, dailyUsedUnits, getCorridor, parseAmount,
  parseContacts, resolveContact,
} from "./guards.mjs";
import { receiptLink } from "./requests.mjs";
import { firmQuote, preview, submit } from "./textile.mjs";

export function loadContacts() {
  if (!fs.existsSync(CONTACTS_FILE)) {
    throw new Error(`No contacts file. Copy contacts.example.json to contacts.json and add your recipient.`);
  }
  return parseContacts(JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8")));
}

/** All entries in receipts.jsonl (bad lines are skipped). */
export function readReceipts(file = LOG_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

export const log = (entry) => fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

export async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} Type "yes" to continue: `)).trim().toLowerCase();
  rl.close();
  return answer === "yes";
}

const fmt = (units) => formatUnits(units, 6);
const balanceOf = (pub, token, owner) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

/** USD value (6-dp units) used for both caps: USDT sold (usdt-cngn) or USDT bought (cngn-usdt). */
function checkCaps(usdUnits) {
  assertWithinCap(fmt(usdUnits), MAX_USD);
  assertDailyCap(dailyUsedUnits(readReceipts()), usdUnits, MAX_DAILY_USD);
}

/**
 * The checks that need no wallet and send nothing: contact lookup + allow-list (contacts.json), both USD caps
 * (incl. the rolling daily cap) and a Textile preview for the amount. Throws on the first failure.
 * Used by pay() and by autopilot BEFORE it records a deposit on a request.
 */
export async function preflight({ to, amount, corridor = "usdt-cngn", agent } = {}) {
  const c = getCorridor(corridor);
  const { contacts, own } = loadContacts();
  const amountStr = parseAmount(amount);
  const sellAmount = parseUnits(amountStr, 6);
  // usdt-cngn: the amount itself is the USD value, so check the caps before asking anyone for a price.
  if (c.usd === "sell") checkCaps(sellAmount);
  const recipient = assertRecipient(resolveContact(to, contacts), {
    agent,
    own,
    blocked: [TOKENS.USDT.address, TOKENS.CNGN.address, IDENTITY_REGISTRY],
  });
  const pv = await preview(c.sellToken.address, c.buyToken.address, sellAmount.toString());
  if (pv.status !== "preview") throw new Error(`No indicative price right now (${pv.status}).`);
  // cngn-usdt: the USD value is what we would buy; check it against the caps from the preview, and again on the firm quote.
  if (c.usd === "buy") checkCaps(BigInt(pv.buyAmount));
  return { c, amountStr, sellAmount, recipient, pv };
}

export async function pay({ to, amount, corridor = "usdt-cngn", execute = false, yes = false, requestId } = {}) {
  const account = loadAccount({ required: execute });
  const { c, amountStr, sellAmount, recipient, pv } = await preflight({ to, amount, corridor, agent: account?.address });
  const sell = c.sellToken;
  const buy = c.buyToken;
  console.log(
    `Preview [${c.id}]: ${amountStr} ${sell.symbol} -> ~${fmt(BigInt(pv.buyAmount))} ${buy.symbol}` +
    ` (fee ${pv.feeAmount} base units) for ${to} (${recipient})`,
  );

  if (!execute) {
    console.log("DRY RUN: nothing was sent. Add --execute to run this for real.");
    return { dryRun: true, preview: pv };
  }

  const { pub, wallet } = makeClients(account);
  // Both tokens must really be 6 decimals; every amount above assumes it.
  for (const t of [sell, buy]) {
    const d = await pub.readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" });
    if (Number(d) !== 6) throw new Error(`${t.symbol} reports ${d} decimals, expected 6. Aborting.`);
  }
  const [sellBal, buyBefore, celoBal] = await Promise.all([
    balanceOf(pub, sell.address, account.address),
    balanceOf(pub, buy.address, account.address),
    pub.getBalance({ address: account.address }),
  ]);
  if (sellBal < sellAmount) throw new Error(`Agent wallet holds ${fmt(sellBal)} ${sell.symbol}, needs ${amountStr}.`);
  if (celoBal < parseUnits("0.02", 18)) throw new Error("Agent wallet needs ~0.02 CELO for gas.");

  if (!yes && !(await confirm(`About to convert ${amountStr} ${sell.symbol} to ${buy.symbol} and pay ${to} on Celo MAINNET.`))) {
    console.log("Cancelled. Nothing was sent.");
    return { cancelled: true };
  }

  const hashes = {};
  try {
    return await send();
  } catch (e) {
    // Hand any transactions already sent back to the caller, so a failed payout records what moved on chain.
    if (Object.keys(hashes).length && e && typeof e === "object") e.hashes = { ...hashes };
    throw e;
  }

  async function send() {
    // 1. Firm quote (signs a no-funds proof of wallet control only if Textile asks).
    const q = await firmQuote(account, sell.address, buy.address, sellAmount.toString());
    assertSlippage(pv.buyAmount, q.quote.buyAmount, MAX_SLIPPAGE_BPS);
    const takerPays = BigInt(q.quote.takerPays);
    if (takerPays > sellAmount) throw new Error("Quote asks for more than the amount requested. Aborting.");
    const quotedBuy = BigInt(q.quote.buyAmount);
    const usdUnits = c.usd === "sell" ? takerPays : quotedBuy;
    if (c.usd === "buy") checkCaps(quotedBuy);
    const reactor = q.quote.reactor;
    console.log(`Firm quote: pay ${fmt(takerPays)} ${sell.symbol}, receive ${fmt(quotedBuy)} ${buy.symbol}`);

    // 2. Approve only what is needed, on the SELL token. USDT-style tokens reject nonzero -> nonzero approvals, so reset first.
    const allowance = await pub.readContract({
      address: sell.address, abi: erc20Abi, functionName: "allowance", args: [account.address, reactor],
    });
    if (allowance < takerPays) {
      if (allowance > 0n) {
        hashes.reset = await wallet.writeContract({ address: sell.address, abi: erc20Abi, functionName: "approve", args: [reactor, 0n] });
        const rr = await pub.waitForTransactionReceipt({ hash: hashes.reset });
        if (rr.status !== "success") throw new Error("Allowance reset reverted. Nothing was swapped.");
      }
      // Build the approval ourselves: exactly takerPays, to the quote's reactor, on the sell-token contract.
      // (Not Textile's prepared approval calldata, so the amount and spender are guaranteed here.)
      hashes.approval = await wallet.writeContract({ address: sell.address, abi: erc20Abi, functionName: "approve", args: [reactor, takerPays] });
      const ar = await pub.waitForTransactionReceipt({ hash: hashes.approval });
      if (ar.status !== "success") throw new Error("Approval reverted. Nothing was swapped.");
    }

    // 3. Swap. Re-check the clock first: an expired quote must not be sent.
    if (Date.now() >= Date.parse(q.quote.expiresAt)) throw new Error("Quote expired during approval. Run again for a fresh quote.");
    const s = q.transactions.swap; // always broadcast transactions.swap, never the top-level order
    hashes.swap = await wallet.sendTransaction({ to: s.to, data: s.data, value: BigInt(s.value) });
    const sr = await pub.waitForTransactionReceipt({ hash: hashes.swap });
    if (sr.status !== "success") throw new Error(`Swap reverted (${hashes.swap}).`);
    await submit(q.rfqId, q.claimToken, hashes.swap).catch(() => {});

    // 4. Pay out exactly what the swap delivered: the measured balance change of the BUY token, never more than
    //    the swap's own Transfer events to the agent (so a deposit landing at the same moment is never paid on).
    const buyAfter = await balanceOf(pub, buy.address, account.address);
    const delta = buyAfter - buyBefore;
    const inSwap = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: sr.logs })
      .filter((l) => l.address.toLowerCase() === buy.address.toLowerCase() && l.args.to.toLowerCase() === account.address.toLowerCase())
      .reduce((sum, l) => sum + l.args.value, 0n);
    const received = delta < inSwap ? delta : inSwap;
    if (received <= 0n) throw new Error(`Swap succeeded but no ${buy.symbol} was received. Check ${hashes.swap}.`);
    if (c.usd === "buy") assertWithinCap(fmt(received), MAX_USD); // never pay out more dollars than the cap
    hashes.payout = await wallet.writeContract({ address: buy.address, abi: erc20Abi, functionName: "transfer", args: [recipient, received] });
    const pr = await pub.waitForTransactionReceipt({ hash: hashes.payout });
    if (pr.status !== "success") throw new Error(`Payout reverted (${hashes.payout}).`);

    // 5. Prove every transaction (reset, approval, swap, payout) carries our attribution tag.
    const tags = {};
    for (const [k, h] of Object.entries(hashes)) tags[k] = (await verifyTx({ client: pub, hash: h }))?.codes ?? null;
    const untagged = Object.keys(hashes).filter((k) => !tags[k]?.includes(ATTRIBUTION_CODE));
    const receiptUrl = receiptLink({ payout: hashes.payout, swap: hashes.swap, requestId });
    log({
      corridor: c.id, to, recipient, requestId,
      sold: { token: sell.symbol, amount: fmt(takerPays) },
      paid: { token: buy.symbol, amount: fmt(received) },
      usd: fmt(usdUnits),
      ...(c.id === "usdt-cngn" ? { usdtSpent: fmt(takerPays), cngnPaid: fmt(received) } : {}),
      hashes, tags, untagged, receiptUrl,
    });
    console.log(`Paid ${fmt(received)} ${buy.symbol} to ${to}.`);
    for (const [k, h] of Object.entries(hashes)) console.log(`  ${k}: https://celoscan.io/tx/${h}  tag=${JSON.stringify(tags[k])}`);
    console.log(`Receipt: ${receiptUrl}`);
    if (untagged.length) {
      console.error(`WARNING: missing attribution tag ${ATTRIBUTION_CODE} on: ${untagged.join(", ")}. These will not be credited.`);
      process.exitCode = 1;
    }
    return { hashes, tags, untagged, receiptUrl, paid: fmt(received), usd: fmt(usdUnits) };
  }
}
