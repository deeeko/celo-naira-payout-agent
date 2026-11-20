import { CAP, CORRIDORS, $, $$, el, icon, badge, naira, usd, loadRate, initChrome } from "../assets/core.js";

initChrome();

const amountIn = $("#amount");
const hint = $("#amount-hint");
const out = $("#receive");
const presetBox = $("#presets");
const corridorBtns = $$("#corridor button");
const recipientIn = $("#recipient");
const recipientHint = $("#recipient-hint");
const modeBtns = $$("#mode button");
const cmdPre = $("#cmd");
const askPre = $("#ask");
const reqPre = $("#req");
const cmdCopy = $("#cmd-copy");
const askCopy = $("#ask-copy");
const reqCopy = $("#req-copy");
const reqHint = $("#req-hint");
/** request (usdt-cngn) adds a 0.01–0.99 suffix and must stay within the cap, so the base can be at most CAP - 0.01. */
const REQ_MAX = CAP - 0.01;

const NAME_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
const RECIPIENT_HINT = "The name as it appears in your contacts.json.";
const nairaWhole = new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 });

/** What changes between the two corridors (ids match core.js CORRIDORS). */
const VIEW = {
  "usdt-cngn": {
    sendToken: "USD₮", getToken: "cNGN", presets: [5, 10, 20, 25], start: 10,
    presetLabel: (v) => `$${v}`,
    corridorHint: "You send USD₮. The recipient gets cNGN (naira).",
    receiveLabel: "Recipient gets (approx.)",
    route: "USD₮ → cNGN on Textile FX",
    delivered: "cNGN on Celo, redeemable for naira",
    emptyHint: "Enter an amount in dollars.",
    badHint: "Enter an amount in dollars, like 10 or 12.50.",
  },
  "cngn-usdt": {
    sendToken: "cNGN", getToken: "USD₮", presets: [5000, 10000, 20000, 35000], start: 10000,
    presetLabel: (v) => `₦${v / 1000}k`,
    presetAria: (v) => `₦${nairaWhole.format(v)}`,
    corridorHint: "You send cNGN (naira). The recipient gets USD₮ (dollars).",
    receiveLabel: "Recipient gets in USD₮ (approx.)",
    route: "cNGN → USD₮ on Textile FX",
    delivered: "USD₮ on Celo, a dollar stablecoin",
    emptyHint: "Enter an amount in naira.",
    badHint: "Enter an amount in naira, like 10000 or 12500.50.",
  },
};

let quote = null; // result of loadRate(), or null while loading / on failure
let rateFailed = false;
let mode = "dry";
let corridor = "usdt-cngn";

const isReverse = () => corridor === "cngn-usdt";
/** USD₮ received per 1 NGN, or null when rate.json doesn't carry it yet. */
const reverseRate = () => quote?.reverseRate ?? null;

const rawAmount = () => amountIn.value.trim().replace(/[$₦,\s]/g, "");
/** True when the amount has more than 2 decimal places (the CLI amount and the estimate would differ). */
const tooPrecise = () => /\.\d{3,}$/.test(rawAmount());

/** Parse the amount field. Returns a positive number with at most 2 decimals, or null. */
function readAmount() {
  const raw = rawAmount();
  if (!/^\d*\.?\d+$|^\d+\.$/.test(raw) || tooPrecise()) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Amount as it would be typed on the command line: up to 2 decimals, no trailing zeros. */
const cliAmount = (n) => String(Math.round(n * 100) / 100);

/** USD value used for the cap: dollars sold (naira mode) or USD₮ bought (dollars mode). null if unknown. */
function usdValue(n) {
  if (n === null) return null;
  if (!isReverse()) return n;
  const rr = reverseRate();
  return rr ? n * rr : null;
}

function setText(node, ...children) { node.replaceChildren(...children); }

// ---------- corridor ----------
function renderPresets() {
  const v = VIEW[corridor];
  presetBox.replaceChildren(...v.presets.map((p) =>
    el("button", { type: "button", dataset: { amount: String(p) }, "aria-pressed": "false", "aria-label": v.presetAria?.(p) }, v.presetLabel(p))));
}

function renderCorridor() {
  const v = VIEW[corridor];
  for (const b of corridorBtns) b.setAttribute("aria-pressed", String(b.dataset.corridor === corridor));
  setText($("#corridor-hint"), v.corridorHint);
  setText($("#amount-token"), v.sendToken);
  setText($("#receive-label"), v.receiveLabel);
  setText($("#kv-route"), v.route);
  setText($("#kv-delivered"), v.delivered);
  setText($("#check-token"), v.sendToken);
  setText($("#check-cap"), isReverse()
    ? el("span", {}, "The amount is worth ", el("b", {}, `$${CAP} or less`), " in USD₮.")
    : el("span", {}, "The amount is ", el("b", {}, `$${CAP} or less`), "."));
  // plain-language commands take dollar amounts only (.field sets display, so [hidden] alone isn't enough)
  const askField = $("#ask-field");
  askField.hidden = isReverse();
  askField.style.display = isReverse() ? "none" : "";
  renderPresets();
}

// ---------- amount + estimate ----------
function renderAmount() {
  const v = VIEW[corridor];
  const n = readAmount();
  for (const b of $$("button", presetBox)) b.setAttribute("aria-pressed", String(n !== null && Number(b.dataset.amount) === n));

  const usdv = usdValue(n);
  const over = usdv !== null && usdv > CAP;
  hint.classList.toggle("err", n === null || over);
  if (n === null && tooPrecise()) setText(hint, "Use at most 2 decimal places.");
  else if (n === null) setText(hint, amountIn.value.trim() ? v.badHint : v.emptyHint);
  else if (over && isReverse()) setText(hint, `Worth about ${usd(usdv)}, over the $${CAP} limit. The agent would refuse this payout.`);
  else if (over) setText(hint, `Over the $${CAP} limit. The agent would refuse this payout.`);
  else if (!isReverse()) setText(hint, `The agent pays up to $${CAP} per payout.`);
  else if (usdv !== null) setText(hint, `Worth about ${usd(usdv)}. The agent pays up to $${CAP} (about ${naira(CAP / reverseRate())}) per payout.`);
  else if (quote || rateFailed) setText(hint, `The agent pays up to $${CAP} per payout, checked against its firm quote before paying.`);
  else setText(hint, `Checking the $${CAP} limit once the rate loads.`);
  amountIn.setAttribute("aria-invalid", String(n === null || over));

  out.classList.toggle("over", over);
  if (!isReverse()) {
    if (quote) setText(out, n === null ? "—" : naira(n * quote.rate));
    else if (rateFailed) setText(out, "—");
  } else if (quote || rateFailed) {
    setText(out, n === null || usdv === null ? "—" : usd(usdv));
  }

  if (quote) {
    if (!isReverse()) setText($("#kv-fees"), quote.fromPreview ? `Included — Textile preview for $${cliAmount(quote.previewUsd)}` : "Not included — market bid");
    else setText($("#kv-fees"), reverseRate() ? `Included — Textile preview for ${naira(quote.reversePreviewNgn ?? 14400)}` : "—");
  }
  return n;
}

// ---------- commands ----------
function renderCommand() {
  const n = readAmount();
  const raw = recipientIn.value;
  const lower = raw.toLowerCase();
  if (lower !== raw) {
    const pos = recipientIn.selectionStart;
    recipientIn.value = lower;
    try { recipientIn.setSelectionRange(pos, pos); } catch { /* not focused */ }
  }
  const name = recipientIn.value.trim();
  const nameOk = NAME_RE.test(name);
  recipientHint.classList.toggle("err", !nameOk);
  recipientIn.setAttribute("aria-invalid", String(!nameOk));
  setText(recipientHint, nameOk ? RECIPIENT_HINT
    : name ? "Start with a letter. Letters, numbers, dot, dash and underscore only."
    : "Enter the recipient's contact name.");

  for (const b of modeBtns) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));

  const ready = nameOk && n !== null;
  if (!ready) {
    const msg = !nameOk ? "Fix the recipient name to build the command." : tooPrecise() ? "Fix the amount to build the command." : "Enter an amount to build the command.";
    for (const p of [cmdPre, askPre, reqPre]) setText(p, msg);
    for (const b of [cmdCopy, askCopy, reqCopy]) { b.disabled = true; b.removeAttribute("data-copy"); }
    reqHint.hidden = true;
    return;
  }
  const amt = cliAmount(n);
  const exec = mode === "real" ? " --execute" : "";
  const corr = isReverse() ? ` --corridor ${CORRIDORS["cngn-usdt"].id}` : "";
  const cmd = `node src/agent.mjs pay --to ${name} --amount ${amt}${corr}${exec}`;
  // Single quotes keep "$10" literal in bash, zsh and PowerShell (double quotes would expand $1).
  const ask = `node src/agent.mjs ask 'send $${amt} to ${name}'${exec}`;
  const req = `node src/agent.mjs request --to ${name} --amount ${amt}${corr}`;
  setText(cmdPre, cmd);
  setText(reqPre, req);
  cmdCopy.disabled = false; cmdCopy.dataset.copy = cmd;
  const reqTooBig = !isReverse() && n > REQ_MAX + 1e-9;
  reqHint.hidden = !reqTooBig;
  setText(reqHint, reqTooBig ? `Leave room for the cents the agent adds: at most $${REQ_MAX.toFixed(2)}.` : "");
  if (reqTooBig) { reqCopy.disabled = true; reqCopy.removeAttribute("data-copy"); }
  else { reqCopy.disabled = false; reqCopy.dataset.copy = req; }
  if (isReverse()) { setText(askPre, ""); askCopy.disabled = true; askCopy.removeAttribute("data-copy"); }
  else { setText(askPre, ask); askCopy.disabled = false; askCopy.dataset.copy = ask; }
}

// ---------- rate ----------
function renderRate() {
  const rr = reverseRate();
  if (!isReverse()) setText($("#kv-rate"), `1 USD₮ = ${naira(quote.rate)}`);
  else setText($("#kv-rate"), rr ? `1 USD₮ costs ${naira(1 / rr)}` : "Not published yet");
  setText($("#kv-cap"), isReverse() && rr ? `$${CAP} per payout (about ${naira(CAP / rr)})` : `$${CAP} per payout`);

  const ageText = quote.ageMin < 1 ? "Updated just now" : quote.ageMin < 120 ? `Updated ${quote.ageMin} min ago` : `Updated ${Math.round(quote.ageMin / 60)} h ago`;
  const fresh = badge("", quote.stale ? "warn" : "ok");
  fresh.append(el("span", { class: "dot" }), quote.stale ? `Stale · ${ageText.toLowerCase()}` : ageText);
  $("#kv-source").replaceChildren(
    el("span", { class: "row", style: "justify-content:flex-end;gap:8px" }, el("span", {}, "Textile FX, refreshed every 30 min"), fresh),
  );
  const t = quote.ticker;
  const bid = Number(t?.bid), ask = Number(t?.ask);
  setText($("#kv-market"), bid > 0 && ask > 0 ? `${naira(bid)} / ${naira(ask)}` : "—");

  const alerts = [];
  if (isReverse() && !rr) {
    alerts.push(el("div", { class: "alert warn mt-16" }, icon("alert"),
      el("span", {}, el("b", {}, "Reverse rate not published yet. "),
        "The naira-to-dollar price is added to the rate feed on its next refresh (every 30 min). For a live price now, run ",
        el("code", { class: "inline" }, "node src/agent.mjs quote --amount 10000 --corridor cngn-usdt"), ".")));
  }
  if (quote.stale) {
    alerts.push(el("div", { class: "alert warn mt-16" }, icon("alert"),
      el("span", {}, "This rate is older than usual, so the real quote may differ. The agent always takes a fresh firm quote before paying.")));
  }
  $("#rate-error").replaceChildren(...alerts);
}

function renderRateError() {
  for (const id of ["#kv-rate", "#kv-fees", "#kv-source", "#kv-market"]) setText($(id), "—");
  setText($("#kv-cap"), `$${CAP} per payout`);
  $("#rate-error").replaceChildren(el("div", { class: "alert err mt-16" }, icon("alert"),
    el("span", {}, "Couldn't load the exchange rate. Refresh the page to try again, or check live rates in the ",
      el("a", { class: "link", href: "https://fx-docs.textilecredit.com" }, "Textile FX docs"), ".")));
}

function renderAll() {
  if (quote) renderRate();
  renderAmount();
  renderCommand();
}

// ---------- events ----------
amountIn.addEventListener("input", () => { renderAmount(); renderCommand(); });
presetBox.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-amount]");
  if (!b) return;
  amountIn.value = b.dataset.amount;
  renderAmount(); renderCommand();
});
for (const b of corridorBtns) {
  b.addEventListener("click", () => {
    if (b.dataset.corridor === corridor || !CORRIDORS[b.dataset.corridor]) return;
    corridor = b.dataset.corridor;
    amountIn.value = String(VIEW[corridor].start); // amounts mean a different currency now
    renderCorridor();
    renderAll();
  });
}
recipientIn.addEventListener("input", renderCommand);
for (const b of modeBtns) {
  b.addEventListener("click", () => { mode = b.dataset.mode; renderCommand(); });
}

// quote.html#corridor=cngn-usdt opens in "Pay in dollars" (shareable from other pages and docs)
const hashCorridor = new URLSearchParams(location.hash.slice(1)).get("corridor");
if (hashCorridor === "cngn-usdt") { corridor = hashCorridor; amountIn.value = String(VIEW[corridor].start); }

renderCorridor();
renderAmount();
renderCommand();

try {
  quote = await loadRate();
} catch {
  rateFailed = true;
  renderRateError();
}
renderAll();
