// The Textile FX rate, shared by scripts/fetch-rate.mjs (static rate.json) and api/rate.js (live, on Vercel).
// Read-only: three free Textile price previews and the public rates feed. No wallet, no keys, no transactions.
// The four sources are fetched in parallel; each can fail on its own without hiding the others.

const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
const CELO = "0x471EcE3750Da237f93B8E339c536989b8978a438"; // CELO (GoldToken), ERC-20 interface
const DECIMALS = 6; // both USD₮ and cNGN on Celo (verified with decimals() on mainnet)
const CELO_DECIMALS = 18;
export const PREVIEW_USD = 10;
export const REVERSE_PREVIEW_NGN = 14400; // ≈ $10 in naira, for the cNGN -> USD₮ preview
// CELO -> USD₮ preview size. Textile needs about $1 per swap, and a CELO payout swaps twice (CELO -> USD₮ -> cNGN),
// so 20 CELO (about $1.10) is roughly the smallest amount that clears both hops.
export const CELO_PREVIEW = 20;

function signal(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal;
}
async function getJson(url, init = {}, ms) {
  const r = await fetch(url, { ...init, signal: signal(ms) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}
const preview = (sellToken, buyToken, whole, ms, decimals = DECIMALS) => getJson("https://api.textilecredit.com/v2/rfq/preview", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chainId: 42220, sellToken, buyToken, sellAmount: (BigInt(whole) * 10n ** BigInt(decimals)).toString() }),
}, ms);

/**
 * @param {{ timeoutMs?: number, carryForwardUrl?: string }} opts
 * @returns rate.json-shaped object: { fetchedAt, previewUsd, effectiveRate?, previewReceive?, reverseRate?, reversePreviewNgn?,
 *          reversePreviewReceive?, celoUsdRate?, celoPreviewCelo?, celoPreviewReceive?, ticker?, stale?, errors? }
 */
export async function buildRate({ timeoutMs = 30_000, carryForwardUrl } = {}) {
  const result = { fetchedAt: new Date().toISOString(), previewUsd: PREVIEW_USD };
  const errors = [];
  const [fwd, rev, celo, tick] = await Promise.allSettled([
    preview(USDT, CNGN, PREVIEW_USD, Math.max(timeoutMs, 8_000)),
    preview(CNGN, USDT, REVERSE_PREVIEW_NGN, Math.max(timeoutMs, 8_000)),
    preview(CELO, USDT, CELO_PREVIEW, Math.max(timeoutMs, 8_000), CELO_DECIMALS),
    getJson("https://api.textilecredit.com/tickers?ticker_id=USDT_NGN", {}, timeoutMs),
  ]);

  try {
    if (fwd.status === "rejected") throw fwd.reason;
    const pv = fwd.value;
    if (pv?.data?.status !== "preview") throw new Error(`preview status ${pv?.data?.status}`);
    const received = Number(BigInt(pv.data.buyAmount)) / 10 ** DECIMALS;
    result.effectiveRate = +(received / PREVIEW_USD).toFixed(4);
    result.previewReceive = +received.toFixed(2);
  } catch (e) { errors.push(`preview: ${e.message}`); }

  try {
    if (rev.status === "rejected") throw rev.reason;
    const pv = rev.value;
    if (pv?.data?.status !== "preview") throw new Error(`reverse preview status ${pv?.data?.status}`);
    const received = Number(BigInt(pv.data.buyAmount)) / 10 ** DECIMALS;
    if (!(received > 0)) throw new Error("reverse preview returned zero");
    result.reversePreviewNgn = REVERSE_PREVIEW_NGN;
    result.reverseRate = +(received / REVERSE_PREVIEW_NGN).toFixed(8); // USD₮ received per 1 NGN, fee included
    result.reversePreviewReceive = +received.toFixed(6);
  } catch (e) { errors.push(`reverse preview: ${e.message}`); }

  try {
    if (celo.status === "rejected") throw celo.reason;
    const pv = celo.value;
    if (pv?.data?.status !== "preview") throw new Error(`celo preview status ${pv?.data?.status}`);
    const received = Number(BigInt(pv.data.buyAmount)) / 10 ** DECIMALS; // USD₮, 6 decimals
    if (!(received > 0)) throw new Error("celo preview returned zero");
    result.celoPreviewCelo = CELO_PREVIEW;
    result.celoUsdRate = +(received / CELO_PREVIEW).toFixed(6); // USD₮ received per 1 CELO, Textile fee included
    result.celoPreviewReceive = +received.toFixed(6);
  } catch (e) { errors.push(`celo preview: ${e.message}`); }

  try {
    if (tick.status === "rejected") throw tick.reason;
    const t = tick.value;
    if (Array.isArray(t) && t[0]) result.ticker = { bid: t[0].bid, ask: t[0].ask, last: t[0].last_price };
    else throw new Error("empty ticker");
  } catch (e) { errors.push(`ticker: ${e.message}`); }

  if (!result.effectiveRate && !result.ticker && carryForwardUrl) {
    try {
      const prev = await getJson(carryForwardUrl, {}, 8_000);
      if (prev.effectiveRate || prev.ticker) {
        // keep reverse and CELO rates fetched just now rather than the carried-forward ones
        const fresh = {
          ...(result.reverseRate ? { reversePreviewNgn: result.reversePreviewNgn, reverseRate: result.reverseRate, reversePreviewReceive: result.reversePreviewReceive } : {}),
          ...(result.celoUsdRate ? { celoPreviewCelo: result.celoPreviewCelo, celoUsdRate: result.celoUsdRate, celoPreviewReceive: result.celoPreviewReceive } : {}),
        };
        Object.assign(result, prev, fresh, { stale: true });
      }
    } catch (e) { errors.push(`carry-forward: ${e.message}`); }
  }
  if (errors.length) result.errors = errors;
  return result;
}
