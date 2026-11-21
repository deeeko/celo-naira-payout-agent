// Wallet sign-in: the message format shared by site/assets/session.js and api/session.js, and the stateless check.
import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import handler, { checkSignIn, MAX_BODY } from "../api/session.js";
import { buildSignInMessage, parseSignInMessage, signInMessageError, explainWalletError, ensureCelo } from "../site/assets/session.js";

const account = privateKeyToAccount(generatePrivateKey()); // throwaway key, made for this test only
const NOW = 1_795_000_000;
const iso = (s) => new Date(s * 1000).toISOString();
const msgFor = (o = {}) => buildSignInMessage({
  host: "naira-payout.vercel.app", origin: "https://naira-payout.vercel.app", address: account.address,
  nonce: "0123456789abcdef", issuedAt: iso(NOW), expiresAt: iso(NOW + 7 * 86400), ...o,
});
const mkRes = () => {
  const r = { code: 0, headers: {}, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};

test("sign-in message: builds the agreed text and parses back", () => {
  const m = msgFor();
  assert.equal(m, `naira-payout.vercel.app wants you to sign in with your Ethereum account:\n${account.address}\n\n`
    + "Sign in to Naira Payout. This is free and sends nothing.\n\nURI: https://naira-payout.vercel.app\nVersion: 1\n"
    + `Chain ID: 42220\nNonce: 0123456789abcdef\nIssued At: ${iso(NOW)}\nExpiration Time: ${iso(NOW + 7 * 86400)}`);
  const p = parseSignInMessage(m);
  assert.equal(p.address, account.address);
  assert.equal(p.host, "naira-payout.vercel.app");
  assert.equal(p.chainId, 42220);
  assert.equal(p.exp, NOW + 7 * 86400);
  assert.equal(signInMessageError(p, NOW + 10), null);
  // local preview with a port
  const local = parseSignInMessage(msgFor({ host: "localhost:8080", origin: "http://localhost:8080" }));
  assert.equal(local.host, "localhost:8080");
  assert.equal(signInMessageError(local, NOW), null);
});

test("sign-in message: anything else is refused", () => {
  assert.equal(parseSignInMessage(msgFor() + "\nextra"), null);
  assert.equal(parseSignInMessage(msgFor().replace("Sign in to Naira Payout", "Sign in to Something")), null);
  assert.equal(parseSignInMessage(msgFor({ nonce: "xyz" })), null);
  assert.equal(parseSignInMessage(42), null);
  assert.equal(signInMessageError(parseSignInMessage(msgFor().replace("Chain ID: 42220", "Chain ID: 1")), NOW), "wrong chain");
  assert.equal(signInMessageError(parseSignInMessage(msgFor({ origin: "https://evil.example" })), NOW), "the URI is not on the signing site");
  assert.equal(signInMessageError(parseSignInMessage(msgFor()), NOW + 8 * 86400), "the sign-in has expired");
  assert.equal(signInMessageError(parseSignInMessage(msgFor({ expiresAt: iso(NOW + 30 * 86400) })), NOW), "the sign-in lasts too long");
  assert.equal(signInMessageError(parseSignInMessage(msgFor({ issuedAt: iso(NOW + 3600) })), NOW), "issued in the future");
});

test("api/session: a real signature for this site passes", async () => {
  const message = msgFor();
  const signature = await account.signMessage({ message });
  const ok = await checkSignIn({ message, signature }, { host: "naira-payout.vercel.app", nowSec: NOW + 60 });
  assert.deepEqual(ok, { ok: true, address: account.address, exp: NOW + 7 * 86400 });
  // a preview deployment signs with its own host, which must match the request's Host header
  const pm = msgFor({ host: "preview-abc.vercel.app", origin: "https://preview-abc.vercel.app" });
  const ps = await account.signMessage({ message: pm });
  assert.equal((await checkSignIn({ message: pm, signature: ps }, { host: "preview-abc.vercel.app", nowSec: NOW })).ok, true);
  assert.equal((await checkSignIn({ message: pm, signature: ps }, { host: "naira-payout.vercel.app", nowSec: NOW })).error, "signed for a different site");
});

test("api/session: wrong signer, tampering, expiry and junk are refused", async () => {
  const message = msgFor();
  const other = privateKeyToAccount(generatePrivateKey());
  const bad = await other.signMessage({ message });
  assert.equal((await checkSignIn({ message, signature: bad }, { host: "naira-payout.vercel.app", nowSec: NOW })).ok, false);
  const signature = await account.signMessage({ message });
  const tampered = message.replace("0123456789abcdef", "fedcba9876543210");
  assert.equal((await checkSignIn({ message: tampered, signature }, { host: "naira-payout.vercel.app", nowSec: NOW })).ok, false);
  assert.equal((await checkSignIn({ message, signature }, { host: "naira-payout.vercel.app", nowSec: NOW + 8 * 86400 })).error, "the sign-in has expired");
  assert.equal((await checkSignIn({ message, signature: "0x1234" }, { host: "naira-payout.vercel.app", nowSec: NOW })).ok, false);
  assert.equal((await checkSignIn({}, { host: "x" })).ok, false);
});

test("api/session handler: POST + JSON only, size limit, 400 on a bad sign-in, no caching", async () => {
  const message = msgFor({ issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  const signature = await account.signMessage({ message });
  const headers = { "content-type": "application/json", host: "naira-payout.vercel.app" };

  const r1 = mkRes(); await handler({ method: "GET", headers }, r1);
  assert.equal(r1.code, 405); assert.equal(r1.headers.Allow, "POST");
  const r2 = mkRes(); await handler({ method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}" }, r2);
  assert.equal(r2.code, 415);
  const r3 = mkRes(); await handler({ method: "POST", headers: { ...headers, "content-length": String(MAX_BODY + 1) }, body: {} }, r3);
  assert.equal(r3.code, 413);
  const r4 = mkRes(); await handler({ method: "POST", headers, body: "{not json" }, r4);
  assert.equal(r4.code, 400);
  const r5 = mkRes(); await handler({ method: "POST", headers, body: { message, signature: "0x" + "11".repeat(65) } }, r5);
  assert.equal(r5.code, 400); assert.equal(r5.body.ok, false);
  const r6 = mkRes(); await handler({ method: "POST", headers, body: { message, signature } }, r6);
  assert.equal(r6.code, 200); assert.equal(r6.body.ok, true); assert.equal(r6.body.address, account.address);
  assert.equal(r6.headers["Cache-Control"], "no-store");
  const r7 = mkRes(); await handler({ method: "POST", headers, body: JSON.stringify({ message, signature }) }, r7);
  assert.equal(r7.code, 200);
  const r8 = mkRes(); await handler({ method: "POST", headers, body: { message: message + "x".repeat(MAX_BODY), signature } }, r8);
  assert.equal(r8.code, 413);
});

test("session.js wallet helpers: plain errors and the Celo switch", async () => {
  assert.equal(explainWalletError({ code: 4001 }), "You cancelled in your wallet. Nothing was sent.");
  assert.match(explainWalletError(new Error("insufficient funds for gas")), /enough CELO/);
  const calls = [];
  let chain = "0x1";
  const eth = { request: async ({ method, params }) => {
    calls.push(method);
    if (method === "eth_chainId") return chain;
    if (method === "wallet_switchEthereumChain") { if (calls.filter((m) => m === method).length === 1) throw Object.assign(new Error("Unrecognized chain"), { code: 4902 }); chain = params[0].chainId; return null; }
    if (method === "wallet_addEthereumChain") { chain = params[0].chainId; return null; }
    throw new Error("unexpected " + method);
  } };
  await ensureCelo(eth);
  assert.deepEqual(calls, ["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_chainId"]);
  assert.equal(chain, "0xa4ec");
});
