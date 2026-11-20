// Live data for the page. No libraries, no keys: Celo RPC (Forno) and Blockscout are read
// straight from the browser. The Textile rate is fetched by a GitHub Action every 30 min into
// rate.json, because Textile's rates feed does not allow browser requests from other sites.
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
const num2 = new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const naira = (n) => "₦" + num2.format(n);
const lagosTime = (d) =>
  new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " WAT";
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

async function getJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- rate + calculator ----------
let rate = null;
function recalc() {
  const input = $("usd");
  const v = Number(input.value.trim().replace(",", "."));
  const out = $("out");
  const msg = $("cap-msg");
  if (!rate) return;
  const bad = !Number.isFinite(v) || v <= 0;
  input.setAttribute("aria-invalid", String(bad || v > CAP));
  if (bad) { out.textContent = "≈ ₦ —"; out.style.setProperty("--n", 5); msg.textContent = "Enter an amount in dollars."; return; }
  msg.textContent = v > CAP ? `Over the $${CAP} cap: the agent would refuse this.` : "";
  const s = "≈ " + naira(v * rate);
  out.textContent = s;
  out.style.setProperty("--n", s.length);
  out.classList.toggle("over", v > CAP);
}
async function loadRate() {
  try {
    const d = await getJson("rate.json", { cache: "no-store" });
    const fromPreview = Number(d.effectiveRate) > 0;
    rate = fromPreview ? Number(d.effectiveRate) : Number(d.ticker?.bid);
    if (!(rate > 0)) throw new Error(d.error ?? "no rate");
    $("rate").textContent = naira(rate) + " / USD₮";
    $("rate").classList.add("ready");
    const what = fromPreview
      ? `Textile FX preview for a $${d.previewUsd ?? 10} payout, fee included.`
      : "Textile FX market bid, before fees.";
    let note = `${what} Updated ${lagosTime(d.fetchedAt)}.`;
    const ageMin = (Date.now() - Date.parse(d.fetchedAt)) / 60000;
    if (d.stale || ageMin > 120) note += ` This rate is about ${Math.max(1, Math.round(ageMin / 60))} h old.`;
    $("asof").textContent = note;
    recalc();
  } catch {
    $("rate").textContent = "unavailable";
    $("asof").textContent = "The rate could not be loaded. Reload the page in a few minutes.";
  }
}
$("usd").addEventListener("input", recalc);
$("usd").addEventListener("focus", (e) => e.target.select());

// ---------- minimal JSON-RPC + ABI helpers ----------
async function rpc(method, params) {
  const j = await getJson(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const pad = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const hexBytes = (h) => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
function decodeString(hex) {
  const h = hex.replace(/^0x/, "");
  const off = parseInt(h.slice(0, 64), 16) * 2;
  const len = parseInt(h.slice(off, off + 64), 16) * 2;
  return new TextDecoder().decode(hexBytes(h.slice(off + 64, off + 64 + len)));
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
  const text = new TextDecoder().decode(hexBytes(body.slice(-4 - len * 2, -4)));
  return { schema: 0, codes: text.split(",") };
}

// ---------- identity + balances ----------
async function loadIdentity() {
  const oc = $("owner-check");
  try {
    const id = pad(AGENT_ID.toString(16));
    const owner = "0x" + (await call(REGISTRY, "0x6352211e" + id)).slice(-40);
    const ok = owner.toLowerCase() === AGENT.toLowerCase();
    oc.textContent = ok ? "owned by the agent wallet ✓" : "owner " + short(owner);
    oc.className = ok ? "ok" : "";
    const uri = decodeString(await call(REGISTRY, "0xc87b56dd" + id));
    const reg = $("reg-name");
    if (uri.startsWith("data:application/json;base64,")) {
      const bin = atob(uri.slice(uri.indexOf(",") + 1));
      const file = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
      const matches = (file.registrations ?? []).some((r) => { try { return BigInt(r.agentId) === AGENT_ID; } catch { return false; } });
      reg.textContent = String(file.name ?? "unnamed") + (matches ? " (id cross-checks ✓)" : "");
    } else reg.textContent = uri;
  } catch {
    oc.textContent = "could not read the registry";
    oc.className = "";
    $("reg-name").textContent = "—";
  }
}
async function loadBalances() {
  try {
    const bal = (t) => call(t, "0x70a08231" + pad(AGENT));
    const dec = async (t) => parseInt(await call(t, "0x313ce567"), 16);
    const [celo, usdt, cngn, dU, dN] = await Promise.all([rpc("eth_getBalance", [AGENT, "latest"]), bal(TOKENS.USDT), bal(TOKENS.cNGN), dec(TOKENS.USDT), dec(TOKENS.cNGN)]);
    $("balances").textContent = `${num2.format(units(celo, 18))} CELO · ${num2.format(units(usdt, dU))} USD₮ · ${num2.format(units(cngn, dN))} cNGN`;
  } catch {
    $("balances").textContent = "could not read balances";
  }
}

// ---------- ledger ----------
function labelFor(tx) {
  const to = tx.to?.hash?.toLowerCase();
  const is = (a) => to === a.toLowerCase();
  if (is(REGISTRY)) return tx.method === "register" ? "Registered its identity" : tx.method === "setAgentURI" ? "Updated its identity file" : "Updated its identity";
  if (is(TOKENS.cNGN) && tx.method === "transfer") return "Paid cNGN to the recipient";
  if (is(TOKENS.USDT) && tx.method === "approve") {
    const zero = /0{64}$/.test((tx.raw_input ?? "").slice(0, 138));
    return zero ? "Reset Textile's USD₮ allowance" : "Let Textile's contract take the USD₮";
  }
  if ((tx.token_transfers ?? tx.token_transfers_overflow) || /execute/i.test(tx.method ?? "")) return "Converted USD₮ to cNGN on Textile FX";
  return tx.method ? `Called ${tx.method}` : "Other transaction";
}
function slip(tx, i) {
  const tag = decodeTag(tx.raw_input);
  const tagged = tag?.codes?.includes(TAG);
  const el = document.createElement("article");
  el.className = "slip";
  el.style.animationDelay = `${i * 60}ms`;
  const what = document.createElement("div");
  what.className = "what";
  const prefix = tx.status === "ok" ? "" : tx.status === "error" ? "Failed: " : "Pending: ";
  what.textContent = prefix + labelFor(tx);
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.append(`${tx.timestamp ? lagosTime(tx.timestamp) : "just sent"} · `);
  const a = document.createElement("a");
  a.href = `https://celoscan.io/tx/${tx.hash}`;
  a.textContent = short(tx.hash);
  a.setAttribute("translate", "no");
  a.setAttribute("aria-label", `View transaction ${short(tx.hash)} on Celoscan`);
  meta.append(a);
  const stamp = document.createElement("div");
  stamp.className = tagged ? "stamp" : "stamp none";
  stamp.setAttribute("translate", "no");
  if (tagged) {
    const code = document.createElement("code");
    code.textContent = TAG;
    stamp.append("Tagged", document.createElement("br"), code);
  } else stamp.textContent = "No tag";
  el.append(what, meta, stamp);
  return el;
}
function notice(text, link) {
  const n = document.createElement("div");
  n.className = "notice";
  n.append(text);
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.textContent = link.text;
    n.append(" ", a);
  }
  return n;
}
async function loadLedger() {
  const box = $("ledger");
  try {
    const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/transactions?filter=from`);
    if (!Array.isArray(d.items)) throw new Error("unexpected response");
    const items = d.items.filter((t) => t.from?.hash?.toLowerCase() === AGENT.toLowerCase());
    box.replaceChildren();
    if (!items.length) {
      box.append(notice("No transactions from the agent yet. They appear here as soon as it sends one."));
    } else {
      const paid = items.some((t) => t.to?.hash?.toLowerCase() === TOKENS.cNGN.toLowerCase() && t.method === "transfer");
      if (!paid) box.append(notice("No payout has been sent yet. The slips below are the agent registering its identity."));
      items.forEach((t, i) => box.append(slip(t, i)));
      if (d.next_page_params) box.append(notice("Showing the latest 50.", { href: `https://celoscan.io/address/${AGENT}`, text: "See all on Celoscan" }));
    }
  } catch {
    box.replaceChildren(notice("The Celo explorer did not respond. Reload in a minute, or", { href: `https://celoscan.io/address/${AGENT}`, text: "view the wallet on Celoscan" }));
  } finally {
    box.removeAttribute("aria-busy");
  }
}

loadRate();
loadIdentity();
loadBalances();
loadLedger();
