#!/usr/bin/env node
// CLI entry point.
//   node src/agent.mjs keygen                      create the agent wallet (key never printed)
//   node src/agent.mjs status                      balances and limits
//   node src/agent.mjs quote --amount 10           free indicative price, no wallet needed
//   node src/agent.mjs pay --to ada --amount 10    DRY RUN (add --execute for real money)
//   node src/agent.mjs ask "send $10 to ada"       same, from plain language
//   node src/agent.mjs register --repo <url>       ERC-8004 identity (DRY RUN unless --execute)
//   node src/agent.mjs verify <txHash>             show the attribution tag on a transaction
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { ATTRIBUTION_CODE, MAX_USD, TOKENS } from "./config.mjs";
import { keygen, loadAccount, makeClients } from "./chain.mjs";
import { parseUsd } from "./guards.mjs";
import { parseIntent } from "./intent.mjs";
import { loadContacts, pay } from "./pay.mjs";
import { preview } from "./textile.mjs";
import { register } from "./register8004.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n) => rest.includes(`--${n}`);

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
      console.log(`Agent: ${account.address}\nCELO: ${formatUnits(celo, 18)}  USDT: ${formatUnits(usdt, 6)}  cNGN: ${formatUnits(cngn, dec)}`);
      console.log(`Tag: ${ATTRIBUTION_CODE}  Per-payout cap: ${MAX_USD} USD`);
      break;
    }
    case "quote": {
      const amount = parseUsd(flag("amount") ?? "10");
      const pv = await preview(parseUnits(amount, 6).toString());
      console.log(JSON.stringify(pv, null, 2));
      break;
    }
    case "pay":
      await pay({ to: flag("to"), amount: flag("amount"), execute: has("execute"), yes: has("yes") });
      break;
    case "ask": {
      const text = rest.filter((a) => !a.startsWith("--")).join(" ");
      const { contacts } = loadContacts();
      const intent = await parseIntent(text, [...contacts.keys()]);
      console.log(`Understood: pay ${intent.amount} USD to "${intent.to}"`);
      await pay({ to: intent.to, amount: intent.amount, execute: has("execute"), yes: has("yes") });
      break;
    }
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
      console.log("Commands: keygen | status | quote | pay | ask | register | verify  (see README)");
      process.exitCode = cmd ? 1 : 0;
  }
}

await main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
