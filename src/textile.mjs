// Textile FX RFQ client (v2). Keyless: quotes need only a wallet; no API key.
// Docs: https://fx-docs.textilecredit.com/api/v2/rfq
import crypto from "node:crypto";
import { toHex } from "viem";
import { CHAIN, TEXTILE_API, TOKENS } from "./config.mjs";

async function call(method, path, { body, headers } = {}) {
  const res = await fetch(`${TEXTILE_API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(75_000), // firm quotes can block up to ~70s on a cold corridor
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

export function rfqBody(sellAmount, taker) {
  return {
    chainId: CHAIN.id,
    sellToken: TOKENS.USDT.address,
    buyToken: TOKENS.CNGN.address,
    sellAmount: String(sellAmount),
    ...(taker ? { taker } : {}),
  };
}

/** Free, indicative price. No wallet, no proof, reserves nothing. */
export async function preview(sellAmount) {
  const r = await call("POST", "/rfq/preview", { body: rfqBody(sellAmount) });
  if (r.status !== 200) throw new Error(`Preview failed (${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json.data; // { status: "preview" | "no_quote", buyAmount, takerPays, feeAmount, ... }
}

/** Proof that the taker wallet is controlled by us. Moves no funds. */
export async function signTakerControl(account) {
  const nonce = toHex(crypto.randomBytes(32));
  const issuedAt = Date.now(); // Unix milliseconds
  const signature = await account.signTypedData({
    domain: { name: "Textile Taker Control", version: "1", chainId: CHAIN.id },
    types: {
      TakerControl: [
        { name: "taker", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "TakerControl",
    message: { taker: account.address, chainId: BigInt(CHAIN.id), nonce, issuedAt: BigInt(issuedAt) },
  });
  return { nonce, issuedAt, signature };
}

/** Firm, signed quote. Sends unsigned first; signs the proof only if Textile asks for it. */
export async function firmQuote(account, sellAmount) {
  const send = (extra = {}) =>
    call("POST", "/rfq/request", { body: { ...rfqBody(sellAmount, account.address), ...extra } });
  let r = await send();
  if (r.status === 401 && r.json?.error?.details?.reason === "proof_of_control_required") {
    r = await send({ takerProof: await signTakerControl(account) });
  }
  if (r.status !== 200) throw new Error(`Firm quote failed (${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
  const d = r.json.data;
  if (d.status === "no_quote") throw new Error(`No quote available (${d.reason}). Try a different size or later.`);
  return d; // { rfqId, claimToken, quote, transactions: { approval, swap } }
}

/** Report the swap hash so Textile can reconcile the fill. Best effort. */
export async function submit(rfqId, claimToken, txHash) {
  const r = await call("POST", `/rfq/${rfqId}/submit`, {
    body: { txHash },
    headers: { "X-Rfq-Claim": claimToken },
  });
  return r.status;
}
