// The site's tiny ABI codec must match viem byte-for-byte, since pages use it to build
// wallet transactions (reviews) and to read the reputation registry.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData } from "viem";
import { abiDecode, abiEncode, encodeCall, SEL, tagSuffix, decodeTag, TAG, encodeRequest, parseRequest,
  encodeRegistration, decodeRegistration, registrationError, registrationStatuses, receiptNo, parseReceiptNo } from "../site/assets/core.js";

test("Get-paid registrations: encode -> decode round-trip, tag present, validation", () => {
  const req = { a: "5.03", d: "usdt-cngn", e: 1_800_000_000, n: "Ada Obi", m: "logo design" };
  const data = encodeRegistration(req);
  assert.deepEqual(decodeTag(data).codes, [TAG]);
  assert.deepEqual(decodeRegistration(data), req);
  assert.equal(decodeRegistration("0xa9059cbb" + "00".repeat(64)), null);
  assert.equal(registrationError(req, 1_800_000_000 - 3600), null);
  assert.match(registrationError(req, 1_800_000_000 - 200 * 3600), /168 hours/);
  assert.match(registrationError({ ...req, a: "25" }, null), /24\.99/);
  assert.match(registrationError({ ...req, a: "5.033" }, null), /amount/);
  assert.throws(() => encodeRegistration({ ...req, d: "usdt-btc" }));
});

test("same-amount rule: earliest unexpired registration wins, later ones are in use", () => {
  const base = { d: "usdt-cngn", n: "x", e: 2_000 };
  const regs = [
    { hash: "0xb", from: "0x2", block: 10, position: 3, time: 100, req: { ...base, a: "5.03" } },
    { hash: "0xa", from: "0x1", block: 10, position: 1, time: 100, req: { ...base, a: "5.03" } },
    { hash: "0xc", from: "0x3", block: 11, position: 0, time: 101, req: { ...base, a: "5.04" } },
    { hash: "0xd", from: "0x4", block: 9, position: 0, time: 90, req: { ...base, a: "5.03", e: 500 } }, // expired at now=1000
    { hash: "0xe", from: "0x5", block: 12, position: 0, time: 102, req: { ...base, a: "5.03", d: "cngn-usdt" } }, // other corridor
  ];
  const s = registrationStatuses(regs, 1_000);
  assert.equal(s.get("0xa"), "active");
  assert.equal(s.get("0xb"), "in-use");
  assert.equal(s.get("0xc"), "active");
  assert.equal(s.get("0xd"), "expired");
  assert.equal(s.get("0xe"), "active");
});

test("receipt numbers", () => {
  const h = "0x7f3a91c2" + "ab".repeat(28);
  assert.equal(receiptNo(h), "NP-7F3A-91C2");
  assert.equal(parseReceiptNo("np-7f3a-91c2"), "0x7f3a91c2");
  assert.equal(parseReceiptNo("NP-7F3A91C2"), "0x7f3a91c2");
  assert.equal(parseReceiptNo("NP-XYZ"), null);
});

test("giveFeedback calldata matches viem", () => {
  const args = [10079n, 80n, 0, "starred", "payout", "https://x.y/r", "", "0x" + "00".repeat(32)];
  const viem = encodeFunctionData({ abi: [{ type: "function", name: "giveFeedback", inputs: ["uint256", "int128", "uint8", "string", "string", "string", "string", "bytes32"].map((type) => ({ type })) }], args });
  const ours = encodeCall(SEL.giveFeedback, ["uint256", "int128", "uint8", "string", "string", "string", "string", "bytes32"], args);
  assert.equal(ours, viem);
});

test("readAllFeedback outputs decode like viem (incl. negative int128 and string[])", () => {
  const types = ["address[]", "uint64[]", "int128[]", "uint8[]", "string[]", "string[]", "bool[]"];
  const vals = [["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"], [1n, 3n], [-80n, 95n], [0, 2], ["starred", "naïve ₦"], ["payout", ""], [false, true]];
  const hex = encodeAbiParameters(types.map((type) => ({ type })), vals);
  assert.equal("0x" + abiEncode(types, vals), hex);
  const ours = abiDecode(types, hex);
  const theirs = decodeAbiParameters(types.map((type) => ({ type })), hex);
  assert.deepEqual(ours[0].map((a) => a.toLowerCase()), theirs[0].map((a) => a.toLowerCase()));
  assert.deepEqual(ours[1], theirs[1]);
  assert.deepEqual(ours[2], theirs[2]);
  assert.deepEqual(ours[3].map(Number), theirs[3].map(Number));
  assert.deepEqual(ours[4], theirs[4]);
  assert.deepEqual(ours[5], theirs[5]);
  assert.deepEqual(ours[6], theirs[6]);
});

test("tag suffix round-trips through decodeTag", () => {
  assert.deepEqual(decodeTag("0xa9059cbb" + "00".repeat(64) + tagSuffix()).codes, [TAG]);
});

test("payment request links round-trip and reject tampering", () => {
  const req = { v: 1, id: "r_k3x9q2ab", name: "Ada Obi", amount: "5.03", dir: "usdt-cngn", created: 1764000000000, exp: 1764172800000, note: "School fees" };
  assert.deepEqual(parseRequest(encodeRequest(req)), req);
  assert.throws(() => parseRequest(encodeRequest({ ...req, dir: "usdt-btc" })));
  assert.throws(() => parseRequest(encodeRequest({ ...req, amount: "5.0.3" })));
  assert.throws(() => parseRequest("not-a-link"));
});
