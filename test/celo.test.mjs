// "Pay in naira from CELO" (celo-cngn): corridor parsing, CELO amounts, gas reserve, minimum, leg-2 amount. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { CELO_MIN_USDT, CELO_TOKEN, TOKENS } from "../src/config.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCeloMinimum, assertCeloReserve, assertRecipient, assertSlippage, getCorridor, getPayCorridor, measuredReceived,
  parseCeloAmount,
} from "../src/guards.mjs";
import { rfqBody } from "../src/textile.mjs";
import { createRequest } from "../src/requests.mjs";
import { finishCommand, leg2SellAmount, minCeloSell, payoutFailedNote, scaledPreviewBuy } from "../src/celo.mjs";
import { BLOCKED_RECIPIENTS, pay, preflight, registrationRecipient } from "../src/pay.mjs";
import { registrationError } from "../src/registrations.mjs";
import * as site from "../site/assets/core.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const C = (s) => parseUnits(s, 18);
const U = (s) => parseUnits(s, 6);

test("celo-cngn: pay/quote accept it (CELO -> USDT -> cNGN); payment links, Get paid and watch refuse it", () => {
  const c = getPayCorridor(" CELO-cNGN ");
  assert.equal(c.id, "celo-cngn");
  assert.equal(c.sellToken.address, "0x471EcE3750Da237f93B8E339c536989b8978a438");
  assert.equal(c.sellToken.decimals, 18);
  assert.equal(c.viaToken.address, TOKENS.USDT.address);
  assert.equal(c.buyToken.address, TOKENS.CNGN.address);
  assert.equal(getPayCorridor("usdt-cngn").sellToken.address, TOKENS.USDT.address); // the others still resolve
  assert.equal(getPayCorridor(undefined).id, "usdt-cngn");
  assert.throws(() => getPayCorridor("celo-usdt"), /Unknown corridor/);
  // Link flows go through getCorridor / createRequest: a clear refusal, not "unknown".
  assert.throws(() => getCorridor("celo-cngn"), /direct payouts only/);
  assert.throws(() => createRequest({ name: "Ada", amount: "20", corridor: "celo-cngn" }), /direct payouts only/);
  // Textile bodies: both legs are valid pairs; CELO is accepted only as a known token.
  const b1 = rfqBody(CELO_TOKEN.address, TOKENS.USDT.address, C("20").toString());
  assert.equal(b1.sellAmount, "20000000000000000000");
  assert.doesNotThrow(() => rfqBody(TOKENS.USDT.address, TOKENS.CNGN.address, "1091835"));
});

test("CELO amounts: 18-decimal units, at most 6 decimal places", () => {
  assert.deepEqual(parseCeloAmount("20"), { str: "20", units: 20_000_000_000_000_000_000n });
  assert.deepEqual(parseCeloAmount("20.5 CELO"), { str: "20.5", units: 20_500_000_000_000_000_000n });
  assert.equal(parseCeloAmount("1,000").units, C("1000"));
  assert.equal(parseCeloAmount("0.000001").units, 1_000_000_000_000n);
  for (const bad of ["0", "0.000000", "-1", "abc", "", "1.1234567", "1e3", "$20"]) assert.throws(() => parseCeloAmount(bad), bad);
});

test("gas reserve: balance - sold - gas margin must stay >= MIN_CELO_RESERVE", () => {
  const reserve = C("2");
  const margin = C("0.1");
  assert.equal(assertCeloReserve(C("30"), C("20"), reserve, margin), C("9.9"));
  assert.equal(assertCeloReserve(C("22.1"), C("20"), reserve, margin), C("2")); // exactly the reserve is fine
  // One unit short: 20 CELO is the smallest payout, so this is a top-up, not "sell less".
  assert.throws(() => assertCeloReserve(C("22.099999"), C("20"), reserve, margin), /holds 22\.099999 CELO; .*\(~22\.1 CELO\)\. Top up/);
  // Enough CELO for a smaller payout: the message names the most it could sell.
  assert.throws(() => assertCeloReserve(C("30"), C("30"), reserve, margin), /Sell at most 27\.9 CELO/);
  assert.throws(() => assertCeloReserve(C("30"), C("30"), reserve, margin), (e) => e.celoReserve === true);
});

test("gas reserve: the agent today (17 CELO) cannot make any CELO payout, so it asks for a top-up", () => {
  const reserve = C("2");
  const margin = C("0.1");
  const msg = "The agent wallet holds 17 CELO; a CELO payout needs about 20 CELO plus the 2 CELO reserve and gas (~22.1 CELO). " +
    "Top up the agent wallet first. Nothing was sent.";
  assert.throws(() => assertCeloReserve(C("17"), C("20"), reserve, margin), (e) => e.message === msg && e.celoReserve === true);
  // Even a smaller sale would fall under the ~$1 minimum, so "sell at most 14.9" is never suggested.
  assert.throws(() => assertCeloReserve(C("17"), C("15"), reserve, margin), (e) => e.message === msg);
  assert.throws(() => assertCeloReserve(C("1"), C("0.5"), reserve, margin), /holds 1 CELO; .*Top up the agent wallet first/);
  // The minimum sale follows the previewed price, rounded up to whole CELO (20 CELO -> 1.091835 USDT today).
  assert.equal(minCeloSell(C("20"), U("1.091835")), C("20"));
  assert.equal(minCeloSell(C("20"), U("2.1")), C("10"));
  assert.equal(minCeloSell(C("20"), 0n), C("20"));
  assert.throws(() => assertCeloReserve(C("15"), C("15"), reserve, margin, C("10")), /Sell at most 12\.9 CELO/);
});

test("leg 2: never sells more than leg 1's capped firm quote; firm quote checked against the confirmed preview", () => {
  assert.equal(leg2SellAmount(U("1.2"), U("1.091835")), U("1.091835")); // extra USDT stays in the agent wallet
  assert.equal(leg2SellAmount(U("1.09"), U("1.091835")), U("1.09"));
  const pv2 = { buyAmount: U("1500").toString(), sellAmount: U("1").toString() };
  assert.equal(scaledPreviewBuy(pv2, U("1"), U("2")), U("3000"));
  assert.equal(scaledPreviewBuy({ buyAmount: U("1500").toString() }, U("1"), U("1.1")), U("1650")); // no sellAmount: the requested size
  assert.doesNotThrow(() => assertSlippage(scaledPreviewBuy(pv2, U("1"), U("1")).toString(), U("1495").toString(), 100));
  assert.throws(() => assertSlippage(scaledPreviewBuy(pv2, U("1"), U("1")).toString(), U("1400").toString(), 100), /bps worse/);
});

test("payout failed after swap 2: exact recipient, exact cNGN, and a safe command", () => {
  const ADA = "0x2222222222222222222222222222222222222222";
  const n = payoutFailedNote({ to: "Ada Obi", recipient: ADA, agent: "0x1111111111111111111111111111111111111111", cngnUnits: U("1608.123456") });
  assert.match(n, /NOT paid/);
  assert.ok(n.includes(`It was meant for Ada Obi at ${ADA}: exactly 1608.123456 cNGN.`));
  assert.ok(n.includes('node src/agent.mjs pay --to "Ada Obi" --amount 1608.123456 --corridor cngn-usdt'));
  assert.ok(!/--corridor cngn-usdt --execute/.test(n)); // the printed command is a dry run first
  assert.match(payoutFailedNote({ to: "ada", recipient: ADA, agent: ADA, cngnUnits: 0n, payoutHash: "0xabc" }), /could not be measured[\s\S]*0xabc|0xabc[\s\S]*could not be measured/);
});

test("the CELO token contract is never a payout recipient (contacts, payment links, Get paid)", () => {
  const AGENT = "0x1111111111111111111111111111111111111111";
  assert.ok(BLOCKED_RECIPIENTS.some((a) => a.toLowerCase() === CELO_TOKEN.address.toLowerCase()));
  assert.throws(() => assertRecipient(CELO_TOKEN.address, { agent: AGENT, blocked: BLOCKED_RECIPIENTS }), /blocked/);
  assert.throws(() => assertRecipient(CELO_TOKEN.address.toLowerCase(), { agent: AGENT, blocked: BLOCKED_RECIPIENTS }), /blocked/);
  assert.throws(
    () => registrationRecipient(CELO_TOKEN.address, { agent: AGENT, payer: "0x3333333333333333333333333333333333333333" }),
    (e) => e.permanent === true && /blocked/.test(e.message),
  );
});

test("celo-cngn is refused by payment requests and Get paid registrations (before any network call)", async () => {
  const ADA = "0x2222222222222222222222222222222222222222";
  const BOB = "0x4444444444444444444444444444444444444444";
  await assert.rejects(pay({ to: "ada", amount: "20", corridor: "celo-cngn", requestId: "r1" }), /direct payouts only/);
  await assert.rejects(pay({ to: "Ada", amount: "20", corridor: "celo-cngn", recipientAddress: ADA, payer: BOB }), /direct payouts only/);
  await assert.rejects(preflight({ to: "Ada", amount: "20", corridor: "celo-cngn", recipientAddress: ADA, payer: BOB }), /direct payouts only/);
  const reg = { a: "20", d: "celo-cngn", e: 1_800_003_600, n: "Ada" };
  assert.equal(registrationError(reg, 1_800_000_000), "unknown corridor");
  assert.equal(site.registrationError(reg, 1_800_000_000), "unknown corridor");
});

test("ask refuses CELO amounts and points to the celo-cngn pay command", () => {
  const r = spawnSync(process.execPath, ["src/agent.mjs", "ask", "send 20 CELO to ada"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ask pays in USD only\. For CELO use: node src\/agent\.mjs pay --to NAME --amount N --corridor celo-cngn/);
});

test("minimum: leg 1 must buy at least ~1.05 USDT (Textile ~$1 per swap)", () => {
  const min = U(CELO_MIN_USDT);
  assert.equal(CELO_MIN_USDT, "1.05");
  assert.doesNotThrow(() => assertCeloMinimum(U("1.091835"), min)); // 20 CELO today
  assert.doesNotThrow(() => assertCeloMinimum(U("1.05"), min));
  assert.throws(() => assertCeloMinimum(U("1.049999"), min), /send at least ~20 CELO/);
  assert.throws(() => assertCeloMinimum("545917", min), /below Textile's ~\$1 minimum/); // 10 CELO today
});

test("leg 2 sells exactly the measured leg-1 output: balance delta capped by the swap's Transfer events", () => {
  assert.equal(measuredReceived(U("1.091835"), U("1.091835")), U("1.091835"));
  // A payment-link deposit landed in the same block: the delta is bigger, only the swap's own transfer counts.
  assert.equal(measuredReceived(U("6.121835"), U("1.091835")), U("1.091835"));
  // Fee-on-transfer or a concurrent outflow: the smaller delta wins.
  assert.equal(measuredReceived(U("1.09"), U("1.091835")), U("1.09"));
  assert.equal(measuredReceived(-5n, U("1")), 0n);
  assert.equal(measuredReceived(U("1"), 0n), 0n);
  // The recovery command if leg 2 or the payout fails: sell exactly that USDT via usdt-cngn.
  assert.equal(finishCommand("ada", U("1.091835")), "node src/agent.mjs pay --to ada --amount 1.091835 --corridor usdt-cngn --execute");
  assert.equal(finishCommand("Ada Obi", U("2")), 'node src/agent.mjs pay --to "Ada Obi" --amount 2 --corridor usdt-cngn --execute');
});
