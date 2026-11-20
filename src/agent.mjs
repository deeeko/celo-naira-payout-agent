#!/usr/bin/env node
// CLI entry point. Corridors: usdt-cngn (default, pay in naira) and cngn-usdt (pay in dollars).
//   node src/agent.mjs keygen                                   create the agent wallet (key never printed)
//   node src/agent.mjs status                                   balances, limits, today's total
//   node src/agent.mjs quote --amount 10 [--corridor ID]        free indicative price, no wallet needed
//   node src/agent.mjs pay --to ada --amount 10 [--corridor ID] DRY RUN (add --execute for real money)
//   node src/agent.mjs ask "send $10 to ada"                    same, from plain language
//   node src/agent.mjs request --to ada --amount 5 [--corridor ID] [--note TEXT] [--hours 48]
//                                                               create a payment link with a unique amount
//   node src/agent.mjs requests                                 list payment requests
//   node src/agent.mjs watch [--execute] [--interval 15]        autopilot: pay matched deposits (DRY RUN by default)
//   node src/agent.mjs retry --request ID [--execute] [--yes]  re-run a failed autopilot payout (DRY RUN by default)
//   node src/agent.mjs register --repo <url>                   ERC-8004 identity (DRY RUN unless --execute)
//   node src/agent.mjs verify <txHash>                          show the attribution tag on a transaction
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import {
  AGENT_ADDRESS, ATTRIBUTION_CODE, DEFAULT_CORRIDOR, IDENTITY_REGISTRY, MAX_DAILY_USD, MAX_USD, TOKENS,
} from "./config.mjs";
import { keygen, loadAccount, makeClients } from "./chain.mjs";
import { assertRecipient, dailyUsedUnits, getCorridor, parseAmount, resolveContact } from "./guards.mjs";
import { parseIntent } from "./intent.mjs";
import { confirm, loadContacts, pay, preflight, readReceipts } from "./pay.mjs";
import { createRequest, loadRequests, requestLink, requestStatus, retryBlocker, saveRequests } from "./requests.mjs";
import { preview } from "./textile.mjs";
import { register } from "./register8004.mjs";
import { watch } from "./watch.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n) => rest.includes(`--${n}`);
const corridorFlag = () => getCorridor(flag("corridor") ?? DEFAULT_CORRIDOR);

async function main() {
  switch (cmd) {
    case "keygen": {
      const r = keygen();
      console.log(r.created ? "Created agent wallet." : "Agent wallet already exists (not overwritten).");
      console.log(`Address: ${r.address}\nBack up the key file offline. Never open it in an editor with an AI assistant or paste it anywhere.`);
      break;
    }
    case "status": {
      const account = loadAccount();
      const { pub } = makeClients(account);
      const [celo, usdt, cngn, dec] = await Promise.all([
        pub.getBalance({ address: account.address }),
        pub.readContract({ address: TOKENS.USDT.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
        pub.readContract({ address: TOKENS.CNGN.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
        pub.readContract({ address: TOKENS.CNGN.address, abi: erc20Abi, functionName: "decimals" }),
      ]);
      const used = formatUnits(dailyUsedUnits(readReceipts()), 6);
      const open = loadRequests().filter((r) => requestStatus(r) === "open").length;
      console.log(`Agent: ${account.address}\nCELO: ${formatUnits(celo, 18)}  USDT: ${formatUnits(usdt, 6)}  cNGN: ${formatUnits(cngn, dec)}`);
      console.log(`Tag: ${ATTRIBUTION_CODE}  Per-payout cap: ${MAX_USD} USD  Daily cap: ${MAX_DAILY_USD} USD (used in last 24 h: ${used} USD)`);
      console.log(`Open payment requests: ${open}`);
      break;
    }
    case "quote": {
      const c = corridorFlag();
      const amount = parseAmount(flag("amount") ?? (c.sell === "USDT" ? "10" : "14400"));
      const pv = await preview(c.sellToken.address, c.buyToken.address, parseUnits(amount, 6).toString());
      if (pv.status === "preview") {
        console.log(`[${c.id}] ${amount} ${c.sellToken.symbol} -> ~${formatUnits(BigInt(pv.buyAmount), 6)} ${c.buyToken.symbol} (indicative, ${c.blurb})`);
      }
      console.log(JSON.stringify(pv, null, 2));
      break;
    }
    case "pay":
      await pay({ to: flag("to"), amount: flag("amount"), corridor: corridorFlag().id, execute: has("execute"), yes: has("yes") });
      break;
    case "ask": {
      const text = rest.filter((a) => !a.startsWith("--")).join(" ");
      const { contacts } = loadContacts();
      const intent = await parseIntent(text, [...contacts.keys()]);
      console.log(`Understood: pay ${intent.amount} USD to "${intent.to}"`);
      await pay({ to: intent.to, amount: intent.amount, execute: has("execute"), yes: has("yes") });
      break;
    }
    case "request": {
      const c = corridorFlag();
      const name = flag("to");
      if (!name || !flag("amount")) throw new Error("Usage: request --to NAME --amount N [--corridor ID] [--note TEXT] [--hours 48]");
      const { contacts, own } = loadContacts();
      const recipient = assertRecipient(resolveContact(name, contacts), {
        agent: loadAccount({ required: false })?.address ?? AGENT_ADDRESS,
        own,
        blocked: [TOKENS.USDT.address, TOKENS.CNGN.address, IDENTITY_REGISTRY],
      });
      const existing = loadRequests();
      const req = createRequest({
        name, amount: flag("amount"), corridor: c.id, note: flag("note"), hours: flag("hours") ?? 48, existing,
        // usdt-cngn: the amount is USD, so the cents suffix must keep it within the per-payout cap.
        maxUnits: c.usd === "sell" ? parseUnits(MAX_USD, 6) : undefined,
      });
      if (c.usd === "buy") {
        // cngn-usdt: the USD value is what the naira buys. Refuse links the autopilot would not be allowed to pay.
        const pv = await preview(c.sellToken.address, c.buyToken.address, parseUnits(req.amount, 6).toString());
        if (pv.status !== "preview") throw new Error(`No indicative price right now (${pv.status}); try again shortly.`);
        if (BigInt(pv.buyAmount) > parseUnits(MAX_USD, 6)) {
          throw new Error(`₦${req.amount} is worth ~${formatUnits(BigInt(pv.buyAmount), 6)} USD, over the per-payout cap of ${MAX_USD} USD. Use a smaller amount.`);
        }
        console.log(`At today's indicative rate ${req.name} would receive ~${formatUnits(BigInt(pv.buyAmount), 6)} USDT.`);
      }
      existing.push({ ...req, recipient });
      saveRequests(existing);
      console.log(`Request ${req.id} for ${req.name} (${c.blurb}), expires ${new Date(req.exp).toISOString()}.`);
      console.log(`The payer must send EXACTLY ${req.amount} ${c.sellToken.symbol} on Celo to ${loadAccount({ required: false })?.address ?? AGENT_ADDRESS}.`);
      console.log(`Link: ${requestLink(req)}`);
      console.log(`Run "node src/agent.mjs watch --execute" to pay it automatically when the deposit arrives.`);
      break;
    }
    case "requests": {
      const list = loadRequests();
      if (!list.length) { console.log('No payment requests yet. Create one with: node src/agent.mjs request --to NAME --amount N'); break; }
      for (const r of list) {
        const st = requestStatus(r);
        const sym = getCorridor(r.dir).sellToken.symbol;
        console.log(`${r.id}  ${st.padEnd(8)}  ${r.amount} ${sym}  ${r.dir}  ${r.name}  expires ${new Date(r.exp).toISOString()}`);
        if (r.note) console.log(`    note: ${r.note}`);
        if (r.deposit) console.log(`    deposit: ${r.deposit.tx} from ${r.deposit.payer}`);
        if (r.receiptUrl) console.log(`    receipt: ${r.receiptUrl}`);
        if (r.error) console.log(`    error: ${r.error} (not retried automatically${retryBlocker(r) ? "" : `; retry with: node src/agent.mjs retry --request ${r.id}`})`);
        console.log(`    link: ${requestLink(r)}`);
      }
      break;
    }
    case "retry": {
      // Re-run the payout of a request whose deposit is recorded but whose payout failed before any swap/payout tx.
      const id = flag("request");
      if (!id) throw new Error("Usage: retry --request ID [--execute] [--yes]");
      const r = loadRequests().find((x) => x.id === id);
      const blocker = retryBlocker(r);
      if (blocker) throw new Error(blocker);
      const execute = has("execute");
      const sym = getCorridor(r.dir).sellToken.symbol;
      console.log(`Retry ${r.id}: ${r.amount} ${sym} deposited by ${r.deposit.payer} (tx ${r.deposit.tx}) -> pay ${r.name} via ${r.dir}.`);
      console.log(`Last error: ${r.error}`);
      const args = { to: r.name, amount: r.amount, corridor: r.dir, requestId: r.id };
      if (!execute) { await pay({ ...args, execute: false }); break; }

      const { amountStr, pv, c } = await preflight({ ...args, agent: loadAccount().address });
      console.log(`Preview: ${amountStr} ${c.sellToken.symbol} -> ~${formatUnits(BigInt(pv.buyAmount), 6)} ${c.buyToken.symbol} for ${r.name}.`);
      if (!has("yes") && !(await confirm(`About to pay request ${r.id} for real on Celo MAINNET.`))) { console.log("Cancelled. Nothing was sent."); break; }
      // Mark the retry BEFORE sending (like watch records the deposit first): a crash mid-flow can never lead to a second retry.
      const mark = loadRequests();
      const m = mark.find((x) => x.id === id);
      const again = retryBlocker(m);
      if (again) throw new Error(again);
      m.retrying = new Date().toISOString();
      saveRequests(mark);
      let res;
      try {
        res = await pay({ ...args, execute: true, yes: true });
      } catch (e) {
        const after = loadRequests();
        const f = after.find((x) => x.id === id);
        f.error = e.message;
        if (e.hashes) f.hashes = e.hashes;
        delete f.retrying;
        saveRequests(after);
        throw new Error(`Retry of ${id} failed: ${e.message}. The error is saved on the request.`);
      }
      const after = loadRequests();
      const done = after.find((x) => x.id === id);
      Object.assign(done, { paidAt: new Date().toISOString(), hashes: res.hashes, receiptUrl: res.receiptUrl, paid: res.paid });
      delete done.error;
      delete done.retrying;
      saveRequests(after);
      console.log(`Request ${id} is paid.`);
      break;
    }
    case "watch":
      await watch({ execute: has("execute"), interval: flag("interval") ?? 15 });
      break;
    case "register":
      await register({ repoUrl: flag("repo") ?? "https://github.com/deeeko/celo-naira-payout-agent", execute: has("execute") });
      break;
    case "verify": {
      const hash = rest[0];
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? "")) throw new Error("Usage: verify <0x transaction hash>");
      const { pub } = makeClients(loadAccount());
      console.log(JSON.stringify(await verifyTx({ client: pub, hash }), null, 2));
      break;
    }
    default:
      console.log("Commands: keygen | status | quote | pay | ask | request | requests | watch | retry | register | verify  (see README)");
      process.exitCode = cmd ? 1 : 0;
  }
}

await main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
