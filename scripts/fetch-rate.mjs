// Runs in GitHub Actions every 30 minutes (and locally for previews). Writes the live page's rate.json.
// Read-only: a free Textile price preview and the public rates feed. No wallet, no keys, no transactions.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, erc20Abi, http } from "viem";
import { celo } from "viem/chains";

const out = process.argv[2] ?? "site/rate.json";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
const PREVIEW_USD = 10;

const result = { fetchedAt: new Date().toISOString(), previewUsd: PREVIEW_USD };
try {
  const pub = createPublicClient({ chain: celo, transport: http() });
  const [dU, dN] = await Promise.all([
    pub.readContract({ address: USDT, abi: erc20Abi, functionName: "decimals" }),
    pub.readContract({ address: CNGN, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const sellAmount = (BigInt(PREVIEW_USD) * 10n ** BigInt(dU)).toString();
  const pv = await fetch("https://api.textilecredit.com/v2/rfq/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: 42220, sellToken: USDT, buyToken: CNGN, sellAmount }),
    signal: AbortSignal.timeout(60_000),
  }).then((r) => r.json());
  if (pv?.data?.status === "preview") {
    const received = Number(BigInt(pv.data.buyAmount)) / 10 ** dN;
    result.effectiveRate = +(received / PREVIEW_USD).toFixed(4);
    result.previewReceive = +received.toFixed(2);
  }
  const t = await fetch("https://api.textilecredit.com/tickers?ticker_id=USDT_NGN", { signal: AbortSignal.timeout(30_000) }).then((r) => r.json());
  if (Array.isArray(t) && t[0]) result.ticker = { bid: t[0].bid, ask: t[0].ask, last: t[0].last_price };
  if (!result.effectiveRate && !result.ticker) result.error = "Textile returned no price";
} catch (e) {
  result.error = String(e.message ?? e);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
