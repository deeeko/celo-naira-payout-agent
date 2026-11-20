// Runs in GitHub Actions every 30 minutes (and locally for previews). Writes the live page's rate.json.
// Read-only: a free Textile price preview and the public rates feed. No wallet, no keys, no transactions.
// Each source is tried on its own; if both fail, the last published rate is carried forward and marked stale.
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "site/rate.json";
const LIVE = "https://deeeko.github.io/celo-naira-payout-agent/rate.json";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
const DECIMALS = 6; // both USD₮ and cNGN on Celo (verified with decimals() on mainnet)
const PREVIEW_USD = 10;

async function getJson(url, init = {}, ms = 30_000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

const result = { fetchedAt: new Date().toISOString(), previewUsd: PREVIEW_USD };
const errors = [];

try {
  const sellAmount = (BigInt(PREVIEW_USD) * 10n ** BigInt(DECIMALS)).toString();
  const pv = await getJson("https://api.textilecredit.com/v2/rfq/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: 42220, sellToken: USDT, buyToken: CNGN, sellAmount }),
  }, 75_000);
  if (pv?.data?.status !== "preview") throw new Error(`preview status ${pv?.data?.status}`);
  const received = Number(BigInt(pv.data.buyAmount)) / 10 ** DECIMALS;
  result.effectiveRate = +(received / PREVIEW_USD).toFixed(4);
  result.previewReceive = +received.toFixed(2);
} catch (e) { errors.push(`preview: ${e.message}`); }

try {
  const t = await getJson("https://api.textilecredit.com/tickers?ticker_id=USDT_NGN");
  if (Array.isArray(t) && t[0]) result.ticker = { bid: t[0].bid, ask: t[0].ask, last: t[0].last_price };
  else throw new Error("empty ticker");
} catch (e) { errors.push(`ticker: ${e.message}`); }

if (!result.effectiveRate && !result.ticker) {
  try {
    const prev = await getJson(LIVE, {}, 15_000);
    if (prev.effectiveRate || prev.ticker) Object.assign(result, prev, { stale: true });
  } catch (e) { errors.push(`carry-forward: ${e.message}`); }
}
if (errors.length) result.errors = errors;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
