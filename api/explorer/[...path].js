// GET /api/explorer/<blockscout v2 path>?<query> — a read-only, cached proxy for the Celo Blockscout API.
// Phones call our own origin (answered from Vercel's edge cache in milliseconds) instead of each hitting the
// rate-limited explorer. Only public read endpoints are allowed; nothing here can move funds.
const UPSTREAM = "https://celo.blockscout.com/api/v2";
const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;
// allowed path shapes (public data only)
const ALLOWED = [
  /^addresses\/0x[0-9a-fA-F]{40}\/(transactions|token-transfers|counters|tokens)$/,
  /^addresses\/0x[0-9a-fA-F]{40}$/,
  /^transactions\/0x[0-9a-fA-F]{64}(\/(token-transfers|logs))?$/,
  /^smart-contracts\/0x[0-9a-fA-F]{40}$/,
];

export function upstreamUrl(segments, query) {
  const parts = [].concat(segments ?? []).filter(Boolean);
  if (!parts.length || !parts.every((p) => SEGMENT.test(p))) return null;
  const path = parts.join("/");
  if (!ALLOWED.some((re) => re.test(path))) return null;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (k === "path" || k === "...path") continue; // the catch-all itself
    if (!/^[a-z_]{1,40}$/.test(k)) return null;
    const val = Array.isArray(v) ? v[0] : v;
    if (val == null || String(val).length > 120) return null;
    qs.set(k, String(val));
  }
  const q = qs.toString();
  return `${UPSTREAM}/${path}${q ? "?" + q : ""}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const url = upstreamUrl(req.query?.path ?? req.query?.["...path"], req.query);
  if (!url) return res.status(400).json({ error: "Not an allowed explorer path" });
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 9_000);
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: c.signal });
    clearTimeout(t);
    const body = await r.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", r.ok ? "public, s-maxage=15, stale-while-revalidate=60" : "no-store");
    return res.status(r.status).send(body);
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res.status(504).json({ error: "The Celo explorer didn't respond in time" });
  }
}
