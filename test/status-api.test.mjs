// The status server (api/status.js + lib/status.mjs): strict event checks, signatures, merging, pruning, daily totals,
// and the handler end to end with an in-memory stand-in for Vercel Blob (nothing touches the network).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  makeHandler, blobStore, StaleWriteError, validateEvent, validateReport, checkSignature, signReport, mergeEvents, pruneSummary,
  paidLast24h, parseStatusQuery, statusView, normalizeSummary, MAX_BODY,
} from "../api/status.js";
import { receiptNo } from "../site/assets/core.js";

const SECRET = "s".repeat(64);
const NOW = Date.parse("2026-11-21T12:00:00Z");
const NOW_S = Math.floor(NOW / 1000);
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const A = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const iso = (ms) => new Date(ms).toISOString();
const ADA = A(2), PAYER = A(4), BOB = A(5);

const ev = (o = {}) => ({
  id: `${h(1)}:3`, kind: "ntag", tag: "ada", recipient: ADA, token: "USDT", amount: "10.00", usd: 10, status: "received",
  depositTx: h(1), payer: PAYER, at: iso(NOW - 60_000), ...o,
});
const paid = (n, o = {}) => ev({
  id: `${h(n)}:1`, depositTx: h(n), status: "paid", payoutTx: h(9000 + n), receiptNo: receiptNo(h(9000 + n)), paidAmount: "14400", paidToken: "cNGN", ...o,
});

/** In-memory Vercel Blob stand-in with ETags, counting reads and writes. */
function memStore() {
  const s = { data: null, etag: 0, reads: 0, writes: 0, failNextWrite: false };
  s.read = async () => { s.reads++; return s.data == null ? null : { data: JSON.parse(JSON.stringify(s.data)), etag: String(s.etag) }; };
  s.write = async (d, etag) => {
    if (s.failNextWrite) { s.failNextWrite = false; s.etag++; throw new StaleWriteError("changed"); }
    if (s.data != null && etag !== String(s.etag)) throw new StaleWriteError("changed");
    s.writes++; s.data = JSON.parse(JSON.stringify(d)); s.etag++;
  };
  return s;
}
const mkRes = () => {
  const r = { code: 0, headers: {}, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};
const signed = (events, { ts = NOW_S, secret = SECRET, body } = {}) => {
  const raw = body ?? JSON.stringify({ v: 1, ts, events });
  return {
    method: "POST", rawBody: raw,
    headers: { "content-type": "application/json", "x-np-ts": String(ts), "x-np-signature": signReport(secret, ts, raw), "content-length": String(Buffer.byteLength(raw)) },
  };
};
const setup = () => {
  const store = memStore();
  const clock = { t: NOW };
  const handler = makeHandler({ store, env: () => ({ secret: SECRET, hasBlob: true }), now: () => clock.t });
  const call = async (req) => { const res = mkRes(); await handler(req, res); return res; };
  return { store, handler, call, clock };
};

test("events: valid shapes pass and are normalised", () => {
  const r = validateEvent(ev({ recipient: ADA.toUpperCase().replace("0X", "0x"), id: `${h(1).toUpperCase().replace("0X", "0x")}:3` }), NOW);
  assert.equal(r.error, undefined);
  assert.equal(r.event.recipient, ADA);
  assert.equal(r.event.id, `${h(1)}:3`);
  assert.equal(validateEvent(paid(2), NOW).error, undefined);
  // refused: no recipient needed (an unknown tag has no owner), reason is a code
  assert.equal(validateEvent(ev({ status: "refused", reason: "unknown_tag", recipient: undefined, tag: "zed" }), NOW).error, undefined);
  // a direct owner payout (CELO allowed only here)
  const d = { id: `${h(77)}:direct`, kind: "direct", recipient: BOB, token: "CELO", amount: "20", usd: 1.1, status: "paid", payoutTx: h(77), receiptNo: receiptNo(h(77)), at: iso(NOW) };
  assert.equal(validateEvent(d, NOW).error, undefined);
  assert.equal(validateEvent({ ...ev({ kind: "registration", tag: undefined }), registration: h(50) }, NOW).error, undefined);
});

test("events: anything off is refused", () => {
  const bad = [
    ev({ extra: 1 }), ev({ kind: "other" }), ev({ status: "done" }), ev({ id: "0x12:3" }), ev({ id: `${h(1)}:x` }),
    ev({ tag: "Ada" }), ev({ tag: "admin" }), ev({ tag: "a_" }), ev({ recipient: "0x123" }), ev({ recipient: undefined }),
    ev({ token: "DAI" }), ev({ token: "CELO" }), ev({ amount: "1e3" }), ev({ amount: 10 }), ev({ usd: -1 }), ev({ usd: "10" }),
    ev({ usd: Infinity }), ev({ status: "refused" }), ev({ status: "refused", reason: "because the owner said so" }),
    ev({ reason: "other" }), ev({ status: "paid" }), paid(2, { receiptNo: "NP-FFFF-FFFF" }), paid(2, { usd: undefined }),
    paid(2, { paidToken: "CELO" }), ev({ payoutTx: h(5) }), ev({ depositTx: h(2) }), ev({ payer: undefined }), ev({ at: "yesterday" }),
    ev({ at: iso(NOW + 3 * 86_400_000) }), ev({ kind: "registration" }), ev({ registration: h(3) }), ev({ kind: "request" }),
    { ...paid(3), kind: "direct" }, null, [], "x",
  ];
  for (const b of bad) assert.ok(validateEvent(b, NOW).error, JSON.stringify(b));
});

test("reports: body shape, version, ts must equal the header, at most 100 events", () => {
  assert.deepEqual(validateReport({ v: 1, ts: NOW_S, events: [ev()] }, String(NOW_S), NOW).events.length, 1);
  assert.ok(validateReport({ v: 2, ts: NOW_S, events: [] }, String(NOW_S), NOW).error);
  assert.ok(validateReport({ v: 1, ts: NOW_S, events: [] }, String(NOW_S + 1), NOW).error);
  assert.ok(validateReport({ v: 1, ts: NOW_S, events: [], more: 1 }, String(NOW_S), NOW).error);
  assert.ok(validateReport({ v: 1, ts: NOW_S, events: Array(101).fill(ev()) }, String(NOW_S), NOW).error);
  // one bad event doesn't sink the batch: the good ones pass, the bad one is named
  const mixed = validateReport({ v: 1, ts: NOW_S, events: [ev(), ev({ id: `${h(5)}:1`, depositTx: h(5), kind: "x" }), { junk: true }] }, String(NOW_S), NOW);
  assert.equal(mixed.error, undefined);
  assert.equal(mixed.events.length, 1);
  assert.deepEqual(mixed.rejected, [`${h(5)}:1`, "#2"]);
});

test("signatures: HMAC over ts.body, timing-safe, 5-minute window", () => {
  const raw = '{"v":1}';
  const sig = signReport(SECRET, NOW_S, raw);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(checkSignature(SECRET, String(NOW_S), raw, sig, NOW_S), true);
  assert.equal(checkSignature(SECRET, String(NOW_S), raw, sig.toUpperCase(), NOW_S), true);
  assert.equal(checkSignature(SECRET, String(NOW_S), raw + " ", sig, NOW_S), false);
  assert.equal(checkSignature("t".repeat(64), String(NOW_S), raw, sig, NOW_S), false);
  assert.equal(checkSignature(SECRET, String(NOW_S), raw, sig, NOW_S + 301), false);
  assert.equal(checkSignature(SECRET, String(NOW_S), raw, sig, NOW_S - 301), false);
  assert.equal(checkSignature(SECRET, String(NOW_S), raw, sig, NOW_S + 300), true);
  assert.equal(checkSignature(SECRET, "abc", raw, sig, NOW_S), false);
  assert.equal(checkSignature(SECRET, String(NOW_S), raw, "zz", NOW_S), false);
  assert.equal(checkSignature("", String(NOW_S), raw, sig, NOW_S), false);
});

test("merge: a status never goes back; same status keeps the newest", () => {
  const s = { deposits: {} };
  const e1 = validateEvent(ev(), NOW).event;
  const e2 = validateEvent(paid(1, { id: e1.id, depositTx: e1.depositTx, at: iso(NOW - 1000) }), NOW).event;
  assert.equal(mergeEvents(s, [e1]), 1);
  assert.equal(mergeEvents(s, [e2]), 1);
  assert.equal(mergeEvents(s, [e1]), 0, "a replayed 'received' can't hide 'paid'");
  assert.equal(s.deposits[e1.id].status, "paid");
  const refused = validateEvent(ev({ id: `${h(8)}:1`, depositTx: h(8), status: "refused", reason: "over_wallet_cap" }), NOW).event;
  mergeEvents(s, [refused]);
  const forced = validateEvent(paid(8, { id: `${h(8)}:1` }), NOW).event;
  assert.equal(mergeEvents(s, [forced]), 1, "a refused deposit paid by hand later shows as paid");
});

test("prune: last 30 days and at most 2,000 entries", () => {
  const s = { deposits: {} };
  for (let i = 0; i < 2100; i++) {
    const e = validateEvent(ev({ id: `${h(i + 1)}:0`, depositTx: h(i + 1), at: iso(NOW - i * 60_000) }), NOW).event;
    s.deposits[e.id] = e;
  }
  const old = validateEvent(ev({ id: `${h(99999)}:0`, depositTx: h(99999), at: iso(NOW - 31 * 86_400_000) }), NOW).event;
  s.deposits[old.id] = old;
  pruneSummary(s, NOW);
  assert.equal(Object.keys(s.deposits).length, 2000);
  assert.ok(!s.deposits[old.id]);
  assert.ok(s.deposits[`${h(1)}:0`], "newest kept");
});

test("totals: rolling 24 h, each payout once, per wallet", () => {
  const list = [
    paid(1, { usd: 10, at: iso(NOW - 3600_000) }),
    paid(2, { usd: 5.5, at: iso(NOW - 23 * 3600_000) }),
    paid(3, { usd: 7, at: iso(NOW - 25 * 3600_000) }), // older than 24 h
    paid(4, { usd: 3, recipient: BOB, tag: "bob" }),
    paid(5, { usd: 99, payoutTx: h(9001), receiptNo: receiptNo(h(9001)) }), // same payout as #1: counted once
    ev({ id: `${h(6)}:0`, depositTx: h(6) }), // received: not counted
  ].map((e) => validateEvent(e, NOW).event);
  assert.equal(paidLast24h(list, NOW).usedUsd, 18.5);
  const ada = paidLast24h(list, NOW, ADA);
  assert.equal(ada.usedUsd, 15.5);
  assert.deepEqual(ada.payouts.map((p) => p.usd), [5.5, 10]);
  const view = statusView({ updatedAt: iso(NOW), deposits: Object.fromEntries(list.map((e) => [e.id, e])) }, { by: "recipient", value: ADA }, NOW);
  assert.deepEqual(view.wallet.roomUsd, 9.5);
  assert.deepEqual(view.global, { usedUsd: 18.5, roomUsd: 81.5, capUsd: 100 });
  const tagView = statusView({ updatedAt: null, deposits: Object.fromEntries(list.map((e) => [e.id, e])) }, { by: "tag", value: "bob" }, NOW);
  assert.equal(tagView.recipient, BOB);
  assert.equal(tagView.wallet.usedUsd, 3);
});

test("queries: exactly one of tx / recipient / tag, or none", () => {
  assert.deepEqual(parseStatusQuery({}), { by: "global", value: null });
  assert.deepEqual(parseStatusQuery({ tx: h(1).toUpperCase().replace("0X", "0x") }), { by: "tx", value: h(1) });
  assert.deepEqual(parseStatusQuery({ tag: "@ada" }), { by: "tag", value: "ada" });
  assert.deepEqual(parseStatusQuery({ recipient: ADA }), { by: "recipient", value: ADA });
  for (const q of [{ tx: "0x12" }, { tag: "Ada" }, { tag: "admin" }, { recipient: "x" }, { tx: h(1), tag: "ada" }, { other: "1" }, { tx: [h(1), h(2)] }]) {
    assert.equal(parseStatusQuery(q), null, JSON.stringify(q));
  }
});

test("normalizeSummary drops malformed entries instead of failing", () => {
  const s = normalizeSummary({ updatedAt: "x", deposits: { a: { id: "junk" }, b: ev() } }, NOW);
  assert.equal(Object.keys(s.deposits).length, 1);
  assert.deepEqual(normalizeSummary(null, NOW).deposits, {});
});

test("handler: signed POST stores, GET answers with totals and edge caching", async () => {
  const { store, call, clock } = setup();
  const r1 = await call(signed([ev(), paid(2, { usd: 12 })]));
  assert.equal(r1.code, 200);
  assert.deepEqual(r1.body, { ok: true, stored: 2, rejected: [] });
  assert.equal(r1.headers["Cache-Control"], "no-store");
  assert.equal(store.writes, 1);

  const g = await call({ method: "GET", query: { tx: h(2) } });
  assert.equal(g.code, 200);
  assert.equal(g.headers["Cache-Control"], "public, s-maxage=10, stale-while-revalidate=30");
  assert.equal(g.body.events.length, 1);
  assert.equal(g.body.events[0].status, "paid");
  assert.equal(g.body.events[0].receiptNo, receiptNo(h(9002)));
  assert.equal(store.reads, 1, "the GET right after this instance's write used its memory copy");
  clock.t += 11_000;
  const w = await call({ method: "GET", query: { recipient: ADA } });
  assert.equal(store.reads, 2, "one blob read once the memory copy is 10 s old");
  await call({ method: "GET", query: { tx: h(77) } });
  await call({ method: "GET", query: { tx: h(78) } });
  assert.equal(store.reads, 2, "varying ?tx= within 10 s costs no more reads");
  assert.equal(w.body.wallet.usedUsd, 12);
  assert.equal(w.body.wallet.roomUsd, 13);
  assert.equal(w.body.global.roomUsd, 88);
  const t = await call({ method: "GET", query: { tag: "ada" } });
  assert.equal(t.body.recipient, ADA);
  assert.equal(t.body.events.length, 2);
  const all = await call({ method: "GET", query: {} });
  assert.deepEqual(Object.keys(all.body).sort(), ["global", "ok", "source", "updatedAt"]);
  // only public fields leave the server
  for (const e of t.body.events) for (const k of Object.keys(e)) assert.ok(!/^(ip|secret|error|input|name|note|reasonText)$/i.test(k), k);

  // a replay of the same report changes nothing and doesn't write
  const again = await call(signed([ev()]));
  assert.deepEqual(again.body, { ok: true, stored: 0, rejected: [] });
  assert.equal(store.writes, 1);
  // a signed ping touches no storage
  const before = store.reads;
  assert.deepEqual((await call(signed([]))).body, { ok: true, stored: 0, rejected: [] });
  assert.equal(store.reads, before);
});

test("handler: bad signature, stale or future ts, wrong type, oversized and malformed bodies are refused", async () => {
  const { store, call } = setup();
  const bad = signed([ev()]);
  bad.headers["x-np-signature"] = signReport("x".repeat(64), NOW_S, bad.rawBody);
  assert.deepEqual([(await call(bad)).code, (await call(bad)).body], [401, { ok: false, error: "unauthorized" }]);
  assert.equal((await call(signed([ev()], { ts: NOW_S - 301 }))).code, 401);
  assert.equal((await call(signed([ev()], { ts: NOW_S + 301 }))).code, 401);
  const noSig = signed([ev()]); delete noSig.headers["x-np-signature"];
  assert.equal((await call(noSig)).code, 401);
  const text = signed([ev()]); text.headers["content-type"] = "text/plain";
  assert.equal((await call(text)).code, 415);
  const big = signed([], { body: JSON.stringify({ v: 1, ts: NOW_S, events: [], pad: "x".repeat(MAX_BODY) }) });
  assert.equal((await call(big)).code, 413);
  delete big.headers["content-length"];
  assert.equal((await call(big)).code, 413);
  assert.equal((await call(signed(null, { body: "{nope" }))).code, 400);
  const r = await call(signed([ev({ kind: "x" })]));
  assert.deepEqual([r.code, r.body], [200, { ok: true, stored: 0, rejected: [`${h(1)}:3`] }], "an invalid event is named, not stored");
  assert.equal((await call(signed([ev()], { body: JSON.stringify({ v: 1, ts: NOW_S + 1, events: [] }) }))).code, 400, "body ts must match the header");
  assert.equal((await call({ method: "PUT", headers: {} })).code, 405);
  assert.equal((await call({ method: "GET", query: { tx: "nope" } })).code, 400);
  assert.equal(store.writes, 0);
  assert.equal(store.reads, 0, "nothing unauthenticated or invalid reaches storage");
});

test("handler: missing secret or storage, or nothing stored yet, is 503 unavailable (the site falls back)", async () => {
  const noEnv = makeHandler({ env: () => ({ secret: undefined, hasBlob: false }), now: () => NOW });
  for (const req of [{ method: "GET", query: { tx: h(1) } }, signed([ev()])]) {
    const res = mkRes(); await noEnv(req, res);
    assert.deepEqual([res.code, res.body], [503, { ok: false, reason: "unavailable" }]);
  }
  const short = makeHandler({ store: memStore(), env: () => ({ secret: "short", hasBlob: true }), now: () => NOW });
  const r0 = mkRes(); await short(signed([ev()], { secret: "short" }), r0); assert.equal(r0.code, 503);
  const { call } = setup();
  const empty = await call({ method: "GET", query: { tx: h(1) } });
  assert.equal(empty.code, 503);
  assert.equal(empty.headers["Cache-Control"], "no-store");
  const broken = makeHandler({ store: { read: async () => { throw new Error("blob down"); } }, env: () => ({ secret: SECRET, hasBlob: true }), now: () => NOW });
  const r1 = mkRes(); await broken({ method: "GET", query: {} }, r1); assert.equal(r1.code, 503);
  const r2 = mkRes(); await broken(signed([ev()]), r2); assert.deepEqual(r2.body, { ok: false, reason: "unavailable" });
});

test("handler: a write that loses an ETag race is retried on fresh data", async () => {
  const { store, call } = setup();
  await call(signed([ev()]));
  store.failNextWrite = true;
  const r = await call(signed([paid(2)]));
  assert.equal(r.code, 200);
  assert.equal(Object.keys(store.data.deposits).length, 2);
});

test("handler over real HTTP: raw body is signed as sent; Vercel's pre-parsed body also verifies", async () => {
  const store = memStore();
  const handler = makeHandler({ store, env: () => ({ secret: SECRET, hasBlob: true }) });
  const server = http.createServer((req, res) => {
    const out = { status: (c) => { res.statusCode = c; return out; }, json: (b) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); return out; }, setHeader: (k, v) => res.setHeader(k, v) };
    req.query = Object.fromEntries(new URL(req.url, "http://x").searchParams);
    handler(req, out);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/status`;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const e = ev({ at: new Date().toISOString() });
    const body = JSON.stringify({ v: 1, ts, events: [e] });
    const post = (b, sig = signReport(SECRET, ts, b)) => fetch(url, { method: "POST", body: b, headers: { "content-type": "application/json", "x-np-ts": String(ts), "x-np-signature": sig } });
    assert.equal((await post(body)).status, 200);
    assert.equal((await post(body, "0".repeat(64))).status, 401);
    const g = await fetch(`${url}?tx=${h(1)}`);
    assert.equal(g.status, 200);
    assert.equal((await g.json()).events[0].status, "received");
    const big = JSON.stringify({ v: 1, ts, events: [], pad: "x".repeat(MAX_BODY) });
    assert.equal((await post(big)).status, 413);
  } finally {
    server.close();
  }
  // Vercel hands the function an already-parsed req.body: JSON.stringify output survives the round trip.
  const raw = JSON.stringify({ v: 1, ts: NOW_S, events: [ev({ tag: "ada", amount: "1.50" })] });
  const parsed = { method: "POST", body: JSON.parse(raw), headers: { "content-type": "application/json", "x-np-ts": String(NOW_S), "x-np-signature": signReport(SECRET, NOW_S, raw) } };
  const { call } = setup();
  assert.equal((await call(parsed)).code, 200);
});

test("failed: a payout error is its own status with a fixed reason; a later paid wins, a late received can't hide it", () => {
  const failed = validateEvent(ev({ status: "failed", reason: "payout_error" }), NOW);
  assert.equal(failed.error, undefined);
  assert.ok(validateEvent(ev({ status: "failed" }), NOW).error, "reason required");
  assert.ok(validateEvent(ev({ status: "failed", reason: "unknown_tag" }), NOW).error, "refusal codes are not failure codes");
  assert.ok(validateEvent(ev({ status: "refused", reason: "payout_error" }), NOW).error);
  assert.ok(validateEvent(ev({ status: "failed", reason: "payout_error", recipient: undefined }), NOW).error, "a failed payout has a recipient");
  assert.ok(validateEvent(ev({ status: "toString" }), NOW).error);
  const s = { deposits: {} };
  mergeEvents(s, [validateEvent(ev(), NOW).event, failed.event]);
  assert.equal(s.deposits[failed.event.id].status, "failed");
  assert.equal(mergeEvents(s, [validateEvent(ev({ at: iso(NOW) }), NOW).event]), 0);
  assert.equal(mergeEvents(s, [validateEvent(paid(1, { id: `${h(1)}:3`, depositTx: h(1) }), NOW).event]), 1);
  assert.equal(s.deposits[failed.event.id].status, "paid");
  // a stored entry with an unknown status (from a newer server) never crashes the merge
  s.deposits.weird = { status: "toString", at: iso(NOW) };
  assert.doesNotThrow(() => mergeEvents(s, [{ ...failed.event, id: "weird" }]));
});

test("handler: an unreadable summary blob is replaced on POST and is 503 on GET", async () => {
  const store = memStore();
  store.read = async () => { store.reads++; return store.data === "corrupt" ? { data: null, etag: String(store.etag), corrupt: true } : store.data == null ? null : { data: JSON.parse(JSON.stringify(store.data)), etag: String(store.etag) }; };
  store.data = "corrupt";
  const clock = { t: NOW };
  const handler = makeHandler({ store, env: () => ({ secret: SECRET, hasBlob: true }), now: () => clock.t });
  const call = async (req) => { const res = mkRes(); await handler(req, res); return res; };
  const g0 = await call({ method: "GET", query: {} });
  assert.equal(g0.code, 503);
  const p = await call(signed([ev()]));
  assert.equal(p.code, 200);
  assert.equal(Object.keys(store.data.deposits).length, 1);
  clock.t += 11_000;
  assert.equal((await call({ method: "GET", query: { tx: h(1) } })).code, 200);
});

test("blobStore: first write can't overwrite, later writes need the ETag; races and bad JSON are handled", async () => {
  const calls = [];
  class BlobPreconditionFailedError extends Error {}
  let blobText = null, existsError = false, precondition = false;
  const sdk = {
    BlobPreconditionFailedError,
    get: async () => (blobText == null ? null : { statusCode: 200, stream: new Blob([blobText]).stream(), blob: { etag: '"e1"' } }),
    put: async (path, body, opts) => {
      calls.push({ path, opts });
      if (existsError) throw new Error("Vercel Blob: This blob already exists, use `allowOverwrite: true` if you want to overwrite it.");
      if (precondition) throw new BlobPreconditionFailedError();
      blobText = body;
    },
  };
  const st = blobStore({ sdk, access: "private" });
  assert.equal(await st.read(), null);
  await st.write({ v: 1 }, null);
  assert.equal(calls[0].path, "status/summary.json");
  assert.equal(calls[0].opts.allowOverwrite, false, "the first write never overwrites");
  assert.equal(calls[0].opts.ifMatch, undefined);
  assert.equal(calls[0].opts.access, "private");
  const got = await st.read({ fresh: true });
  assert.deepEqual([got.data, got.etag], [{ v: 1 }, '"e1"']);
  await st.write({ v: 1, n: 2 }, got.etag);
  assert.deepEqual([calls[1].opts.ifMatch, calls[1].opts.allowOverwrite], ['"e1"', true]);
  existsError = true;
  await assert.rejects(st.write({ v: 1 }, null), StaleWriteError, "another first write won: read and merge again");
  existsError = false; precondition = true;
  await assert.rejects(st.write({ v: 1 }, '"old"'), StaleWriteError);
  precondition = false;
  blobText = "{not json";
  assert.deepEqual(await st.read(), { data: null, etag: '"e1"', corrupt: true });
});
