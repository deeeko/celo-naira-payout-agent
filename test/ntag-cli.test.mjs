// The `ntag` terminal command (src/ntag.mjs): pure logic only. No network, no real wallet: temp dirs, low scrypt N.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AGENT, CliError, UsageError, WrongPasswordError, agentPaidUsd, assertKeystore, assertNotAgentKey, attemptsFile, buildTransfer,
  changePassword, checkAmount, decryptKey, encryptKey, estimateReceive, explainError, findPayout, formatBox, formatSummary,
  loadWallet, lockoutState, main, parseAmountUnits, parseArgs, parseTag, parseTransferCalldata, passwordProblem, readKeystore,
  recordFailure, saveWallet, scryptN, shortAddr, transferFromItem, typedTagMatches, unlockWallet, walletFile, LOCK_FOR_MS, SCRYPT_N,
} from "../src/ntag.mjs";
import { decodeNtagMemo as decodeSrc, encodeNtagTransfer as encodeSrc } from "../src/ntags.mjs";
import { decodeNtagMemo as decodeSite, encodeNtagTransfer as encodeSite } from "../site/assets/core.js";
import { KEY_FILE, TOKENS } from "../src/config.mjs";

const N = 16; // test-only scrypt cost; real wallets use 2^17
const PW = "correct horse battery";
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ntag-cli-"));
const ANSI = /\x1b\[[0-9;]*m/g;

test("arg parsing: command, positionals, flags, --name forms, bad usage", () => {
  assert.deepEqual(parseArgs([]).cmd, "help");
  const a = parseArgs(["send", "@Ada", "10", "--dollars", "--yes", "--wait", "--dry-run"]);
  assert.equal(a.cmd, "send");
  assert.deepEqual(a.args, ["@Ada", "10"]);
  assert.equal(a.flags.dollars && a.flags.yes && a.flags.wait && a.flags.dryRun, true);
  assert.equal(parseArgs(["claim", "ada", "--name", "Ada Obi"]).flags.name, "Ada Obi");
  assert.equal(parseArgs(["claim", "ada", "--name=Ada Obi"]).flags.name, "Ada Obi");
  assert.equal(parseArgs(["SEND", "-y", "x", "1"]).cmd, "send");
  assert.deepEqual(parseArgs(["send", "--", "@ada", "--weird"]).args, ["@ada", "--weird"]);
  assert.throws(() => parseArgs(["send", "--frobnicate"]), UsageError);
  assert.throws(() => parseArgs(["claim", "ada", "--name"]), UsageError);
  assert.throws(() => parseArgs(["send", "@ada", "1", "--dollars", "--naira"]), UsageError);
});

test("amounts: exact base units via BigInt (no float error), at most 2 decimals", () => {
  assert.equal(parseAmountUnits("10.29"), 10_290_000n);
  assert.equal(parseAmountUnits("10"), 10_000_000n);
  assert.equal(parseAmountUnits("4.35"), 4_350_000n); // 4.35 * 1e6 is 4349999.999... in floating point
  assert.equal(parseAmountUnits("1.15"), 1_150_000n);
  assert.equal(parseAmountUnits("0.1"), 100_000n);
  assert.equal(parseAmountUnits("$24.99"), 24_990_000n);
  assert.equal(parseAmountUnits("₦14,000"), 14_000_000_000n);
  assert.equal(parseAmountUnits("1,000.50"), 1_000_500_000n);
  for (const bad of ["10.123", "0.001", "0", "0.00", "abc", "1e3", "-5", "", "10.", ".5x", "1,0", "NaN", "Infinity"]) {
    assert.throws(() => parseAmountUnits(bad), UsageError, `should reject ${JSON.stringify(bad)}`);
  }
});

test("amount limits: USD₮ $1-$25; cNGN worth $1-$25 at the live rate", () => {
  assert.equal(checkAmount(parseAmountUnits("1"), "USDT").units, 1_000_000n);
  assert.equal(checkAmount(parseAmountUnits("25"), "USDT").usdUnits, 25_000_000n);
  assert.throws(() => checkAmount(parseAmountUnits("25.01"), "USDT"), /most/);
  assert.throws(() => checkAmount(parseAmountUnits("0.99"), "USDT"), /smallest/);
  const rate = { reverseRate: 0.00069193 }; // USD₮ per NGN
  assert.ok(checkAmount(parseAmountUnits("36000"), "CNGN", rate).usdUnits < 25_000_000n);
  assert.throws(() => checkAmount(parseAmountUnits("37000"), "CNGN", rate), /over the \$25 cap/);
  assert.throws(() => checkAmount(parseAmountUnits("1000"), "CNGN", rate), /less than \$1/);
  assert.throws(() => checkAmount(parseAmountUnits("5000"), "CNGN", {}), CliError); // no rate -> can't check the cap
});

test("tag normalisation: @Ada -> ada, rules enforced", () => {
  assert.equal(parseTag("@Ada"), "ada");
  assert.equal(parseTag("  @ADA_obi "), "ada_obi");
  assert.equal(parseTag("ada"), "ada");
  for (const bad of ["", "@", "@ab", "@1ada", "@ada__x", "@ada_", "@admin", "@a-b-c", "@@ada"]) assert.throws(() => parseTag(bad), UsageError, bad);
  assert.equal(typedTagMatches("@ADA", "ada"), true);
  assert.equal(typedTagMatches(" ada ", "ada"), true);
  assert.equal(typedTagMatches("adaa", "ada"), false);
  assert.equal(typedTagMatches("", "ada"), false);
});

test("--dry-run transaction equals the protocol encoder (src + site) and decodes back", () => {
  const units = parseAmountUnits("10.29");
  const tx = buildTransfer({ token: "USDT", units, tag: "ada" });
  assert.equal(tx.to, TOKENS.USDT.address);
  assert.equal(tx.value, 0n);
  assert.equal(tx.data, encodeSrc(AGENT, units, "ada"));
  assert.equal(tx.data, encodeSite(AGENT, units, "ada"));
  assert.equal(decodeSrc(tx.data), "ada");
  assert.equal(decodeSite(tx.data), "ada");
  const t = parseTransferCalldata(tx.data);
  assert.equal(t.to.toLowerCase(), AGENT.toLowerCase());
  assert.equal(t.units, 10_290_000n);
  // ERC-8021 attribution suffix: ends with the marker, carries the app's code
  assert.match(tx.data, /80218021802180218021802180218021$/);
  assert.ok(tx.data.includes(Buffer.from("celo_7360953d1b53").toString("hex")));
  const d = buildTransfer({ token: "CNGN", units: 14_000_000_000n, tag: "ada_obi" });
  assert.equal(d.to, TOKENS.CNGN.address);
  assert.equal(decodeSrc(d.data), "ada_obi");
  assert.equal(parseTransferCalldata("0x1234"), null);
});

test("summary box: content, aligned borders, colour only when asked", () => {
  const s = { tag: "ada", name: "Ada Obi", owner: "0x1111111111111111111111111111111111112222", token: "USDT", units: 10_000_000n, receiveText: "≈ ₦14,443.66 in naira (cNGN)", rateText: "$1 ≈ ₦1,444.37", feeWei: 1_234_000_000_000_000n, fromAddress: "0x3333333333333333333333333333333333334444" };
  const plain = formatSummary(s);
  assert.doesNotMatch(plain, ANSI);
  for (const want of ["Pay @ada", "@ada  (Ada Obi)", shortAddr(s.owner), "$10.00 USD₮", "≈ ₦14,443.66", "≈ 0.00123 CELO", "0x3333…4444"]) assert.ok(plain.includes(want), want);
  const widths = new Set(plain.split("\n").map((l) => [...l].length));
  assert.equal(widths.size, 1, "every line of the box has the same width");
  const coloured = formatSummary(s, { color: true });
  assert.match(coloured, ANSI);
  assert.equal(coloured.replace(ANSI, ""), plain);
  assert.ok(formatSummary({ ...s, token: "CNGN", units: 14_000_000_000n, receiveText: null, feeWei: null }).includes("₦14,000.00 cNGN"));
  assert.ok(formatBox("x", [["a", "b"]]).startsWith("┌─ x"));
  assert.equal(estimateReceive("USDT", 10_000_000n, { effectiveRate: 1444.3658 }).text, "≈ ₦14,443.66 in naira (cNGN)");
  assert.equal(estimateReceive("CNGN", 14_400_000_000n, { reverseRate: 0.00069193 }).text, "≈ $9.96 in dollars (USD₮)");
  assert.equal(estimateReceive("USDT", 1n, {}).text, null);
});

test("refuses the agent's key: by path (before reading) and by address", () => {
  assert.throws(() => assertNotAgentKey({ keyPath: KEY_FILE }), /agent's own key/);
  assert.throws(() => assertNotAgentKey({ address: AGENT.toLowerCase() }), /payout agent/);
  assert.throws(() => loadWallet(KEY_FILE), /agent's own key/);
  assert.throws(() => readKeystore(KEY_FILE), /agent's own key/);
  assert.doesNotThrow(() => assertNotAgentKey({ keyPath: path.join(os.tmpdir(), "x.json"), address: "0x1111111111111111111111111111111111111111" }));
  // A keystore that claims the agent's address is refused too.
  const dir = tmpDir();
  const f = path.join(dir, "wallet.json");
  fs.writeFileSync(f, JSON.stringify({ ...encryptKey(generatePrivateKey(), PW, { n: N }), address: AGENT }));
  assert.throws(() => readKeystore(f), /payout agent/);
});

test("wallet file location: NTAG_WALLET_FILE overrides the default", () => {
  assert.equal(walletFile({ NTAG_WALLET_FILE: "C:/tmp/w.json" }), path.resolve("C:/tmp/w.json"));
  assert.ok(walletFile({}).endsWith(path.join(".naira-payout", "wallet.json")));
});

test("keystore: encrypt/decrypt round-trip; wrong password fails; no plaintext key on disk", () => {
  const key = generatePrivateKey();
  const dir = tmpDir();
  const f = path.join(dir, "wallet.json");
  const address = saveWallet(key, PW, f, { n: N });
  assert.equal(address, privateKeyToAccount(key).address);
  const raw = fs.readFileSync(f, "utf8");
  assert.ok(!raw.toLowerCase().includes(key.slice(2).toLowerCase()), "plaintext key hex must not be in the file");
  assert.ok(!raw.includes("privateKey"));
  const ks = JSON.parse(raw);
  assert.equal(ks.version, 3);
  assert.equal(ks.crypto.kdf, "scrypt");
  assert.equal(ks.crypto.cipher, "aes-256-gcm");
  assert.equal(ks.crypto.kdfparams.salt.length, 64);
  assert.equal(ks.address, address);
  assert.equal(decryptKey(ks, PW), key);
  assert.throws(() => decryptKey(ks, "wrong password!"), WrongPasswordError);
  assert.deepEqual(loadWallet(f), { address, file: f });
  assert.throws(() => saveWallet(generatePrivateKey(), PW, f, { n: N }), /never overwrites/);
  // default cost is 2^17; the low-N override only works inside node --test
  assert.equal(encryptKey(key, PW, { n: 4 }).crypto.kdfparams.n, 4);
  assert.equal(scryptN({ NTAG_TEST_SCRYPT_N: "16" }), SCRYPT_N);
  assert.equal(scryptN({ NODE_TEST_CONTEXT: "child", NTAG_TEST_SCRYPT_N: "16" }), 16);
  assert.equal(scryptN({ NODE_TEST_CONTEXT: "child", NTAG_TEST_SCRYPT_N: "15" }), SCRYPT_N);
});

test("keystore: tampered ciphertext, MAC, iv or address all fail", () => {
  const key = generatePrivateKey();
  const ks = encryptKey(key, PW, { n: N });
  const flip = (h) => (h[0] === "0" ? "1" : "0") + h.slice(1);
  const mut = (fn) => { const c = structuredClone(ks); fn(c); return c; };
  assert.throws(() => decryptKey(mut((c) => { c.crypto.ciphertext = flip(c.crypto.ciphertext); }), PW), WrongPasswordError);
  assert.throws(() => decryptKey(mut((c) => { c.crypto.mac = flip(c.crypto.mac); }), PW), WrongPasswordError);
  assert.throws(() => decryptKey(mut((c) => { c.crypto.cipherparams.iv = flip(c.crypto.cipherparams.iv); }), PW), WrongPasswordError);
  assert.throws(() => decryptKey(mut((c) => { c.crypto.kdfparams.salt = flip(c.crypto.kdfparams.salt); }), PW), WrongPasswordError);
  assert.throws(() => decryptKey(mut((c) => { c.address = privateKeyToAccount(generatePrivateKey()).address; }), PW), WrongPasswordError);
  assert.throws(() => decryptKey(mut((c) => { c.crypto.ciphertext = c.crypto.ciphertext.slice(2); }), PW), /damaged/);
  assert.throws(() => assertKeystore(mut((c) => { c.crypto.kdfparams.n = 2 ** 24; })), /damaged/);
});

test("plaintext wallet files are refused with a re-import message", () => {
  const dir = tmpDir();
  const f = path.join(dir, "wallet.json");
  const key = generatePrivateKey();
  fs.writeFileSync(f, JSON.stringify({ address: privateKeyToAccount(key).address, privateKey: key }));
  assert.throws(() => loadWallet(f), /unencrypted.*wallet import/s);
});

test("password change: old stops working, new works, key unchanged, atomic (no tmp left)", () => {
  const key = generatePrivateKey();
  const dir = tmpDir();
  const f = path.join(dir, "wallet.json");
  saveWallet(key, PW, f, { n: N });
  assert.throws(() => changePassword(f, "not the password", "another good one", { n: N }), WrongPasswordError);
  assert.throws(() => changePassword(f, PW, "12345678", { n: N }), UsageError);
  changePassword(f, PW, "a brand new phrase", { n: N });
  const ks = readKeystore(f);
  assert.equal(decryptKey(ks, "a brand new phrase"), key);
  assert.throws(() => decryptKey(ks, PW), WrongPasswordError);
  assert.equal(fs.existsSync(`${f}.tmp`), false);
  assert.ok(!fs.readFileSync(f, "utf8").toLowerCase().includes(key.slice(2)));
});

test("weak passwords are rejected", () => {
  for (const bad of ["", "short", "password", "Password1", "12345678", "87654321", "11111111", "aaaaaaaa", "abcdefgh", "qwerty123", "passw0rd99"]) {
    assert.ok(passwordProblem(bad), `should reject ${JSON.stringify(bad)}`);
  }
  assert.match(passwordProblem("adaobi_ng", { tag: "adaobi_ng" }), /nTag/);
  assert.match(passwordProblem("@AdaObi_NG", { tag: "adaobi_ng" }), /nTag/);
  const addr = "0x1111111111111111111111111111111111111111";
  assert.match(passwordProblem(addr, { address: addr }), /address/);
  assert.equal(passwordProblem("correct horse battery", { tag: "ada" }), null);
  assert.throws(() => saveWallet(generatePrivateKey(), "password", path.join(tmpDir(), "w.json"), { n: N }), UsageError);
});

test("lockout: 5 failures within 10 minutes lock for 5 minutes (pure, injected time)", () => {
  const t0 = 1_000_000_000_000;
  let f = [];
  for (let i = 0; i < 4; i++) f = recordFailure(f, t0 + i * 1000);
  assert.equal(lockoutState(f, t0 + 5000).locked, false);
  f = recordFailure(f, t0 + 5000);
  const st = lockoutState(f, t0 + 6000);
  assert.equal(st.locked, true);
  assert.equal(st.retryAt, t0 + 5000 + LOCK_FOR_MS);
  assert.equal(lockoutState(f, t0 + 5000 + LOCK_FOR_MS).locked, false);
  // failures older than 10 minutes don't count
  const spread = [t0, t0 + 1, t0 + 2, t0 + 3, t0 + 11 * 60_000];
  assert.equal(lockoutState(spread, t0 + 11 * 60_000 + 1).locked, false);
  assert.equal(recordFailure(spread, t0 + 11 * 60_000 + 1).length, 2);
});

test("unlock: 3 tries per command, persisted lockout, NTAG_PASSWORD, success clears", async () => {
  const key = generatePrivateKey();
  const dir = tmpDir();
  const f = path.join(dir, "wallet.json");
  const address = saveWallet(key, PW, f, { n: N });
  let t = 2_000_000_000_000;
  const now = () => t;
  let asked = 0;
  const wrong = async () => { asked++; return "nope nope nope"; };
  await assert.rejects(unlockWallet(f, { getPassword: wrong, now, env: {} }), /3 times/);
  assert.equal(asked, 3);
  assert.equal(JSON.parse(fs.readFileSync(attemptsFile(f), "utf8")).failures.length, 3);
  t += 1000;
  await assert.rejects(unlockWallet(f, { getPassword: wrong, now, env: {} }), /locked/);
  assert.equal(asked, 5); // two more tries, then the 5-in-10-minutes lock kicks in
  await assert.rejects(unlockWallet(f, { getPassword: async () => PW, now, env: {} }), /locked/); // even the right one waits
  t += LOCK_FOR_MS + 1;
  const acct = await unlockWallet(f, { getPassword: async () => PW, now, env: {} });
  assert.equal(acct.address, address);
  assert.equal(fs.existsSync(attemptsFile(f)), false);
  const viaEnv = await unlockWallet(f, { now, env: { NTAG_PASSWORD: PW } });
  assert.equal(viaEnv.address, address);
  await assert.rejects(unlockWallet(f, { now, env: { NTAG_PASSWORD: "bad bad bad" } }), /NTAG_PASSWORD/);
});

test("payout detection and the per-wallet daily total (Blockscout items, pure)", () => {
  const owner = "0x2222222222222222222222222222222222222222";
  const item = (o) => ({ transaction_hash: o.hash, from: { hash: o.from ?? AGENT }, to: { hash: owner }, token: { address_hash: o.token }, total: { value: String(o.value) }, block_number: o.block, log_index: 1, timestamp: new Date(o.time * 1000).toISOString() });
  const items = [
    item({ hash: "0xaa", token: TOKENS.CNGN.address, value: 14_000_000_000n, block: 99, time: 1000 }),
    item({ hash: "0xbb", token: TOKENS.CNGN.address, value: 14_400_000_000n, block: 120, time: 2000 }),
    item({ hash: "0xcc", token: TOKENS.CNGN.address, value: 1n, block: 130, time: 2100, from: "0x9999999999999999999999999999999999999999" }),
    item({ hash: "0xdd", token: TOKENS.USDT.address, value: 5_000_000n, block: 110, time: 1500 }),
  ].map(transferFromItem);
  assert.equal(findPayout(items, { owner, token: TOKENS.CNGN.address, afterBlock: 100 }).hash, "0xbb");
  assert.equal(findPayout(items, { owner, token: TOKENS.CNGN.address, afterBlock: 120 }), null);
  assert.equal(findPayout(items, { owner, token: TOKENS.USDT.address, afterBlock: 100 }).hash, "0xdd");
  // since t=1500: 5 USD₮ + 14,400 cNGN at ₦1,440/$ = $15
  assert.equal(agentPaidUsd(items, { owner, sinceSec: 1500, ngnPerUsd: 1440 }), 15_000_000n);
  assert.equal(transferFromItem({ tx_hash: "0x1", from: { hash: AGENT }, to: { hash: owner }, token: { address: TOKENS.USDT.address }, total: { value: "7" }, block_number: 1, timestamp: "2026-01-01T00:00:00Z" }).units, 7n);
  assert.equal(transferFromItem({}), null);
});

test("plain-English errors", () => {
  assert.match(explainError(new Error("insufficient funds for gas * price + value")), /Not enough CELO/);
  assert.match(explainError(Object.assign(new Error("x"), { cause: new Error("fetch failed") })), /Network problem/);
  assert.match(explainError(new Error("ERC20: transfer amount exceeds balance")), /token balance/);
});

test("exit codes: 2 for bad usage, 0 for help (no network)", async () => {
  const errs = [], logs = [];
  const e = console.error, l = console.log;
  console.error = (...a) => errs.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  try {
    assert.equal(await main(["send", "@ada", "10.123"]), 2);
    assert.equal(await main(["send", "@ada", "0"]), 2);
    assert.equal(await main(["send", "@ada", "26"]), 2);
    assert.equal(await main(["send", "@1x", "10"]), 2);
    assert.equal(await main(["teleport"]), 2);
    assert.equal(await main(["wallet", "export"]), 2);
    assert.equal(await main(["help"]), 0);
  } finally { console.error = e; console.log = l; }
  assert.ok(logs.join("\n").includes("ntag send @ada 10"));
  assert.ok(errs.every((x) => !/0x[0-9a-f]{64}/i.test(x)));
});
