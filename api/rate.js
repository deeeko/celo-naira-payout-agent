// GET /api/rate — the live Textile FX rate (same shape as rate.json), cached at Vercel's edge for 60 s.
// Read-only. If Textile is down, it carries forward the deployment's static rate.json and marks it stale.
import { buildRate } from "../lib/rate.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const result = await buildRate({ timeoutMs: 8_000, carryForwardUrl: host ? `${proto}://${host}/rate.json` : undefined });
  const ok = Boolean(result.effectiveRate || result.ticker);
  res.setHeader("Cache-Control", ok ? "public, s-maxage=60, stale-while-revalidate=300" : "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(ok ? 200 : 503).json(result);
}
