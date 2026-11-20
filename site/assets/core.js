// Shared data + behaviour for every page. No libraries, no keys.
// Celo RPC (Forno) and Blockscout are read straight from the browser. The Textile rate comes from
// rate.json, refreshed every 30 min by a GitHub Action (Textile's rates feed blocks other sites).

export const RPC = "https://forno.celo.org";
export const EXPLORER_API = "https://celo.blockscout.com/api/v2";
export const AGENT = "0x8a695cf54CB44753c8b784EB36d266f748617a1e";
export const AGENT_ID = 10079n;
export const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const TAG = "celo_7360953d1b53";
export const TOKENS = {
  USDT: { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", symbol: "USD₮" },
  cNGN: { address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f", symbol: "cNGN" },
};
export const CAP = 25;
export const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"; // ERC-8004 Reputation Registry (proxy), Celo mainnet
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Both supported corridors. Amounts for both tokens use 6 decimals on Celo. */
export const CORRIDORS = {
  "usdt-cngn": { id: "usdt-cngn", sell: "USDT", buy: "cNGN", label: "USD₮ → cNGN", blurb: "Pay someone in naira" },
  "cngn-usdt": { id: "cngn-usdt", sell: "cNGN", buy: "USDT", label: "cNGN → USD₮", blurb: "Pay someone in dollars" },
};
/** Function selectors (computed with viem, see SPEC). */
export const SEL = {
  giveFeedback: "0x3c036a7e", // giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)
  getClients: "0x42dd519c", // getClients(uint256) -> address[]
  readAllFeedback: "0xd9d84224", // readAllFeedback(uint256,address[],string,string,bool) -> (address[],uint64[],int128[],uint8[],string[],string[],bool[])
  transfer: "0xa9059cbb",
};
export const REPO = "https://github.com/deeeko/celo-naira-payout-agent";
export const celoscanTx = (h) => `https://celoscan.io/tx/${h}`;
export const celoscanAddr = (a) => `https://celoscan.io/address/${a}`;
const MARKER = "80218021802180218021802180218021"; // ERC-8021 suffix marker

// ---------- formatting ----------
export const num2 = new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const naira = (n) => "₦" + num2.format(n);
export const usd = (n) => "$" + num2.format(n);
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
export const lagos = (d, opts) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Lagos", ...opts });
export const lagosTime = (d) => lagos(d, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const lagosClock = (d) => lagos(d, { hour: "2-digit", minute: "2-digit" });
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- network ----------
/** fetch JSON with a 12 s timeout and one retry on network errors, 429 and 5xx. */
export async function getJson(url, init = {}, attempt = 0) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { retry: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    const retryable = e.retry || e.name === "TypeError" || e.name === "TimeoutError" || e.name === "AbortError";
    if (attempt === 0 && retryable) {
      await new Promise((res) => setTimeout(res, 800));
      return getJson(url, init, 1);
    }
    throw e;
  }
}
export async function rpc(method, params) {
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
  const schema = parseInt(body.slice(-2), 16);
  if (schema !== 0) return { schema, codes: [] };
  const len = parseInt(body.slice(-4, -2), 16);
  const text = new TextDecoder().decode(hexBytes(body.slice(-4 - len * 2, -4)));
  return { schema: 0, codes: text.split(",") };
}
export const isTagged = (tx) => !!decodeTag(tx.raw_input ?? tx.input)?.codes?.includes(TAG);

/** The ERC-8021 schema-0 suffix for TAG, to append to calldata a page asks a wallet to send. */
export function tagSuffix() {
  const code = [...new TextEncoder().encode(TAG)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return code + (TAG.length).toString(16).padStart(2, "0") + "00" + MARKER;
}

// ---------- minimal ABI codec (enough for the registries and ERC-20) ----------
// Types: uintN, intN, address, bool, bytes32, string, bytes, and T[] of any of these.
const isDyn = (t) => t === "string" || t === "bytes" || t.endsWith("[]");
const word = (n) => n.toString(16).padStart(64, "0");
function encStatic(t, v) {
  if (t === "address") return String(v).toLowerCase().replace(/^0x/, "").padStart(64, "0");
  if (t === "bool") return word(v ? 1n : 0n);
  if (t === "bytes32") return String(v).replace(/^0x/, "").padEnd(64, "0");
  if (t.startsWith("int")) { const b = BigInt(v); return word(b < 0n ? (1n << 256n) + b : b); }
  if (t.startsWith("uint")) return word(BigInt(v));
  throw new Error(`abi: unsupported type ${t}`);
}
function encBytes(u8) {
  const hex = [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
  return word(BigInt(u8.length)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
}
export function abiEncode(types, values) {
  let head = "", tail = "";
  const headLen = types.length * 32;
  types.forEach((t, i) => {
    if (!isDyn(t)) { head += encStatic(t, values[i]); return; }
    head += word(BigInt(headLen + tail.length / 2));
    if (t === "string") tail += encBytes(new TextEncoder().encode(values[i]));
    else if (t === "bytes") tail += encBytes(hexBytes(String(values[i]).replace(/^0x/, "")));
    else { const inner = t.slice(0, -2); const arr = values[i]; tail += word(BigInt(arr.length)) + abiEncode(arr.map(() => inner), arr); }
  });
  return head + tail; // no 0x
}
export const encodeCall = (selector, types, values) => selector + abiEncode(types, values);
function decAt(t, h, pos) {
  const w = h.slice(pos * 2, pos * 2 + 64);
  if (t === "address") return "0x" + w.slice(24);
  if (t === "bool") return BigInt("0x" + w) !== 0n;
  if (t === "bytes32") return "0x" + w;
  if (t.startsWith("int")) { const b = BigInt("0x" + w); return b >= 1n << 255n ? b - (1n << 256n) : b; }
  if (t.startsWith("uint")) return BigInt("0x" + w);
  throw new Error(`abi: unsupported type ${t}`);
}
function decParams(types, h, base) {
  return types.map((t, i) => {
    const at = base + i * 32;
    if (!isDyn(t)) return decAt(t, h, at);
    const start = base + Number(BigInt("0x" + h.slice(at * 2, at * 2 + 64)));
    const len = Number(BigInt("0x" + h.slice(start * 2, start * 2 + 64)));
    if (t === "string" || t === "bytes") {
      const bytes = hexBytes(h.slice((start + 32) * 2, (start + 32 + len) * 2));
      return t === "string" ? new TextDecoder().decode(bytes) : "0x" + h.slice((start + 32) * 2, (start + 32 + len) * 2);
    }
    const inner = t.slice(0, -2);
    return decParams(Array(len).fill(inner), h, start + 32);
  });
}
export const abiDecode = (types, hex) => decParams(types, String(hex).replace(/^0x/, ""), 0);
/** eth_call with an encoded call; returns decoded outputs. */
export async function readContract(to, selector, inTypes, args, outTypes) {
  return abiDecode(outTypes, await rpc("eth_call", [{ to, data: encodeCall(selector, inTypes, args) }, "latest"]));
}

// ---------- receipts + transfers ----------
export const loadReceipt = (hash) => rpc("eth_getTransactionReceipt", [hash]);
/** ERC-20 Transfer events in a receipt: [{ token, from, to, value (BigInt), logIndex }] */
export function decodeTransfers(receipt) {
  return (receipt?.logs ?? [])
    .filter((l) => l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics.length === 3)
    .map((l) => ({ token: l.address, from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), value: BigInt(l.data), logIndex: Number(BigInt(l.logIndex)) }));
}
export const tokenSymbol = (addr) => (addr?.toLowerCase() === TOKENS.USDT.address.toLowerCase() ? "USD₮" : addr?.toLowerCase() === TOKENS.cNGN.address.toLowerCase() ? "cNGN" : "token");
export const units6 = (v) => Number(v) / 1e6;

// ---------- payment requests (pay.html#r=...) ----------
// Created by the CLI (`node src/agent.mjs request ...`); the same format is parsed here.
// { v:1, id:"r_xxxxxxxx", name, amount:"5.03", dir:"usdt-cngn"|"cngn-usdt", created: ms, exp: ms, note? }
const b64url = {
  enc: (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
};
export function encodeRequest(req) { return b64url.enc(JSON.stringify(req)); }
export function parseRequest(token) {
  let r;
  try { r = JSON.parse(b64url.dec(String(token))); } catch { throw new Error("This payment link is damaged. Ask for a new one."); }
  const ok = r && r.v === 1 && /^r_[a-z0-9]{6,16}$/.test(r.id) && typeof r.name === "string" && r.name.length > 0 && r.name.length <= 40
    && /^\d+(\.\d{1,6})?$/.test(r.amount) && CORRIDORS[r.dir] && Number.isFinite(r.created) && Number.isFinite(r.exp)
    && (r.note == null || (typeof r.note === "string" && r.note.length <= 80));
  if (!ok) throw new Error("This payment link isn't valid. Ask for a new one.");
  return r;
}

/** { rate, fromPreview, fetchedAt, ageMin, stale, previewUsd, ticker } — throws if no rate. */
export async function loadRate() {
  const d = await getJson("rate.json", { cache: "no-store" });
  const fromPreview = Number(d.effectiveRate) > 0;
  const rate = fromPreview ? Number(d.effectiveRate) : Number(d.ticker?.bid);
  if (!(rate > 0)) throw new Error("no rate");
  const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(d.fetchedAt)) / 60000));
  // reverseRate = USD₮ received per 1 NGN (cNGN -> USD₮ preview, fee included); null if not published yet
  const reverseRate = Number(d.reverseRate) > 0 ? Number(d.reverseRate) : null;
  return { rate, fromPreview, fetchedAt: d.fetchedAt, ageMin, stale: !!d.stale || ageMin > 120, previewUsd: d.previewUsd ?? 10, ticker: d.ticker ?? null, reverseRate, reversePreviewNgn: d.reversePreviewNgn ?? null };
}

/** { ok, owner, file, uri } — owner check + decoded ERC-8004 registration file. */
export async function loadIdentity() {
  const id = pad(AGENT_ID.toString(16));
  const owner = "0x" + (await call(REGISTRY, "0x6352211e" + id)).slice(-40);
  const uri = decodeString(await call(REGISTRY, "0xc87b56dd" + id));
  let file = null;
  if (uri.startsWith("data:application/json;base64,")) {
    const bin = atob(uri.slice(uri.indexOf(",") + 1));
    file = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  }
  return { ok: owner.toLowerCase() === AGENT.toLowerCase(), owner, file, uri };
}

/** { celo, usdt, cngn } as numbers. */
export async function loadBalances() {
  const bal = (t) => call(t, "0x70a08231" + pad(AGENT));
  const dec = async (t) => parseInt(await call(t, "0x313ce567"), 16);
  const [celo, usdt, cngn, dU, dN] = await Promise.all([
    rpc("eth_getBalance", [AGENT, "latest"]), bal(TOKENS.USDT.address), bal(TOKENS.cNGN.address), dec(TOKENS.USDT.address), dec(TOKENS.cNGN.address),
  ]);
  return { celo: units(celo, 18), usdt: units(usdt, dU), cngn: units(cngn, dN) };
}

/** One page of the agent's outgoing transactions: { items, next } (next = params for the following page or null). */
export async function loadTxPage(next = null) {
  const qs = new URLSearchParams({ filter: "from", ...(next ?? {}) });
  const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/transactions?${qs}`);
  if (!Array.isArray(d.items)) throw new Error("unexpected explorer response");
  const items = d.items.filter((t) => t.from?.hash?.toLowerCase() === AGENT.toLowerCase());
  return { items, next: d.next_page_params ?? null };
}

/** Any Celo transaction by hash, via RPC: { hash, from, to, input, status, blockNumber, timestamp } or null. */
export async function loadTxByHash(hash) {
  const [tx, receipt] = await Promise.all([rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash])]);
  if (!tx) return null;
  let timestamp = null;
  if (tx.blockNumber) {
    const block = await rpc("eth_getBlockByNumber", [tx.blockNumber, false]);
    timestamp = block ? Number(BigInt(block.timestamp)) * 1000 : null;
  }
  return { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, status: receipt ? (receipt.status === "0x1" ? "ok" : "error") : "pending", blockNumber: tx.blockNumber ? Number(BigInt(tx.blockNumber)) : null, timestamp };
}

// ---------- transaction meaning ----------
/** "identity" | "approve" | "convert" | "payout" | "other" */
export function txKind(tx) {
  const to = tx.to?.hash?.toLowerCase();
  if (to === REGISTRY.toLowerCase()) return "identity";
  if (to === TOKENS.cNGN.address.toLowerCase() && tx.method === "transfer") return "payout";
  if (to === TOKENS.USDT.address.toLowerCase() && tx.method === "approve") return "approve";
  if (tx.token_transfers || /execute/i.test(tx.method ?? "")) return "convert";
  return "other";
}
export function txLabel(tx) {
  switch (txKind(tx)) {
    case "identity": return tx.method === "register" ? "Registered identity" : tx.method === "setAgentURI" ? "Updated identity file" : "Updated identity";
    case "payout": return "Paid cNGN to recipient";
    case "approve": return /0{64}$/.test((tx.raw_input ?? "").slice(0, 138)) ? "Reset USD₮ allowance" : "Approved USD₮ for Textile";
    case "convert": return "Converted USD₮ → cNGN";
    default: return tx.method ? `Called ${tx.method}` : "Other transaction";
  }
}
export function txStatus(tx) {
  return tx.status === "ok" ? ["Success", "ok"] : tx.status === "error" ? ["Failed", "err"] : ["Pending", "warn"];
}

// ---------- DOM helpers ----------
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "dataset") Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}
export const badge = (text, kind = "neutral") => el("span", { class: `badge ${kind}` }, text);
export const icon = (name, cls = "i") => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};

let toastTimer;
export function toast(message) {
  let t = document.getElementById("toast");
  if (!t) { t = el("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" }); document.body.append(t); }
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}
export async function copyText(text, label = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast("Copy failed. Select and copy manually."); }
}
export function download(filename, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- page chrome: nav, sidebar, copy buttons ----------
const SB_KEY = "np-sidebar";
const store = {
  get() { try { return localStorage.getItem(SB_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(SB_KEY, v); } catch { /* storage blocked: state just isn't remembered */ } },
};
const desktop = () => matchMedia("(min-width: 1100px)").matches;

function initSidebar() {
  const root = document.documentElement;
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  const scrim = document.querySelector(".sb-scrim");
  const menuBtn = document.querySelector(".menu-btn");
  const collapseBtn = sidebar.querySelector(".sb-collapse");
  const closeBtn = sidebar.querySelector(".sb-close");

  // desktop rail / expanded (remembered)
  const setRail = (rail) => {
    root.dataset.sb = rail ? "rail" : "open";
    collapseBtn?.setAttribute("aria-expanded", String(!rail));
    collapseBtn?.setAttribute("aria-label", rail ? "Expand sidebar" : "Collapse sidebar");
    store.set(rail ? "rail" : "open");
  };
  root.dataset.sb = store.get() === "rail" ? "rail" : "open";
  collapseBtn?.setAttribute("aria-expanded", String(root.dataset.sb !== "rail"));
  collapseBtn?.setAttribute("aria-label", root.dataset.sb === "rail" ? "Expand sidebar" : "Collapse sidebar");
  collapseBtn?.addEventListener("click", () => setRail(root.dataset.sb !== "rail"));

  // mobile/tablet drawer
  let lastFocus = null;
  const openDrawer = () => {
    lastFocus = document.activeElement;
    root.dataset.drawer = "open";
    menuBtn?.setAttribute("aria-expanded", "true");
    sidebar.setAttribute("aria-modal", "true");
    sidebar.setAttribute("role", "dialog");
    requestAnimationFrame(() => sidebar.querySelector(".sb-nav a")?.focus());
  };
  const closeDrawer = () => {
    if (root.dataset.drawer !== "open") return;
    delete root.dataset.drawer;
    menuBtn?.setAttribute("aria-expanded", "false");
    sidebar.removeAttribute("aria-modal");
    sidebar.removeAttribute("role");
    lastFocus?.focus?.();
  };
  menuBtn?.addEventListener("click", () => (root.dataset.drawer === "open" ? closeDrawer() : openDrawer()));
  closeBtn?.addEventListener("click", closeDrawer);
  scrim?.addEventListener("click", closeDrawer);
  sidebar.addEventListener("click", (e) => { if (e.target.closest(".sb-nav a") && !desktop()) closeDrawer(); });
  addEventListener("resize", () => { if (desktop()) closeDrawer(); });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeDrawer();
    // "[" toggles the rail on desktop (ignored while typing)
    if (e.key === "[" && desktop() && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest("input, textarea, select, [contenteditable]")) {
      setRail(root.dataset.sb !== "rail");
    }
    // keep Tab inside the open drawer
    if (e.key === "Tab" && root.dataset.drawer === "open") {
      const f = [...sidebar.querySelectorAll("a[href], button:not([disabled])")].filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    }
  });

  // live status card
  const rateEl = document.getElementById("sb-rate");
  if (rateEl) loadRate().then((r) => { rateEl.textContent = `1 USD₮ = ${naira(r.rate)}`; }).catch(() => { rateEl.textContent = "Rate unavailable"; });

  // enable transitions only after the first paint, so the remembered state doesn't animate in
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("sb-ready")));
}

export function initChrome() {
  const here = location.pathname.split("/").pop() || "index.html";
  for (const a of document.querySelectorAll(".nav-links a, .sb-nav a")) {
    if (a.getAttribute("href") === here) a.setAttribute("aria-current", "page");
  }
  initSidebar();
  // any element with data-copy="text" copies that text on click
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (b) copyText(b.dataset.copy, b.dataset.copyLabel ?? "Copied");
  });
  const y = document.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());
}
