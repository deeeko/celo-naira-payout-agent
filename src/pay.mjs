// The payout flow: preview -> firm quote -> approve -> swap (USDT -> cNGN) -> pay recipient.
// Dry-run by default. Real money moves only with execute=true AND an explicit confirmation.
import fs from "node:fs";
import readline from "node:readline/promises";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { ATTRIBUTION_CODE, CONTACTS_FILE, IDENTITY_REGISTRY, LOG_FILE, MAX_SLIPPAGE_BPS, MAX_USD, TOKENS } from "./config.mjs";
import { loadAccount, makeClients } from "./chain.mjs";
import { assertRecipient, assertSlippage, assertWithinCap, parseContacts, parseUsd, resolveContact } from "./guards.mjs";
import { firmQuote, preview, submit } from "./textile.mjs";

export function loadContacts() {
  if (!fs.existsSync(CONTACTS_FILE)) {
    throw new Error(`No contacts file. Copy contacts.example.json to contacts.json and add your recipient.`);
  }
  return parseContacts(JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8")));
}

const log = (entry) => fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} Type "yes" to continue: `)).trim().toLowerCase();
  rl.close();
  return answer === "yes";
}

export async function pay({ to, amount, execute = false, yes = false }) {
  const { contacts, own } = loadContacts();
  const amountUsd = parseUsd(amount);
  assertWithinCap(amountUsd, MAX_USD);
  const account = loadAccount({ required: execute });
  const recipient = assertRecipient(resolveContact(to, contacts), {
    agent: account?.address,
    own,
    blocked: [TOKENS.USDT.address, TOKENS.CNGN.address, IDENTITY_REGISTRY],
  });

  const sellAmount = parseUnits(amountUsd, TOKENS.USDT.decimals);
  const pv = await preview(sellAmount.toString());
  if (pv.status !== "preview") throw new Error(`No indicative price right now (${pv.status}).`);
  console.log(`Preview: ${amountUsd} USDT -> ~${pv.buyAmount} cNGN base units (fee ${pv.feeAmount}) for ${to} (${recipient})`);

  if (!execute) {
    console.log("DRY RUN: nothing was sent. Add --execute to run this for real.");
    return { dryRun: true };
  }

  const { pub, wallet } = makeClients(account);
  const cngnDecimals = await pub.readContract({ address: TOKENS.CNGN.address, abi: erc20Abi, functionName: "decimals" });
  const [usdtBal, cngnBefore, celoBal] = await Promise.all([
    pub.readContract({ address: TOKENS.USDT.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    pub.readContract({ address: TOKENS.CNGN.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    pub.getBalance({ address: account.address }),
  ]);
  if (usdtBal < sellAmount) throw new Error(`Agent wallet holds ${formatUnits(usdtBal, 6)} USDT, needs ${amountUsd}.`);
  if (celoBal < parseUnits("0.02", 18)) throw new Error("Agent wallet needs ~0.02 CELO for gas.");

  if (!yes && !(await confirm(`About to convert ${amountUsd} USDT to cNGN and pay ${to} on Celo MAINNET.`))) {
    console.log("Cancelled. Nothing was sent.");
    return { cancelled: true };
  }

  // 1. Firm quote (signs a no-funds proof of wallet control only if Textile asks).
  const q = await firmQuote(account, sellAmount.toString());
  assertSlippage(pv.buyAmount, q.quote.buyAmount, MAX_SLIPPAGE_BPS);
  const takerPays = BigInt(q.quote.takerPays);
  if (takerPays > sellAmount) throw new Error("Quote asks for more than the amount requested. Aborting.");
  const reactor = q.quote.reactor;
  console.log(`Firm quote: pay ${formatUnits(takerPays, 6)} USDT, receive ${formatUnits(BigInt(q.quote.buyAmount), cngnDecimals)} cNGN`);

  // 2. Approve only what is needed. USDT-style tokens reject nonzero -> nonzero approvals, so reset first.
  const allowance = await pub.readContract({
    address: TOKENS.USDT.address, abi: erc20Abi, functionName: "allowance", args: [account.address, reactor],
  });
  const hashes = {};
  if (allowance < takerPays) {
    if (allowance > 0n) {
      const reset = await wallet.writeContract({ address: TOKENS.USDT.address, abi: erc20Abi, functionName: "approve", args: [reactor, 0n] });
      await pub.waitForTransactionReceipt({ hash: reset });
    }
    const a = q.transactions.approval;
    hashes.approval = await wallet.sendTransaction({ to: a.to, data: a.data, value: BigInt(a.value) });
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

  // 4. Pay out exactly what the swap delivered.
  const cngnAfter = await pub.readContract({ address: TOKENS.CNGN.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const received = cngnAfter - cngnBefore;
  if (received <= 0n) throw new Error("Swap succeeded but no cNGN was received. Check the swap transaction.");
  hashes.payout = await wallet.writeContract({ address: TOKENS.CNGN.address, abi: erc20Abi, functionName: "transfer", args: [recipient, received] });
  const pr = await pub.waitForTransactionReceipt({ hash: hashes.payout });
  if (pr.status !== "success") throw new Error(`Payout reverted (${hashes.payout}).`);

  // 5. Prove every transaction carries our attribution tag.
  const tags = {};
  for (const [k, h] of Object.entries(hashes)) tags[k] = (await verifyTx({ client: pub, hash: h }))?.codes ?? null;
  const untagged = Object.keys(hashes).filter((k) => !tags[k]?.includes(ATTRIBUTION_CODE));
  log({ to, recipient, usdtSpent: formatUnits(takerPays, 6), cngnPaid: formatUnits(received, cngnDecimals), hashes, tags, untagged });
  console.log(`Paid ${formatUnits(received, cngnDecimals)} cNGN to ${to}.`);
  for (const [k, h] of Object.entries(hashes)) console.log(`  ${k}: https://celoscan.io/tx/${h}  tag=${JSON.stringify(tags[k])}`);
  if (untagged.length) {
    console.error(`WARNING: missing attribution tag ${ATTRIBUTION_CODE} on: ${untagged.join(", ")}. These will not be credited.`);
    process.exitCode = 1;
  }
  return { hashes, tags, untagged };
}
