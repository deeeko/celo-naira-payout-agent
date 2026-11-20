// Live data for the page. No libraries, no keys: Celo RPC (Forno) and Blockscout are read
// straight from the browser; the Textile rate is fetched server-side every 30 min into rate.json
// (Textile's rates feed does not allow browser requests from other sites).
const RPC = "https://forno.celo.org";
const EXPLORER_API = "https://celo.blockscout.com/api/v2";
const AGENT = "0x8a695cf54CB44753c8b784EB36d266f748617a1e";
const AGENT_ID = 10079n;
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const TAG = "celo_7360953d1b53";
const TOKENS = {
  USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  cNGN: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
};
const CAP = 25;
const MARKER = "80218021802180218021802180218021"; // ERC-8021 suffix marker

const $ = (id) => document.getElementById(id);
const naira = (n) => "₦" + n.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lagosTime = (d) =>
  new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " WAT";
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

// ---------- rate + calculator ----------
let rate = null;
function recalc() {
  const v = Number($("usd").value);
  const msg = $("cap-msg");
  if (!rate) return;
  if (!Number.isFinite(v) || v <= 0) { $("out").textContent = "₦ —"; msg.textContent = "Enter an amount in dollars."; return; }
  msg.textContent = v > CAP ? `The agent pays at most $${CAP} at a time, so it would refuse this amount.` : "";
  $("out").textContent = naira(v * rate);
}
async function loadRate() {
  try {
    const r = await fetch("rate.json", { cache: "no-store" });
    const d = await r.json();
    rate = Number(d.effectiveRate ?? d.ticker?.bid);
    if (!rate) throw new Error(d.error ?? "no rate");
    $("rate").textContent = naira(rate) + " / USD₮";
    $("asof").textContent = `Textile FX rate for a $${d.previewUsd ?? 10} payout, fee included. Updated ${lagosTime(d.fetchedAt)}.`;
    recalc();
  } catch {
    $("rate").textContent = "unavailable";
    $("asof").textContent = "The rate could not be loaded. Try again in a few minutes.";
  }
}
$("usd").addEventListener("input", recalc);

// ---------- minimal JSON-RPC + ABI helpers ----------
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const pad = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
function decodeString(hex) {
  const h = hex.replace(/^0x/, "");
  const off = parseInt(h.slice(0, 64), 16) * 2;
  const len = parseInt(h.slice(off, off + 64), 16) * 2;
  const bytes = h.slice(off + 64, off + 64 + len).match(/../g) ?? [];
  return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
}
const units = (hex, dec) => Number(BigInt(hex)) / 10 ** dec;

/** ERC-8021 schema 0: [codes][len:1][schema:1][marker:16] at the very end of calldata. */
export function decodeTag(input) {
  const h = (input ?? "").toLowerCase().replace(/^0x/, "");
  if (!h.endsWith(MARKER)) return null;
  const body = h.slice(0, -MARKER.length);
  const schema = body.slice(-2);
  if (schema !== "00") return { schema: parseInt(schema, 16), codes: [] };
  const len = parseInt(body.slice(-4, -2), 16);
  const codeHex = body.slice(-4 - len * 2, -4);
  const text = new TextDecoder().decode(new Uint8Array((codeHex.match(/../g) ?? []).map((b) => parseInt(b, 16))));
  return { schema: 0, codes: text.split(",") };
}

// ---------- identity + balances ----------
async function loadIdentity() {
  try {
    const owner = "0x" + (await call(REGISTRY, "0x6352211e" + pad(AGENT_ID.toString(16)))).slice(-40);
    const ok = owner.toLowerCase() === AGENT.toLowerCase();
    $("owner-check").innerHTML = ok ? '<span class="ok">owned by the agent wallet ✓</span>' : "owner " + short(owner);
    const uri = decodeString(await call(REGISTRY, "0xc87b56dd" + pad(AGENT_ID.toString(16))));
    if (uri.startsWith("data:application/json;base64,")) {
      const file = JSON.parse(atob(uri.split(",")[1]));
      $("reg-name").textContent = file.name + (file.registrations?.[0]?.agentId == 10079 ? " (id cross-checks ✓)" : "");
    } else $("reg-name").textContent = uri;
  } catch {
    $("owner-check").textContent = "could not read the registry";
    $("reg-name").textContent = "—";
  }
}
async function loadBalances() {
  try {
    const bal = (t) => call(t, "0x70a08231" + pad(AGENT));
    const dec = async (t) => parseInt(await call(t, "0x313ce567"), 16);
    const [celo, usdt, cngn, dU, dN] = await Promise.all([rpc("eth_getBalance", [AGENT, "latest"]), bal(TOKENS.USDT), bal(TOKENS.cNGN), dec(TOKENS.USDT), dec(TOKENS.cNGN)]);
    $("balances").textContent = `${units(celo, 18).toFixed(2)} CELO · ${units(usdt, dU).toFixed(2)} USD₮ · ${units(cngn, dN).toFixed(2)} cNGN`;
  } catch {
    $("balances").textContent = "could not read balances";
  }
}

// ---------- ledger ----------
const LABELS = {
  register: "Registered its identity",
  setAgentURI: "Updated its identity file",
  approve: "Allowed Textile to take the USD₮",
  transfer: "Paid cNGN to the recipient",
};
function slip(tx) {
  const tag = decodeTag(tx.raw_input);
  const tagged = tag?.codes?.includes(TAG);
  const label = LABELS[tx.method] ?? (tx.to?.hash?.toLowerCase() === TOKENS.cNGN.toLowerCase() ? "Paid cNGN to the recipient" : "Converted USD₮ to cNGN on Textile FX");
  const el = document.createElement("article");
  el.className = "slip";
  el.innerHTML = `
    <div class="what"></div>
    <div class="meta"></div>
    <div class="stamp ${tagged ? "" : "none"}"></div>`;
  el.querySelector(".what").textContent = (tx.status === "ok" ? "" : "Failed: ") + label;
  const meta = el.querySelector(".meta");
  meta.append(`${lagosTime(tx.timestamp)} · `);
  const a = document.createElement("a");
  a.href = `https://celoscan.io/tx/${tx.hash}`;
  a.textContent = short(tx.hash);
  meta.append(a);
  el.querySelector(".stamp").innerHTML = tagged ? `Tagged<br>${TAG}` : "No tag";
  return el;
}
async function loadLedger() {
  const box = $("ledger");
  try {
    const r = await fetch(`${EXPLORER_API}/addresses/${AGENT}/transactions?filter=from`);
    const d = await r.json();
    const items = (d.items ?? []).filter((t) => t.from?.hash?.toLowerCase() === AGENT.toLowerCase());
    box.replaceChildren();
    if (!items.length) { box.innerHTML = '<div class="empty">No transactions from the agent yet. They appear here as soon as it sends one.</div>'; return; }
    items.forEach((t) => box.append(slip(t)));
  } catch {
    box.innerHTML = '<div class="empty">The Celo explorer did not respond. Reload the page in a minute.</div>';
  }
}

loadRate();
loadIdentity();
loadBalances();
loadLedger();
