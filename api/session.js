// POST /api/session — checks a wallet sign-in. Body: { message, signature } (JSON, at most 4 KB).
// Stateless: no cookies, no database, nothing is stored or logged. It verifies the signature (EOA, EIP-191) and that
// the message is our sign-in text for this site, on Celo, and not expired. Returns { ok, address, exp } or 400.
import { verifyMessage, getAddress } from "viem";
import { parseSignInMessage, signInMessageError } from "../site/assets/session.js";

export const MAX_BODY = 4096;
export const KNOWN_HOSTS = ["naira-payout.vercel.app", "celo-naira-payout-agent.vercel.app"];

/** Checks { message, signature } signed for `host`. Resolves { ok: true, address, exp } or { ok: false, error }. */
export async function checkSignIn(body, { host, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const { message, signature } = body ?? {};
  if (typeof message !== "string" || typeof signature !== "string") return { ok: false, error: "message and signature are required" };
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, error: "invalid signature format" };
  const p = parseSignInMessage(message);
  const err = signInMessageError(p, nowSec);
  if (err) return { ok: false, error: err };
  const reqHost = String(host ?? "").toLowerCase();
  if (p.host !== reqHost && !KNOWN_HOSTS.includes(p.host)) return { ok: false, error: "signed for a different site" };
  let valid = false;
  try { valid = await verifyMessage({ address: p.address, message, signature }); } catch { valid = false; }
  if (!valid) return { ok: false, error: "the signature does not match the address" };
  return { ok: true, address: getAddress(p.address), exp: p.exp };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!/^application\/json\b/i.test(String(req.headers?.["content-type"] ?? ""))) {
    return res.status(415).json({ ok: false, error: "Send JSON" });
  }
  if (Number(req.headers?.["content-length"] ?? 0) > MAX_BODY) return res.status(413).json({ ok: false, error: "Body too large" });
  let body = req.body;
  try {
    if (typeof body === "string" || Buffer.isBuffer(body)) {
      if (body.length > MAX_BODY) return res.status(413).json({ ok: false, error: "Body too large" });
      body = JSON.parse(String(body));
    } else if (body && JSON.stringify(body).length > MAX_BODY) {
      return res.status(413).json({ ok: false, error: "Body too large" });
    }
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ ok: false, error: "Invalid body" });
  const result = await checkSignIn(body, { host: req.headers?.["x-forwarded-host"] || req.headers?.host });
  return res.status(result.ok ? 200 : 400).json(result);
}
