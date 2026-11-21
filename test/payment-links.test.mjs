import { SITE_URL } from "../src/config.mjs";
// Corridors, payment requests, deposit matching, daily cap and watch helpers. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { TOKENS } from "../src/config.mjs";
import { assertDailyCap, dailyUsedUnits, getCorridor, parseAmount } from "../src/guards.mjs";
import { rfqBody } from "../src/textile.mjs";
import {
  createRequest, encodeRequest as nodeEncode, matchDeposit, newRequestId, publicRequest, receiptLink, requestLink,
  requestStatus, retryBlocker, uniqueAmount,
} from "../src/requests.mjs";
import { backoffMs, chunkRanges, initialFromBlock } from "../src/watch.mjs";
import { encodeRequest as siteEncode, parseRequest } from "../site/assets/core.js";

const H = 3_600_000;
const T0 = 1_764_000_000_000;

test("corridors: rfq bodies sell/buy the right tokens; unknown corridors and pairs are rejected", () => {
  const a = getCorridor("usdt-cngn");
  const b = getCorridor("cngn-usdt");
  assert.equal(getCorridor(undefined).id, "usdt-cngn"); // default
  const ab = rfqBody(a.sellToken.address, a.buyToken.address, "5030000");
  assert.deepEqual([ab.sellToken, ab.buyToken, ab.sellAmount, ab.chainId], [TOKENS.USDT.address, TOKENS.CNGN.address, "5030000", 42220]);
  const bb = rfqBody(b.sellToken.address, b.buyToken.address, "14400000000", "0x1111111111111111111111111111111111111111");
  assert.deepEqual([bb.sellToken, bb.buyToken, bb.sellAmount], [TOKENS.CNGN.address, TOKENS.USDT.address, "14400000000"]);
  assert.equal(bb.taker, "0x1111111111111111111111111111111111111111");
  assert.throws(() => getCorridor("usdt-btc"), /Unknown corridor/);
  assert.throws(() => rfqBody(TOKENS.USDT.address, TOKENS.USDT.address, "1"));
  assert.throws(() => rfqBody(TOKENS.USDT.address, "0x2222222222222222222222222222222222222222", "1"));
  assert.throws(() => rfqBody(TOKENS.USDT.address, TOKENS.CNGN.address, "0"));
  assert.equal(parseAmount("₦14,400.5"), "14400.5");
});

test("unique amounts: cents suffix, never equal to an open request, within the cap", () => {
  const seq = [0, 0.5, 0.999];
  for (const r of seq) {
    const v = uniqueAmount("5", [], { random: () => r });
    assert.match(v, /^5\.\d\d$/);
    assert.ok(v !== "5.00");
  }
  // Every other cent taken -> must pick the one free value.
  const taken = Array.from({ length: 99 }, (_, i) => (5 + (i + 1) / 100).toFixed(2)).filter((x) => x !== "5.42");
  assert.equal(uniqueAmount("5", taken), "5.42");
  assert.throws(() => uniqueAmount("5", [...taken, "5.42"]), /No unique amount/);
  // Cap: 24.50 + suffix must stay <= 25.
  for (let i = 0; i < 50; i++) assert.ok(parseUnits(uniqueAmount("24.5", [], { maxUnits: parseUnits("25", 6) }), 6) <= parseUnits("25", 6));
  assert.throws(() => uniqueAmount("25", [], { maxUnits: parseUnits("25", 6) }), /cap/);
});

test("createRequest only compares against OPEN requests and validates input", () => {
  const existing = [
    { id: "r_aaaaaaaa", amount: "5.01", dir: "usdt-cngn", created: T0 - 3 * H, exp: T0 + H },          // open
    { id: "r_bbbbbbbb", amount: "5.02", dir: "usdt-cngn", created: T0 - 9 * H, exp: T0 - H },          // expired
    { id: "r_cccccccc", amount: "5.03", dir: "usdt-cngn", created: T0 - 3 * H, exp: T0 + H, paidAt: "x" }, // paid
  ];
  // random() -> 0 picks the lowest free cent: 5.01 is taken (open), so 5.02 (only expired) is free.
  const r = createRequest({ name: "Ada Obi", amount: "5", existing, now: T0, random: () => 0, note: "School fees" });
  assert.equal(r.amount, "5.02");
  assert.match(r.id, /^r_[a-z0-9]{8}$/);
  assert.equal(r.exp - r.created, 48 * H);
  assert.equal(r.dir, "usdt-cngn");
  assert.throws(() => createRequest({ name: "", amount: "5" }), /Name/);
  assert.throws(() => createRequest({ name: "x".repeat(41), amount: "5" }), /Name/);
  assert.throws(() => createRequest({ name: "Ada", amount: "5", note: "n".repeat(81) }), /Note/);
  assert.throws(() => createRequest({ name: "Ada", amount: "5", hours: 0 }), /hours/);
  assert.throws(() => createRequest({ name: "Ada", amount: "5", corridor: "x" }), /corridor/);
  assert.match(newRequestId(), /^r_[a-z0-9]{8}$/);
});

test("request ids: one uniform randomInt(36) draw per character, full base36 range", () => {
  const calls = [];
  const seq = [0, 35, 10, 9, 1, 34, 18, 27];
  const id = newRequestId((n) => { calls.push(n); return seq[calls.length - 1]; });
  assert.deepEqual(calls, Array(8).fill(36));
  assert.equal(id, "r_0za91yir");
  assert.equal(createRequest({ name: "Ada", amount: "5", now: T0, randomInt: () => 35 }).id, "r_zzzzzzzz");
});

test("retry eligibility: only a recorded deposit, unpaid, with an error and no swap/payout sent", () => {
  const base = { id: "r_fail0001", name: "Ada", amount: "5.03", dir: "usdt-cngn", created: T0, exp: T0 + 48 * H,
    deposit: { tx: "0x1", payer: "0x2" }, error: "No indicative price right now (unavailable)." };
  const hash = `0x${"ab".repeat(32)}`;
  assert.equal(retryBlocker(base), null);
  assert.equal(retryBlocker({ ...base, hashes: { approval: hash } }), null);          // approval alone moves no funds
  assert.match(retryBlocker(undefined), /No request/);
  assert.match(retryBlocker({ ...base, paidAt: "2026-11-20T00:00:00Z" }), /already paid/);
  assert.match(retryBlocker({ ...base, deposit: undefined }), /no recorded deposit/);
  assert.match(retryBlocker({ ...base, error: undefined }), /no saved error/);
  assert.match(retryBlocker({ ...base, retrying: "2026-11-20T00:00:00Z" }), /in progress/);
  assert.match(retryBlocker({ ...base, hashes: { payout: hash } }), /pay twice/);
  assert.match(retryBlocker({ ...base, hashes: { approval: hash, swap: hash } }), /pay twice/);
  assert.match(retryBlocker({ ...base, error: `Payout reverted (${hash}).` }), /pay twice/); // older record, hash only in the text
});

test("request links: Node encoding is identical to core.js and parses with core.js parseRequest", () => {
  const r = createRequest({ name: "Ada Obi ₦", amount: "14400", corridor: "cngn-usdt", note: "Rent — Nov", now: T0, random: () => 0.3 });
  const pub = publicRequest({ ...r, recipient: "0xabc", deposit: { tx: "0x1" } });
  assert.deepEqual(Object.keys(pub), ["v", "id", "name", "amount", "dir", "created", "exp", "note"]);
  assert.equal(nodeEncode(pub), siteEncode(pub));
  const link = requestLink(r);
  assert.ok(link.startsWith(`${SITE_URL}/pay.html#r=`) && /#r=[A-Za-z0-9_-]+$/.test(link), link);
  assert.deepEqual(parseRequest(link.split("#r=")[1]), pub);
  const noNote = createRequest({ name: "Ada", amount: "5", now: T0 });
  assert.equal("note" in parseRequest(requestLink(noNote).split("#r=")[1]), false);
  assert.equal(
    receiptLink({ payout: "0xp", swap: "0xs", requestId: "r_abc12345" }),
    `${SITE_URL}/receipt.html#p=0xp&s=0xs&r=r_abc12345`,
  );
  assert.equal(receiptLink({ payout: "0xp" }), `${SITE_URL}/receipt.html#p=0xp`);
});

test("deposit matching: token, exact amount, time window, expiry, already paid / received", () => {
  const usdtReq = { id: "r_usdt0001", name: "Ada", amount: "5.03", dir: "usdt-cngn", created: T0, exp: T0 + 48 * H };
  const ngnReq = { id: "r_ngn00001", name: "Bola", amount: "14400.37", dir: "cngn-usdt", created: T0, exp: T0 + 48 * H };
  const list = [usdtReq, ngnReq];
  const dep = (token, amount, timeMs) => ({ token, value: parseUnits(amount, 6), timeMs });
  const U = TOKENS.USDT.address, N = TOKENS.CNGN.address;
  assert.equal(matchDeposit(dep(U, "5.03", T0 + H), list)?.id, "r_usdt0001");
  assert.equal(matchDeposit(dep(U.toLowerCase(), "5.03", T0 + H), list)?.id, "r_usdt0001");
  assert.equal(matchDeposit(dep(N, "14400.37", T0 + H), list)?.id, "r_ngn00001");
  assert.equal(matchDeposit(dep(N, "5.03", T0 + H), list), null);          // wrong token
  assert.equal(matchDeposit(dep(U, "5.03", T0 + H), [ngnReq]), null);       // token is the SELL token only
  assert.equal(matchDeposit(dep(U, "5.04", T0 + H), list), null);          // not exact
  assert.equal(matchDeposit(dep(U, "5.030001", T0 + H), list), null);      // not exact (sub-cent)
  assert.equal(matchDeposit(dep(U, "5.03", T0 - 5000), list), null);       // before the request existed
  assert.equal(matchDeposit(dep(U, "5.03", T0 + 48 * H), list), null);     // at/after expiry
  assert.equal(matchDeposit(dep(U, "5.03", T0 + 48 * H - 1000), list)?.id, "r_usdt0001");
  assert.equal(matchDeposit(dep(U, "5.03", T0 + H), [{ ...usdtReq, paidAt: "2026-01-01" }]), null);
  assert.equal(matchDeposit(dep(U, "5.03", T0 + H), [{ ...usdtReq, deposit: { tx: "0x1" } }]), null);
  assert.equal(matchDeposit(dep(U, "5.03", T0 + H), [{ ...usdtReq, dir: "nope" }]), null);
  assert.equal(requestStatus(usdtReq, T0 + H), "open");
  assert.equal(requestStatus(usdtReq, T0 + 48 * H), "expired");
  assert.equal(requestStatus({ ...usdtReq, deposit: {} }, T0), "received");
  assert.equal(requestStatus({ ...usdtReq, deposit: {}, paidAt: "x" }, T0 + 99 * H), "paid");
});

test("daily cap: rolling 24 h sum of executed payouts in USD", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const e = (hoursAgo, fields) => ({ at: new Date(now - hoursAgo * H).toISOString(), hashes: { payout: "0x1" }, ...fields });
  const entries = [
    e(1, { usd: "25" }),
    e(23.9, { usdtSpent: "10.5" }),         // legacy usdt-cngn entry
    e(24.1, { usd: "25" }),                 // outside the window
    { ...e(2, { usd: "25" }), hashes: {} }, // never paid out
    e(3, { type: "unmatched_deposit" }),
    e(0.5, { usd: "9.977" }),               // cngn-usdt: USD bought
  ];
  assert.equal(dailyUsedUnits(entries, now), parseUnits("45.477", 6));
  assert.equal(dailyUsedUnits([], now), 0n);
  assert.doesNotThrow(() => assertDailyCap(parseUnits("45.477", 6), parseUnits("54.523", 6), "100"));
  assert.throws(() => assertDailyCap(parseUnits("45.477", 6), parseUnits("54.524", 6), "100"), /daily cap/);
});

test("watch helpers: <=5000-block chunks, start block covers oldest open request, capped backoff", () => {
  assert.deepEqual(chunkRanges(1n, 12000n), [[1n, 5000n], [5001n, 10000n], [10001n, 12000n]]);
  assert.deepEqual(chunkRanges(10n, 10n), [[10n, 10n]]);
  assert.deepEqual(chunkRanges(11n, 10n), []);
  for (const [a, b] of chunkRanges(0n, 123456n)) assert.ok(b - a + 1n <= 5000n);
  const now = T0 + H;
  assert.equal(initialFromBlock(1_000_000n, [], now), 1_000_000n);
  assert.equal(initialFromBlock(1_000_000n, [{ amount: "5.01", created: T0, exp: T0 + 48 * H }], now), 1_000_000n - 3600n - 120n);
  assert.equal(initialFromBlock(1_000_000n, [{ amount: "5.01", created: T0 - 99 * H, exp: T0 }], now), 1_000_000n); // expired ignored
  assert.equal(initialFromBlock(100n, [{ amount: "5.01", created: T0, exp: T0 + 48 * H }], now), 0n);
  assert.equal(backoffMs(15000, 0), 15000);
  assert.equal(backoffMs(15000, 2), 60000);
  assert.equal(backoffMs(15000, 20), 300000);
});
