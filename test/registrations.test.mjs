// "Get paid" registrations: the Node port must agree with site/assets/core.js, matching, per-wallet cap,
// self-payment refusal and receipt numbers. No network (Blockscout and RPC are faked).
import test from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { SITE_URL, TOKENS } from "../src/config.mjs";
import { assertWalletCap, walletUsedUnits } from "../src/guards.mjs";
import { BLOCKED_RECIPIENTS, registrationRecipient } from "../src/pay.mjs";
import { createRequest, parseReceiptNo, receiptNo, receiptNoLink } from "../src/requests.mjs";
import {
  decodeRegistration, discoverRegistrations, listStatus, matchRegistration, registrationError, registrationFromItem,
  registrationStatuses, verifyRegistrationOnchain,
} from "../src/registrations.mjs";
import * as site from "../site/assets/core.js";

const AGENT = "0x8a695cf54CB44753c8b784EB36d266f748617a1e";
const ADA = "0x2222222222222222222222222222222222222222";
const BOB = "0x4444444444444444444444444444444444444444";
const ME = "0x3333333333333333333333333333333333333333";
const T = 1_800_000_000; // registration block time (s)
const reg = (over = {}, req = {}) => ({
  hash: "0x" + "a1".repeat(32), from: ADA, block: 100, position: 1, time: T,
  ...over, req: { a: "5.03", d: "usdt-cngn", e: T + 48 * 3600, n: "Ada Obi", ...req },
});

test("port: registrationError matches core.js on valid and invalid bodies", () => {
  const ok = { a: "5.03", d: "usdt-cngn", e: T + 3600, n: "Ada", m: "logo" };
  const cases = [
    [ok, T], [ok, null], [{ ...ok, a: "25" }, T], [{ ...ok, a: "24.99" }, T], [{ ...ok, a: "0.99" }, T], [{ ...ok, a: "1" }, T],
    [{ ...ok, a: "5.033" }, T], [{ ...ok, a: 5 }, T], [{ ...ok, a: "0" }, T], [{ ...ok, a: "-1" }, T], [{ ...ok, a: "1e1" }, T],
    [{ ...ok, d: "cngn-usdt", a: "14400.50" }, T], [{ ...ok, d: "usdt-btc" }, T], [{ ...ok, d: "toString" }, T],
    [{ ...ok, n: "" }, T], [{ ...ok, n: "   " }, T], [{ ...ok, n: "x".repeat(40) }, T], [{ ...ok, n: "x".repeat(41) }, T], [{ ...ok, n: 7 }, T],
    [{ ...ok, m: "y".repeat(80) }, T], [{ ...ok, m: "y".repeat(81) }, T], [{ ...ok, m: null }, T], [{ ...ok, m: 3 }, T],
    [{ ...ok, e: T }, T], [{ ...ok, e: T + 168 * 3600 }, T], [{ ...ok, e: T + 168 * 3600 + 1 }, T], [{ ...ok, e: T + 1.5 }, T], [{ ...ok, e: "1" }, T],
    [null, T], ["NP1", T], [[], T], [{}, T],
  ];
  for (const [r, bt] of cases) assert.equal(registrationError(r, bt), site.registrationError(r, bt), JSON.stringify(r));
});

test("port: decodeRegistration matches core.js (tagged, untagged, foreign tag, garbage)", () => {
  const bodies = [
    { a: "5.03", d: "usdt-cngn", e: T + 3600, n: "Ada Obi", m: "logo design" },
    { a: "14400", d: "cngn-usdt", e: T + 7200, n: "Chidi ₦ Okafor" },
  ];
  const hex = (s) => Buffer.from(s, "utf8").toString("hex");
  const inputs = [];
  for (const b of bodies) {
    const tagged = site.encodeRegistration(b);
    inputs.push(tagged, tagged.toUpperCase().replace("0X", "0x"), tagged.slice(0, -site.tagSuffix().length));
    inputs.push("0x" + hex("NP1:" + JSON.stringify(b)) + hex("other_code") + "0a" + "00" + "80218021802180218021802180218021");
  }
  inputs.push("0x", "", null, undefined, "0xa9059cbb" + "00".repeat(64), "0x" + hex("NP1:{not json"), "0x" + hex("NP2:{}"), "0x" + hex("NP1:\"str\""));
  for (const i of inputs) assert.deepEqual(decodeRegistration(i), site.decodeRegistration(i), String(i).slice(0, 40));
  assert.deepEqual(decodeRegistration(site.encodeRegistration(bodies[1])), bodies[1]);
});

test("port: registrationStatuses matches core.js on random sets (collisions, expiry, invalid, ordering)", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const regs = Array.from({ length: 1 + rnd(12) }, (_, i) => {
      const time = 1000 + rnd(50);
      return {
        hash: "0x" + i.toString(16).padStart(4, "0"), from: ADA, block: 10 + rnd(5), position: rnd(4), time,
        req: { a: ["5.03", "5.030", "5.04", "25", "5.03"][rnd(5)], d: ["usdt-cngn", "cngn-usdt", "nope"][rnd(3)], e: time + [0, 60, 3600, 7200, 999999][rnd(5)], n: ["Ada", ""][rnd(2) && rnd(2)] },
      };
    });
    const now = 1000 + rnd(8000);
    assert.deepEqual([...registrationStatuses(regs, now)].sort(), [...site.registrationStatuses(regs, now)].sort(), `round ${round}`);
  }
});

test("port: receipt numbers match core.js", () => {
  for (const h of ["0x7f3a91c2" + "ab".repeat(28), "0x" + "0".repeat(64), "0xABCDEF0123" + "1".repeat(54)]) {
    assert.equal(receiptNo(h), site.receiptNo(h));
    assert.equal(parseReceiptNo(receiptNo(h)), site.parseReceiptNo(site.receiptNo(h)));
  }
  assert.equal(receiptNo("0x7f3a91c2" + "ab".repeat(28)), "NP-7F3A-91C2");
  for (const s of ["np-7f3a-91c2", "NP-7F3A91C2", " NP-7F3A-91C2 ", "NP-XYZ", "", null, "NP-7F3A-91C"]) assert.equal(parseReceiptNo(s), site.parseReceiptNo(s));
  assert.equal(receiptNoLink("NP-7F3A-91C2"), `${SITE_URL}/receipt.html#NP-7F3A-91C2`);
});

test("matching: token, exact 6-dp amount, registration time <= deposit < expiry, active only, one payout", () => {
  const USDT = TOKENS.USDT.address;
  const CNGN = TOKENS.CNGN.address;
  const a = reg();
  const dep = (over = {}) => ({ token: USDT, value: parseUnits("5.03", 6), timeMs: (T + 60) * 1000, ...over });
  assert.equal(matchRegistration(dep(), [a]).reg, a);
  assert.equal(matchRegistration(dep(), [a]).used, false);
  assert.equal(matchRegistration(dep({ token: CNGN }), [a]), null); // wrong token (sell token of usdt-cngn is USDT)
  assert.equal(matchRegistration(dep({ value: parseUnits("5.03", 6) + 1n }), [a]), null); // not exact
  assert.equal(matchRegistration(dep({ value: parseUnits("5.0299", 6) }), [a]), null);
  assert.equal(matchRegistration(dep({ timeMs: (T - 1) * 1000 }), [a]), null); // before the registration
  assert.equal(matchRegistration(dep({ timeMs: T * 1000 }), [a]).reg, a); // same block second
  assert.equal(matchRegistration(dep({ timeMs: a.req.e * 1000 }), [a]), null); // at expiry
  assert.equal(matchRegistration(dep({ timeMs: (a.req.e - 1) * 1000 }), [a]).reg, a);
  // cngn-usdt sells cNGN
  const n = reg({ hash: "0x" + "b2".repeat(32) }, { d: "cngn-usdt", a: "14400.25" });
  assert.equal(matchRegistration({ token: CNGN, value: parseUnits("14400.25", 6), timeMs: (T + 5) * 1000 }, [n]).reg, n);
  assert.equal(matchRegistration({ token: USDT, value: parseUnits("14400.25", 6), timeMs: (T + 5) * 1000 }, [n]), null);
  // same amount: the earliest is active, the later one ("amount in use") is never matched
  const later = reg({ hash: "0x" + "c3".repeat(32), from: BOB, block: 101, position: 0, time: T + 10 });
  assert.equal(matchRegistration(dep({ timeMs: (T + 20) * 1000 }), [later, a]).reg, a);
  // ...until the earlier one expires: then the later one is active at the deposit's time
  const short = reg({}, { e: T + 3600 });
  assert.equal(matchRegistration(dep({ timeMs: (T + 3600) * 1000 }), [short, later]).reg, later);
  // invalid registrations never match
  assert.equal(matchRegistration(dep(), [reg({}, { a: "25" })]), null);
  assert.equal(matchRegistration(dep(), [reg({}, { e: T + 200 * 3600 })]), null);
  // one payout per registration: a recorded deposit or payout marks it used
  assert.equal(matchRegistration(dep(), [a], { [a.hash]: { deposit: { tx: "0x1" } } }).used, true);
  assert.equal(matchRegistration(dep(), [a], { [a.hash]: { paidAt: "x" } }).used, true);
  // list status
  const st = registrationStatuses([a, later], T + 30);
  assert.equal(listStatus(a, st, undefined), "active");
  assert.equal(listStatus(later, st, undefined), "in-use");
  assert.equal(listStatus(a, st, { deposit: {} }), "received");
  assert.equal(listStatus(a, st, { deposit: {}, paidAt: "x" }), "paid");
});

test("per-wallet cap: rolling 24 h per recipient, any source, executed payouts only", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const at = (h) => new Date(now - h * 3_600_000).toISOString();
  const entries = [
    { at: at(1), recipient: ADA, usd: "10", hashes: { payout: "0x1" } },
    { at: at(2), recipient: ADA.toUpperCase().replace("0X", "0x"), usd: "5.5", hashes: { payout: "0x2" } },
    { at: at(3), recipient: ADA, usd: "9", hashes: {} }, // not executed
    { at: at(25), recipient: ADA, usd: "20", hashes: { payout: "0x3" } }, // older than 24 h
    { at: at(1), recipient: BOB, usd: "20", hashes: { payout: "0x4" } },
    { type: "unmatched_deposit", at: at(1), amount: "5" },
  ];
  assert.equal(walletUsedUnits(entries, ADA, now), parseUnits("15.5", 6));
  assert.equal(walletUsedUnits(entries, BOB, now), parseUnits("20", 6));
  assert.equal(walletUsedUnits(entries, ME, now), 0n);
  assert.doesNotThrow(() => assertWalletCap(parseUnits("15.5", 6), parseUnits("9.5", 6), "25"));
  assert.throws(() => assertWalletCap(parseUnits("15.5", 6), parseUnits("9.51", 6), "25"), /per-wallet cap of 25 USD/);
});

test("registration recipient: payer == recipient and blocked wallets are permanent refusals", () => {
  assert.equal(registrationRecipient(ADA, { agent: AGENT, payer: BOB, own: [ME] }), ADA);
  const refused = (addr, payer = BOB) => assert.throws(() => registrationRecipient(addr, { agent: AGENT, payer, own: [ME] }), (e) => e.permanent === true);
  refused(ADA, ADA); // self-payment
  refused(ADA, ADA.toUpperCase().replace("0X", "0x")); // self-payment, different case
  refused(AGENT);
  refused(ME);
  refused("0x0000000000000000000000000000000000000000");
  for (const c of BLOCKED_RECIPIENTS) refused(c);
  assert.ok(BLOCKED_RECIPIENTS.some((a) => a.toLowerCase() === site.REPUTATION.toLowerCase()));
  assert.ok(BLOCKED_RECIPIENTS.some((a) => a.toLowerCase() === site.REGISTRY.toLowerCase()));
});

test("discovery: Blockscout pages, filters like core.js, stops at sinceSec, refuses a partial list", async () => {
  const body = { a: "5.03", d: "usdt-cngn", e: T + 3600, n: "Ada" };
  const item = (i, over = {}) => ({
    hash: "0x" + String(i).padStart(64, "0"), status: "ok", to: { hash: AGENT.toLowerCase() }, from: { hash: ADA },
    block_number: 100 + i, position: 0, timestamp: new Date((T + i) * 1000).toISOString(), raw_input: site.encodeRegistration(body), ...over,
  });
  const pages = [
    { items: [item(5), item(4, { status: "error" }), item(3, { raw_input: "0xa9059cbb" })], next_page_params: { block_number: 3, index: 0 } },
    { items: [item(2, { to: { hash: BOB } }), item(1)], next_page_params: null },
  ];
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => pages[urls.length - 1] }; };
  const regs = await discoverRegistrations({ agent: AGENT, api: "https://x/api/v2", fetchImpl });
  assert.deepEqual(regs.map((r) => r.block), [101, 105]); // oldest first; failed, non-registration and not-to-agent skipped
  assert.equal(regs[0].time, T + 1);
  assert.match(urls[0], /\/addresses\/0x8a69.*\/transactions\?filter=to$/);
  assert.match(urls[1], /filter=to&block_number=3&index=0/);
  // same filter as core.js loadRegistrations
  for (const t of [...pages[0].items, ...pages[1].items]) {
    const keep = t.status === "ok" && t.to?.hash?.toLowerCase() === AGENT.toLowerCase() && site.decodeRegistration(t.raw_input);
    assert.equal(!!registrationFromItem(t, AGENT), !!keep);
  }
  // sinceSec: page 1 already reaches back before it -> no second request
  urls.length = 0;
  await discoverRegistrations({ agent: AGENT, api: "https://x/api/v2", fetchImpl, sinceSec: T + 4 });
  assert.equal(urls.length, 1);
  // more pages than allowed -> throw, never a silent partial list
  const endless = async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_page_params: { p: 1 } }) });
  await assert.rejects(discoverRegistrations({ agent: AGENT, api: "https://x", fetchImpl: endless, maxPages: 3 }), /partial/);
});

test("onchain re-check: a registration that differs over RPC is refused, a matching one passes", async () => {
  const body = { a: "5.03", d: "usdt-cngn", e: T + 3600, n: "Ada" };
  const r = reg({ block: 100, position: 2, time: T }, body);
  r.req = body;
  const pub = (over = {}) => ({
    getTransaction: async () => ({ from: ADA.toLowerCase(), to: AGENT.toLowerCase(), input: site.encodeRegistration(body), blockNumber: 100n, transactionIndex: 2, ...over.tx }),
    getTransactionReceipt: async () => ({ status: "success", ...over.rc }),
    getBlock: async () => ({ timestamp: BigInt(T), ...over.block }),
  });
  assert.deepEqual(await verifyRegistrationOnchain(pub(), r, AGENT), { from: ADA, time: T });
  const refused = (p) => assert.rejects(verifyRegistrationOnchain(p, r, AGENT), (e) => e.permanent === true);
  await refused(pub({ rc: { status: "reverted" } }));
  await refused(pub({ tx: { from: BOB } }));
  await refused(pub({ tx: { to: BOB } }));
  await refused(pub({ tx: { transactionIndex: 3 } }));
  await refused(pub({ tx: { input: site.encodeRegistration({ ...body, a: "5.04" }) } }));
  await refused(pub({ block: { timestamp: BigInt(T + 1) } }));
});

test("request amounts avoid active registration amounts (reserved)", () => {
  const now = T * 1000;
  // random() -> 0 picks the lowest free cent; 5.01 and 5.02 are reserved by registrations.
  const r = createRequest({ name: "Ada", amount: "5", now, random: () => 0, reserved: ["5.01", "5.02"] });
  assert.equal(r.amount, "5.03");
});
