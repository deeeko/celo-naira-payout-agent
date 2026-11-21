// Small helpers in site/assets/core.js used by the Send, Overview, pay-link and receipt pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ageText, isNetworkError, LIMITS_TEXT, CAP, WALLET_DAILY_CAP, DAILY_CAP, parseMoneyInput } from "../site/assets/core.js";

test("the limits line matches the agent's defaults in src/config.mjs", () => {
  const cfg = fs.readFileSync(new URL("../src/config.mjs", import.meta.url), "utf8");
  assert.match(cfg, new RegExp(`MAX_DAILY_USD \\?\\? "${DAILY_CAP}"`));
  assert.match(cfg, new RegExp(`MAX_WALLET_DAILY_USD \\?\\? "${WALLET_DAILY_CAP}"`));
  assert.equal(CAP, 25);
  assert.equal(LIMITS_TEXT, "$25 per payment · $25 per person per day · $100 per day overall");
});

test("every page that shows the limits line uses the same text", () => {
  for (const page of ["quote.html", "pay.html", "docs.html"]) {
    const html = fs.readFileSync(new URL(`../site/${page}`, import.meta.url), "utf8");
    assert.match(html, /<b>\$25 per payment<\/b> · <b>\$25 per person per day<\/b> · <b>\$100 per day overall<\/b>/, page);
  }
});

test("ageText says how old the rate is", () => {
  assert.equal(ageText(0), "just now");
  assert.equal(ageText(12), "12 min ago");
  assert.equal(ageText(540), "9 h ago");
  assert.equal(ageText(3 * 1440), "3 days ago");
});

test("isNetworkError only blames the network for network failures", () => {
  assert.equal(isNetworkError(new TypeError("Failed to fetch")), true);
  assert.equal(isNetworkError(new TypeError("Load failed")), true);
  assert.equal(isNetworkError(Object.assign(new Error("timed out"), { name: "TimeoutError" })), true);
  assert.equal(isNetworkError(new Error("HTTP 503")), true);
  assert.equal(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'x')")), false);
  assert.equal(isNetworkError(new SyntaxError("Unexpected token <")), false);
  assert.equal(isNetworkError(new Error("execution reverted")), false);
  assert.equal(isNetworkError(null), false);
});

test("amounts with a decimal comma are read exactly, never as a bigger number", () => {
  assert.deepEqual(parseMoneyInput("1,5"), { cents: 150 });
  assert.deepEqual(parseMoneyInput("1,250"), { cents: 125000 });
  assert.deepEqual(parseMoneyInput("$24.99"), { cents: 2499 });
  assert.ok(parseMoneyInput("10.505").error);
});
