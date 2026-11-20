// The Vercel explorer proxy must only forward public read endpoints, and the API must reject other methods.
import test from "node:test";
import assert from "node:assert/strict";
import handler, { upstreamUrl } from "../api/explorer/[...path].js";

const A = "0x8a695cf54CB44753c8b784EB36d266f748617a1e";

test("explorer proxy: allowed paths map to Blockscout with their query", () => {
  assert.equal(upstreamUrl(["addresses", A, "transactions"], { filter: "from", path: ["addresses", A, "transactions"] }),
    `https://celo.blockscout.com/api/v2/addresses/${A}/transactions?filter=from`);
  assert.equal(upstreamUrl(["transactions", "0x" + "ab".repeat(32)], {}), "https://celo.blockscout.com/api/v2/transactions/0x" + "ab".repeat(32));
  assert.match(upstreamUrl(["addresses", A, "token-transfers"], { type: "ERC-20".toLowerCase(), filter: "to", block_number: "123", index: "4" }), /token-transfers\?/);
});

test("explorer proxy: anything else is refused", () => {
  assert.equal(upstreamUrl(["..", "etc"], {}), null);
  assert.equal(upstreamUrl(["addresses", A, "transactions", "extra"], {}), null);
  assert.equal(upstreamUrl(["stats"], {}), null);
  assert.equal(upstreamUrl(["addresses", "not-an-address", "transactions"], {}), null);
  assert.equal(upstreamUrl(["addresses", A, "transactions"], { "bad-key": "1" }), null);
  assert.equal(upstreamUrl(["addresses", A, "transactions"], { filter: "x".repeat(200) }), null);
  assert.equal(upstreamUrl([], {}), null);
});

test("explorer proxy: non-GET is 405 and a bad path is 400", async () => {
  const mk = () => { const r = { code: 0, headers: {}, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.send = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
  const r1 = mk(); await handler({ method: "POST", query: {} }, r1); assert.equal(r1.code, 405);
  const r2 = mk(); await handler({ method: "GET", query: { path: ["stats"] } }, r2); assert.equal(r2.code, 400);
});
