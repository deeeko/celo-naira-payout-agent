// The site's tiny ABI codec must match viem byte-for-byte, since pages use it to build
// wallet transactions (reviews) and to read the reputation registry.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData } from "viem";
import { abiDecode, abiEncode, encodeCall, SEL, tagSuffix, decodeTag, TAG, encodeRequest, parseRequest } from "../site/assets/core.js";

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
