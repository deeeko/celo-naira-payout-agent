import {
  AGENT, CAP, TOKENS, CORRIDORS, EXPLORER_API, $, $$, el, icon, badge, naira, usd, num2, short,
  lagosTime, lagosClock, celoscanTx, celoscanAddr, getJson, loadRate, parseRequest, initChrome,
  loadTxByHash, decodeRegistration, registrationError, loadRegistrations, registrationStatuses, receiptNo,
} from "../assets/core.js";

initChrome();

const CELO_CHAIN_ID = 42220;
const POLL_MS = 10_000;
const NAME_RE = /^[^"`$\\]{1,40}$/; // any contacts.json key the CLI accepts, safe inside double quotes
const MAX_HOURS = 168; // src/requests.mjs MAX_HOURS
const MAX_USDT_BASE = 24.99; // the agent adds 0.01-0.99 and keeps the total <= CAP

const setText = (node, text) => node.replaceChildren(text);
const sameAddr = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const tokenOf = (key) => TOKENS[key]; // "USDT" | "cNGN"

/** "5.03" -> 5030000n (both tokens use 6 decimals on Celo). parseRequest already checked the format. */
function toUnits(amount) {
  const [i, f = ""] = String(amount).split(".");
  return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}
/** The exact amount with thousands separators and every decimal kept (never rounded). */
function exactAmount(amount) {
  const [i, f] = String(amount).split(".");
  return BigInt(i).toLocaleString("en-NG") + (f ? "." + f : "");
}
function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `in ${d} d ${h} h`;
  if (h > 0) return `in ${h} h ${m} min`;
  if (m > 0) return `in ${m} min ${sec} s`;
  return `in ${sec} s`;
}

// ---------- routing ----------
const hashParams = new URLSearchParams(location.hash.slice(1));
const token = hashParams.get("r");
const regHash = hashParams.get("tx");
addEventListener("hashchange", () => location.reload());

if (!location.hash.slice(1)) {
  initBuilder();
} else if (regHash !== null) {
  initRegistration(regHash.trim());
} else {
  let req = null;
  try {
    if (!token) throw new Error("This link is missing its payment details. Ask for a new one.");
    req = parseRequest(token);
  } catch (e) {
    showError(e.message);
  }
  if (req) initLink(req);
}

/**
 * The error view. opts: { title, lead, retry (bool), help: [children] , foot: [text, href, label] }
 */
function showError(message, opts = {}) {
  $("#view-explainer").hidden = true;
  $("#view-loading").hidden = true;
  $("#view-link").hidden = true;
  $("#view-error").hidden = false;
  setText($("#err-msg"), message);
  if (opts.title) setText($("#err-title"), opts.title);
  if (opts.lead) setText($("#err-lead"), opts.lead);
  if (opts.help) $("#err-help").replaceChildren(...opts.help);
  if (opts.foot) {
    const [text, href, label] = opts.foot;
    setText($("#err-foot-text"), text);
    const a = $("#err-foot-link");
    a.href = href;
    a.replaceChildren(label, icon("right"));
  }
  if (opts.retry) {
    $("#err-retry-row").hidden = false;
    $("#err-retry").addEventListener("click", () => location.reload(), { once: true });
  }
  document.title = (opts.title ? opts.title.replace(/\.$/, "") : "Link can't be opened") + " · Naira Payout";
}

// =====================================================================
// #tx=<hash>: a request the recipient registered onchain from their own wallet
// =====================================================================
async function initRegistration(hash) {
  const txHelp = [
    "Links can break when a chat app cuts them short. Copy the whole link, including everything after ",
    el("code", { class: "inline" }, "#tx="), ", and open it again.",
  ];
  const getPaidFoot = ["Want to be paid to your own wallet?", "get-paid.html", "Create a link"];
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    showError("The transaction id in this link is incomplete or has extra characters.", { help: txHelp, foot: getPaidFoot });
    return;
  }

  $("#view-explainer").hidden = true;
  $("#view-loading").hidden = false;

  let tx;
  try {
    tx = await loadTxByHash(hash);
  } catch {
    showError("Couldn't reach the Celo network to read this link.", {
      title: "Couldn't load this link",
      lead: "This is usually a brief network problem. Don't send any money until the link loads.",
      retry: true,
      help: ["You can also look the transaction up on ", el("a", { class: "link", href: celoscanTx(hash) }, "Celoscan"), "."],
    });
    return;
  }
  const notALink = { title: "This isn't a payment link", lead: "Don't send any money for it. Ask the person who shared it for a new link.", foot: getPaidFoot };
  const onCeloscan = ["See the transaction on ", el("a", { class: "link", href: celoscanTx(hash) }, "Celoscan"), "."];

  if (!tx) {
    showError("No transaction with this id exists on Celo.", { help: txHelp, foot: getPaidFoot });
    return;
  }
  if (tx.status === "pending") {
    showError("This link was just created and its transaction hasn't confirmed yet.", {
      title: "Almost ready",
      lead: "Celo confirms a transaction in a few seconds. Try again shortly, and don't send money until the link loads.",
      retry: true, help: onCeloscan,
    });
    return;
  }
  const req = tx.to && sameAddr(tx.to, AGENT) ? decodeRegistration(tx.input) : null;
  if (!req) {
    // One of the agent's own transactions: it isn't a link, but it does have a receipt.
    const ownTx = tx.from && sameAddr(tx.from, AGENT);
    const help = ownTx
      ? ["This is one of the agent's own transactions. ", el("a", { class: "link", href: `receipt.html#${receiptNo(hash)}` }, `Open its receipt ${receiptNo(hash)}`), "."]
      : onCeloscan;
    showError("This transaction exists on Celo, but it isn't a payment request sent to the agent.", { ...notALink, help });
    return;
  }
  if (tx.status !== "ok") {
    showError("The transaction behind this link failed, so it never registered a payment request.", { ...notALink, help: onCeloscan });
    return;
  }
  const blockSec = Math.floor(tx.timestamp / 1000);
  const why = registrationError(req, blockSec);
  if (why) {
    showError(`This payment request breaks the rules the agent checks (${why}), so the agent will never pay it.`, { ...notALink, help: onCeloscan });
    return;
  }

  $("#view-loading").hidden = true;
  initLink({
    id: tx.hash.toLowerCase(), name: req.n.trim(), amount: req.a, dir: req.d, created: blockSec * 1000, exp: req.e * 1000,
    note: req.m || null, recipient: tx.from, regBlock: tx.blockNumber,
  });
}

// =====================================================================
// Payment link view
// =====================================================================
function initLink(req) {
  $("#view-explainer").hidden = true;
  $("#view-link").hidden = false;

  const corridor = CORRIDORS[req.dir];
  const sell = tokenOf(corridor.sell), buy = tokenOf(corridor.buy);
  const units = toUnits(req.amount);
  const uri = `ethereum:${sell.address}@${CELO_CHAIN_ID}/transfer?address=${AGENT}&uint256=${units}`;
  const inNaira = req.dir === "usdt-cngn";
  const sendText = `${exactAmount(req.amount)} ${sell.symbol}`;
  const isReg = !!req.recipient; // #tx= link: the recipient registered it from their own wallet

  document.title = `Pay ${req.name} · Naira Payout`;
  setText($("#l-name"), req.name);
  const to = isReg ? `${req.name}'s wallet` : req.name;
  setText($("#l-lead"), inNaira
    ? `Send USD₮ on Celo. The agent converts it on Textile FX and pays ${to} in naira (cNGN).`
    : `Send cNGN on Celo. The agent converts it on Textile FX and pays ${to} in dollars (USD₮).`);

  if (isReg) {
    $("#l-who").hidden = false;
    setText($("#w-name"), req.name);
    const w = $("#w-wallet");
    w.href = celoscanAddr(req.recipient);
    setText(w, short(req.recipient));
    w.title = req.recipient;
    $("#w-wallet-copy").dataset.copy = req.recipient;
    setText($("#w-time"), `${lagosTime(req.created)} WAT`);
    $("#w-reg").href = celoscanTx(req.id);
    setText($("#l-id-label"), "Registration");
    $("#l-id").replaceChildren(el("a", { class: "link", href: celoscanTx(req.id), title: req.id }, short(req.id)));
    $("#l-safe-who").replaceChildren("The agent pays only ", el("b", { class: "mono" }, short(req.recipient)),
      ", the wallet that registered this link, up to ", el("b", {}, `$${CAP} per payout`), ". Don't pay from that same wallet: the agent won't pay it.");
  }
  const regNote = el("div", { "aria-live": "polite" });
  $("#l-notice").append(regNote);

  // amount + where to send
  $("#l-amount").value = exactAmount(req.amount);
  setText($("#l-token"), sell.symbol);
  $("#l-amount-copy").dataset.copy = req.amount;
  setText($("#l-receive-label"), `${req.name} gets (approx.)`);
  const agentLink = $("#l-agent");
  agentLink.href = celoscanAddr(AGENT);
  setText(agentLink, short(AGENT));
  agentLink.title = AGENT;
  $("#l-agent-copy").dataset.copy = AGENT;
  setText($("#l-agent-short"), short(AGENT));
  setText($("#l-token-name"), sell.symbol);
  const tokenLink = $("#l-token-addr");
  tokenLink.href = celoscanAddr(sell.address);
  setText(tokenLink, short(sell.address));
  tokenLink.title = sell.address;
  setText($("#l-exp-time"), ` · ${lagosTime(req.exp)} WAT`);
  if (!isReg) setText($("#l-id"), req.id);
  if (req.note) { $("#l-note-row").hidden = false; setText($("#l-note"), req.note); }

  // pay options
  $("#l-open").href = uri;
  $("#l-uri-copy").dataset.copy = uri;
  $("#l-manual-copy").dataset.copy = AGENT;
  setText($("#l-manual-addr"), AGENT);
  $("#l-manual-text").replaceChildren("Send exactly ", el("b", { class: "num" }, sendText), " on the Celo network to the agent's address below. Use the ",
    el("a", { class: "link", href: celoscanAddr(sell.address) }, `${sell.symbol} token on Celo`), ", not one on another network.");
  renderQr(uri);

  // live rate -> approximate amount received
  loadRate().then((r) => {
    let usdValue = null;
    if (inNaira) {
      usdValue = Number(req.amount);
      setText($("#l-receive"), naira(Number(req.amount) * r.rate));
      setText($("#l-rate"), `1 USD₮ = ${naira(r.rate)}`);
    } else if (r.reverseRate) {
      usdValue = Number(req.amount) * r.reverseRate;
      setText($("#l-receive"), `${num2.format(usdValue)} USD₮`);
      setText($("#l-rate"), `1 USD₮ = ${naira(1 / r.reverseRate)}`);
    } else {
      setText($("#l-receive"), "—");
      setText($("#l-rate"), "Not published yet");
    }
    if (usdValue !== null && usdValue > CAP) {
      $("#l-notice").append(el("div", { class: "alert warn mt-16" }, icon("alert"),
        el("span", {}, `This is over the agent's $${CAP} per-payout limit, so autopilot won't pay it out. Ask for a smaller request before sending.`)));
    }
  }).catch(() => {
    setText($("#l-receive"), "—");
    setText($("#l-rate"), "Unavailable");
    $("#l-notice").append(el("div", { class: "alert mt-16" }, icon("info"),
      el("span", {}, "Couldn't load the exchange rate, so the amount received isn't shown. The agent takes a fresh firm quote when it pays.")));
  });

  // state: the deposit and payout found on chain, if any
  // regs: every registration sent to the agent (#tx= links only), to apply the same-amount rule
  const state = { deposit: null, payout: null, error: false, checkedAt: null, regs: null };
  let timer = null, busy = false;
  const expired = () => Date.now() >= req.exp;
  const regStatusAt = (sec) => registrationStatuses(state.regs, sec).get(req.id);
  /** null while unknown; "active" for #r= links. "in-use" = an earlier link took this amount. */
  const regNow = () => (!isReg ? "active" : state.regs ? regStatusAt(Math.floor(Date.now() / 1000)) : null);
  const selfPaid = () => isReg && state.deposit && sameAddr(state.deposit.from, req.recipient);

  function renderRegNote() {
    if (!isReg || state.deposit || expired()) return regNote.replaceChildren();
    const s = regNow();
    if (s === null) {
      regNote.replaceChildren(state.error ? "" : el("p", { class: "small muted mt-16" }, "Checking that no earlier link uses this amount…"));
    } else if (s === "in-use") {
      regNote.replaceChildren(el("div", { class: "alert err mt-16" }, icon("alert"),
        el("span", {}, `Don't send money to this link. An earlier link already asks for exactly ${sendText}, so a payment of this amount would be matched to that link, not to ${req.name}. ${req.name} should `,
          el("a", { class: "link", href: "get-paid.html" }, "create a new link"), " with a slightly different amount.")));
    } else regNote.replaceChildren();
  }

  function render() {
    renderRegNote();
    const inUse = regNow() === "in-use";
    // pay options stay visible only while the link is open, unpaid and (for #tx= links) not taken by an earlier link
    const canPay = !expired() && !state.deposit && regNow() === "active";
    $("#l-actions").hidden = !canPay;
    $("#l-manual").hidden = !canPay;
    $("#l-qr-card").hidden = !canPay;
    $("#l-amount-hint").hidden = !canPay;

    const expBadge = $("#l-exp-badge");
    if (state.deposit || inUse) expBadge.replaceChildren();
    else if (expired()) expBadge.replaceChildren(badge("Expired", "err"));
    else expBadge.replaceChildren(badge("Open", "neutral"));

    // header badge
    let b;
    if (state.payout) b = badge("", "ok"), b.append(el("span", { class: "dot" }), "Paid out");
    else if (selfPaid()) b = badge("Won't be paid out", "err");
    else if (state.deposit) b = badge("", "ok"), b.append(el("span", { class: "dot" }), "Payment received");
    else if (expired()) b = badge("Expired", "err");
    else if (inUse) b = badge("Amount in use", "err");
    else if (state.error && !state.checkedAt) b = badge("Couldn't check", "warn");
    else if (!state.checkedAt) b = null;
    else b = badge("", "warn"), b.append(el("span", { class: "dot" }), "Waiting for payment");
    if (b) $("#l-status-badge").replaceChildren(b);

    // deposit row
    const dep = $("#l-st-deposit");
    if (state.deposit) {
      dep.replaceChildren(el("span", { class: "row", style: "justify-content:flex-end;gap:8px" },
        el("span", {}, "From ", el("span", { class: "mono" }, short(state.deposit.from))),
        el("a", { class: "link", href: celoscanTx(state.deposit.hash) }, "View transaction ", icon("ext"))));
    } else if (inUse && state.checkedAt) {
      setText(dep, "—");
    } else if (state.checkedAt) {
      setText(dep, expired() ? "None before expiry" : "Not received yet");
    } else if (state.error) setText(dep, "—");

    // payout row
    setText($("#l-st-payout-label"), `Payout to ${req.name}`);
    const pay = $("#l-st-payout");
    if (state.payout) {
      const href = isReg ? `receipt.html#p=${state.payout.hash}` : `receipt.html#p=${state.payout.hash}&r=${req.id}`;
      pay.replaceChildren(el("a", { class: "link", href, title: receiptNo(state.payout.hash) }, "View receipt ", icon("right")));
    } else if (selfPaid()) {
      setText(pay, "Not paid");
    } else if (state.deposit) {
      setText(pay, "In progress");
    } else if (state.checkedAt || state.error) {
      setText(pay, expired() || inUse ? "—" : "After payment");
    }

    setText($("#l-st-checked"), state.checkedAt ? `${lagosClock(state.checkedAt)} WAT` : state.error ? "—" : "");
    if (!state.checkedAt && !state.error) $("#l-st-checked").replaceChildren(el("span", { class: "skel" }));

    // explanatory message under the status
    const msg = $("#l-st-msg");
    if (state.error) {
      msg.replaceChildren(el("div", { class: "alert warn mt-16" }, icon("alert"),
        el("span", {}, "Couldn't reach the Celo explorer. Trying again in 10 s. You can also check the ",
          el("a", { class: "link", href: celoscanAddr(AGENT) }, "agent on Celoscan"), ".")));
    } else if (state.payout) {
      msg.replaceChildren(el("p", { class: "small muted mt-16" }, isReg
        ? `${req.name} has been paid to ${short(req.recipient)}, the wallet that registered this link. The receipt rebuilds the payout from the chain.`
        : `${req.name} has been paid. The receipt rebuilds the payout from the chain.`));
    } else if (selfPaid()) {
      msg.replaceChildren(el("div", { class: "alert err mt-16" }, icon("alert"),
        el("span", {}, `This payment came from ${short(req.recipient)}, the same wallet the link pays. The agent doesn't pay a link from its own recipient, so it won't be paid out. `,
          el("a", { class: "link", href: "verify.html" }, "Look up a transaction"), " for details.")));
    } else if (state.deposit) {
      msg.replaceChildren(el("div", { class: "alert mt-16" }, icon("check"),
        el("span", {}, "Payment received. Don't send it again. Autopilot converts it and pays out on its next pass, usually within a few minutes while it is running.")));
    } else if (expired()) {
      msg.replaceChildren(el("div", { class: "alert err mt-16" }, icon("alert"),
        el("span", {}, `This link expired on ${lagosTime(req.exp)} WAT. Don't send money to it: the agent no longer matches deposits for it. Ask for a new link.`)));
    } else if (inUse) {
      msg.replaceChildren(el("p", { class: "small muted mt-16" }, "Nothing to track: this link can't be paid while an earlier link uses the same amount."));
    } else if (state.checkedAt) {
      msg.replaceChildren(el("p", { class: "small muted mt-16" }, "Checks the chain every 10 seconds while this tab is open. A payment shows here a few seconds after it confirms."));
    } else msg.replaceChildren();
  }

  function tickCountdown() {
    const left = req.exp - Date.now();
    setText($("#l-countdown"), left > 0 ? countdown(left) : "Expired");
    if (left <= 0 && !$("#l-actions").hidden) render();
  }

  async function check() {
    if (busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      if (isReg && !state.regs) {
        const regs = (await loadRegistrations(20)).map((r) => ({ ...r, hash: String(r.hash).toLowerCase() }));
        // the explorer can lag a few seconds behind the RPC; without our own entry the rule can't be applied
        if (!regs.some((r) => r.hash === req.id)) throw new Error("registration not indexed yet");
        state.regs = regs;
      }
      if (regNow() !== "in-use" && !state.deposit) {
        // for #tx= links, a deposit counts only if this link was the active one for that amount when it arrived
        const accept = isReg ? (t) => regStatusAt(Math.floor(t.ts / 1000)) === "active" : () => true;
        state.deposit = await findDeposit(sell.address, units, req.created, req.exp, accept);
      }
      if (state.deposit && !state.payout && !selfPaid()) state.payout = await findPayout(buy.address, state.deposit, isReg ? req.recipient : null);
      state.error = false;
      state.checkedAt = Date.now();
    } catch {
      state.error = true;
    } finally {
      busy = false;
    }
    render();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (state.payout || selfPaid()) return; // done
    if (expired() && !state.deposit && state.checkedAt) return; // nothing more can happen
    timer = setTimeout(check, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !state.payout) { clearTimeout(timer); check(); }
  });

  render();
  tickCountdown();
  setInterval(tickCountdown, 1000);
  check();
}

/** Walk the agent's ERC-20 transfers (newest first) in one direction since a time, for one token or (null) all. */
async function* transfers(filter, tokenAddr, sinceMs) {
  let next = null;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ type: "ERC-20", filter, ...(tokenAddr ? { token: tokenAddr } : {}), ...(next ?? {}) });
    const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/token-transfers?${qs}`);
    if (!Array.isArray(d.items)) throw new Error("unexpected explorer response");
    for (const it of d.items) {
      const ts = Date.parse(it.timestamp);
      if (ts < sinceMs) return;
      yield { ...it, ts };
    }
    next = d.next_page_params;
    if (!next) return;
  }
}
/** The earliest transfer to the agent of exactly `units` of the sell token between created and exp that `accept` allows. */
async function findDeposit(tokenAddr, units, created, exp, accept = () => true) {
  const since = Math.floor(created / 1000) * 1000; // block times are whole seconds
  let found = null;
  for await (const t of transfers("to", tokenAddr, since)) {
    // a deposit exactly at expiry is unmatched, as in the CLI
    if (t.ts >= exp || !sameAddr(t.to?.hash, AGENT) || sameAddr(t.from?.hash, AGENT)) continue;
    if (!sameAddr(t.token?.address_hash ?? t.token?.address, tokenAddr)) continue;
    if (String(t.total?.value) !== units.toString()) continue;
    if (!accept(t)) continue;
    found = t; // newest first, so the last match is the earliest
  }
  return found && { hash: found.transaction_hash, from: found.from?.hash, ts: found.ts, block: found.block_number };
}

/**
 * The agent's first plain outgoing transfer of the buy token in a block after the deposit.
 * Transactions that also move tokens INTO the agent are swap legs, not payouts, so they are skipped.
 * With `recipient` (#tx= links) only a transfer TO that wallet counts.
 */
async function findPayout(tokenAddr, deposit, recipient = null) {
  const incoming = new Set();
  for await (const t of transfers("to", null, deposit.ts)) {
    if (sameAddr(t.to?.hash, AGENT) && t.transaction_hash) incoming.add(String(t.transaction_hash).toLowerCase());
  }
  let found = null;
  for await (const t of transfers("from", tokenAddr, deposit.ts)) {
    if (!sameAddr(t.from?.hash, AGENT) || sameAddr(t.to?.hash, AGENT)) continue;
    if (t.method !== "transfer") continue;
    if (!(Number(t.block_number) > Number(deposit.block))) continue;
    if (incoming.has(String(t.transaction_hash ?? "").toLowerCase())) continue;
    if (!sameAddr(t.token?.address_hash ?? t.token?.address, tokenAddr)) continue;
    if (recipient && !sameAddr(t.to?.hash, recipient)) continue;
    found = t; // newest first, so the last match is the earliest
  }
  return found && { hash: found.transaction_hash, to: found.to?.hash, ts: found.ts };
}

/** Draw the QR code as DOM SVG (no innerHTML, no data: URLs, so it works under the page's CSP). */
function renderQr(text) {
  const box = $("#l-qr");
  const lib = globalThis.qrcode;
  if (typeof lib !== "function") {
    box.replaceChildren(el("p", { class: "small muted" }, "The QR code couldn't be drawn. Use \"Open in wallet\" or send it by hand."));
    return;
  }
  const qr = lib(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), quiet = 4, size = n + quiet * 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code of the wallet payment link");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", size); bg.setAttribute("height", size); bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d); path.setAttribute("fill", "#07120c");
  svg.append(bg, path);
  box.replaceChildren(svg);
}

// =====================================================================
// Explainer: command builder
// =====================================================================
function initBuilder() {
  const nameIn = $("#b-name"), amountIn = $("#b-amount"), noteIn = $("#b-note"), hoursIn = $("#b-hours");
  const corridorBtns = $$("#corridor button");
  const reqPre = $("#req-cmd"), reqCopy = $("#req-copy");
  let corridor = "usdt-cngn";
  let rate = null;

  const hint = (id, text, isErr) => { const h = $(id); h.classList.toggle("err", !!isErr); setText(h, text); };

  function readName() {
    const name = nameIn.value.trim();
    const ok = NAME_RE.test(name);
    nameIn.setAttribute("aria-invalid", String(!ok));
    hint("#b-name-hint", ok ? "The name as it appears in your contacts.json."
      : name ? "Leave out quotes, backticks, $ and backslashes. Up to 40 characters." : "Enter the recipient's contact name.", !ok);
    return ok ? name : null;
  }

  function readAmount() {
    const raw = amountIn.value.trim().replace(/[$₦,\s]/g, "");
    const inNgn = corridor === "cngn-usdt";
    let n = null, msg, err = true;
    if (!raw) msg = inNgn ? "Enter an amount in naira." : "Enter an amount in dollars.";
    else if (/\.\d{3,}$/.test(raw)) msg = "Use at most 2 decimal places.";
    else if (!/^\d*\.?\d+$|^\d+\.$/.test(raw) || !(Number(raw) > 0)) msg = inNgn ? "Enter an amount in naira, like 7200." : "Enter an amount in dollars, like 5 or 12.50.";
    else {
      n = Number(raw);
      const usdValue = inNgn ? (rate?.reverseRate ? n * rate.reverseRate : null) : n;
      if (!inNgn && n > MAX_USDT_BASE) {
        msg = `Leave room for the cents the agent adds: at most $${MAX_USDT_BASE}.`;
        n = null;
      } else if (usdValue !== null && usdValue > CAP) {
        msg = inNgn ? `About ${usd(usdValue)}, over the $${CAP} per-payout limit. Autopilot would refuse it.` : `Over the $${CAP} per-payout limit. Autopilot would refuse it.`;
        n = null;
      } else {
        err = false;
        const approx = inNgn
          ? (usdValue !== null ? `Contact gets about ${num2.format(usdValue)} USD₮. ` : "")
          : (rate ? `Contact gets about ${naira(n * rate.rate)}. ` : "");
        msg = `${approx}The agent adds 0.01 to 0.99 so the amount is unique.`;
      }
    }
    amountIn.setAttribute("aria-invalid", String(err));
    hint("#b-amount-hint", msg, err);
    return n === null ? null : String(Math.round(n * 100) / 100);
  }

  function readNote() {
    const note = noteIn.value.trim();
    const bad = /["`$\\]/.test(note);
    noteIn.setAttribute("aria-invalid", String(bad));
    hint("#b-note-hint", bad ? "Leave out quotes, backticks, $ and backslashes so the command runs as typed." : "Shown on the link. Up to 80 characters.", bad);
    return bad ? null : note;
  }

  function readHours() {
    const raw = hoursIn.value.trim();
    const h = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
    const ok = h >= 1 && h <= MAX_HOURS;
    hoursIn.setAttribute("aria-invalid", String(!ok));
    hint("#b-hours-hint", ok ? `1 to ${MAX_HOURS} hours. The default is 48.` : `Enter whole hours from 1 to ${MAX_HOURS}.`, !ok);
    return ok ? h : null;
  }

  function render() {
    for (const b of corridorBtns) b.setAttribute("aria-pressed", String(b.dataset.corridor === corridor));
    const c = CORRIDORS[corridor];
    setText($("#b-token"), tokenOf(c.sell).symbol);
    setText($("#corridor-hint"), corridor === "usdt-cngn"
      ? "The payer sends USD₮. The contact receives cNGN (naira)."
      : "The payer sends cNGN. The contact receives USD₮ (dollars).");

    const name = readName(), amount = readAmount(), note = readNote(), hours = readHours();
    if (name === null || amount === null || note === null || hours === null) {
      setText(reqPre, "Fix the fields above to build the command.");
      reqCopy.disabled = true;
      reqCopy.removeAttribute("data-copy");
      return;
    }
    let cmd = `node src/agent.mjs request --to "${name}" --amount ${amount}`;
    if (corridor !== "usdt-cngn") cmd += ` --corridor ${corridor}`;
    if (note) cmd += ` --note "${note}"`;
    if (hours !== 48) cmd += ` --hours ${hours}`;
    setText(reqPre, cmd);
    reqCopy.disabled = false;
    reqCopy.dataset.copy = cmd;
  }

  for (const b of corridorBtns) {
    b.addEventListener("click", () => {
      if (corridor === b.dataset.corridor) return;
      corridor = b.dataset.corridor;
      amountIn.value = corridor === "cngn-usdt" ? "7200" : "5";
      render();
    });
  }
  for (const i of [nameIn, amountIn, noteIn, hoursIn]) i.addEventListener("input", render);

  render();
  loadRate().then((r) => { rate = r; render(); }).catch(() => { /* the estimate is optional; the command still builds */ });
}
