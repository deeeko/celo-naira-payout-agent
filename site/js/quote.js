import { CAP, $, $$, el, icon, badge, naira, loadRate, initChrome } from "../assets/core.js";

initChrome();

const amountIn = $("#amount");
const hint = $("#amount-hint");
const out = $("#receive");
const presets = $$("#presets button");
const recipientIn = $("#recipient");
const recipientHint = $("#recipient-hint");
const modeBtns = $$("#mode button");
const cmdPre = $("#cmd");
const askPre = $("#ask");
const cmdCopy = $("#cmd-copy");
const askCopy = $("#ask-copy");

const NAME_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
const DEFAULT_HINT = `The agent pays up to $${CAP} per payout.`;
const RECIPIENT_HINT = "The name as it appears in your contacts.json.";

let quote = null; // result of loadRate(), or null while loading / on failure
let rateFailed = false;
let mode = "dry";

const rawAmount = () => amountIn.value.trim().replace(/[$,\s]/g, "");
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

function setText(node, text) { node.replaceChildren(text); }

function renderAmount() {
  const n = readAmount();
  for (const b of presets) b.setAttribute("aria-pressed", String(n !== null && Number(b.dataset.amount) === n));

  const over = n !== null && n > CAP;
  hint.classList.toggle("err", n === null || over);
  if (n === null && tooPrecise()) setText(hint, "Use at most 2 decimal places.");
  else if (n === null) setText(hint, amountIn.value.trim() ? "Enter an amount in dollars, like 10 or 12.50." : "Enter an amount in dollars.");
  else if (over) setText(hint, `Over the $${CAP} limit. The agent would refuse this payout.`);
  else setText(hint, DEFAULT_HINT);
  amountIn.setAttribute("aria-invalid", String(n === null || over));

  out.classList.toggle("over", over);
  if (quote) setText(out, n === null ? "—" : naira(n * quote.rate));
  else if (rateFailed) setText(out, "—");

  if (quote) setText($("#kv-fees"), quote.fromPreview ? `Included — Textile preview for $${cliAmount(quote.previewUsd)}` : "Not included — market bid");
  return n;
}

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
    setText(cmdPre, msg);
    setText(askPre, msg);
    for (const b of [cmdCopy, askCopy]) { b.disabled = true; b.removeAttribute("data-copy"); }
    return;
  }
  const amt = cliAmount(n);
  const exec = mode === "real" ? " --execute" : "";
  const cmd = `node src/agent.mjs pay --to ${name} --amount ${amt}${exec}`;
  // Single quotes keep "$10" literal in bash, zsh and PowerShell (double quotes would expand $1).
  const ask = `node src/agent.mjs ask 'send $${amt} to ${name}'${exec}`;
  setText(cmdPre, cmd);
  setText(askPre, ask);
  cmdCopy.disabled = false; cmdCopy.dataset.copy = cmd;
  askCopy.disabled = false; askCopy.dataset.copy = ask;
}

function renderRate() {
  setText($("#kv-rate"), `1 USD₮ = ${naira(quote.rate)}`);
  const ageText = quote.ageMin < 1 ? "Updated just now" : quote.ageMin < 120 ? `Updated ${quote.ageMin} min ago` : `Updated ${Math.round(quote.ageMin / 60)} h ago`;
  const fresh = badge("", quote.stale ? "warn" : "ok");
  fresh.append(el("span", { class: "dot" }), quote.stale ? `Stale · ${ageText.toLowerCase()}` : ageText);
  $("#kv-source").replaceChildren(
    el("span", { class: "row", style: "justify-content:flex-end;gap:8px" }, el("span", {}, "Textile FX, refreshed every 30 min"), fresh),
  );
  const t = quote.ticker;
  const bid = Number(t?.bid), ask = Number(t?.ask);
  setText($("#kv-market"), bid > 0 && ask > 0 ? `${naira(bid)} / ${naira(ask)}` : "—");
  if (quote.stale) {
    $("#rate-error").replaceChildren(el("div", { class: "alert warn mt-16" }, icon("alert"),
      el("span", {}, "This rate is older than usual, so the real quote may differ. The agent always takes a fresh firm quote before paying.")));
  }
}

function renderRateError() {
  for (const id of ["#kv-rate", "#kv-fees", "#kv-source", "#kv-market"]) setText($(id), "—");
  $("#rate-error").replaceChildren(el("div", { class: "alert err mt-16" }, icon("alert"),
    el("span", {}, "Couldn't load the exchange rate. Refresh the page to try again, or check live rates in the ",
      el("a", { class: "link", href: "https://fx-docs.textilecredit.com" }, "Textile FX docs"), ".")));
}

// ---------- events ----------
amountIn.addEventListener("input", () => { renderAmount(); renderCommand(); });
for (const b of presets) {
  b.addEventListener("click", () => {
    amountIn.value = b.dataset.amount;
    renderAmount(); renderCommand();
  });
}
recipientIn.addEventListener("input", renderCommand);
for (const b of modeBtns) {
  b.addEventListener("click", () => { mode = b.dataset.mode; renderCommand(); });
}

renderAmount();
renderCommand();

try {
  quote = await loadRate();
  renderRate();
} catch {
  rateFailed = true;
  renderRateError();
}
renderAmount();
