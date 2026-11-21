import { AGENT, AGENT_ID, CAP, $, el, badge, icon, naira, short, lagosTime, lagosClock, celoscanTx, celoscanAddr, loadRate, loadIdentity, loadTxPage, receiptNo, isTagged, txKind, txLabel, initChrome } from "../assets/core.js";

initChrome();

const fill = (node, ...children) => node.replaceChildren(...children.flat().filter((c) => c != null));
const fail = (valueId, subId, reason) => {
  fill($(valueId), "—");
  fill($(subId), reason);
};

// ---------- exchange rate + quick quote ----------
let rate = null;
const input = $("#qq-amount");
const out = $("#qq-out");
const hint = $("#qq-hint");
const HINT = `Up to $${CAP} per payout.`;

function parseAmount(raw) {
  const s = raw.replace(/[,\s]/g, "").replace(/^\$/, "");
  if (s === "" || s === ".") return { empty: true };
  if (!/^\d*\.?\d*$/.test(s)) return { invalid: true };
  return { value: Number(s) };
}

function renderQuote() {
  out.classList.remove("over");
  hint.classList.remove("err");
  input.removeAttribute("aria-invalid");
  hint.textContent = HINT;
  const a = parseAmount(input.value);
  if (a.invalid) {
    hint.classList.add("err");
    input.setAttribute("aria-invalid", "true");
    hint.textContent = "Enter an amount in dollars, for example 10.";
    fill(out, "—");
    return;
  }
  if (rate == null) return; // still loading or failed: leave the output as set by the loader
  if (a.empty || a.value === 0) { fill(out, "—"); return; }
  fill(out, "≈ " + naira(a.value * rate));
  if (a.value > CAP) {
    out.classList.add("over");
    hint.classList.add("err");
    input.setAttribute("aria-invalid", "true");
    hint.textContent = `Above the $${CAP} cap. The agent refuses payouts over $${CAP}.`;
  }
}
input.addEventListener("input", renderQuote);

loadRate().then((r) => {
  rate = r.rate;
  fill($("#st-rate"), el("span", { class: "small soft" }, "1 USD₮ = "), naira(r.rate));
  const sub = r.fromPreview ? `Fees included · updated ${lagosClock(r.fetchedAt)} WAT` : "Market bid, before fees";
  fill($("#st-rate-sub"), r.stale ? [badge(`Stale · ${r.ageMin} min old`, "warn"), " ", sub] : sub);
  fill($("#qq-basis"), r.fromPreview ? "Fees included" : "Before fees");
  renderQuote();
}).catch(() => {
  fail("#st-rate", "#st-rate-sub", "Rate unavailable right now. Reload to retry.");
  fill(out, "—");
  hint.classList.add("err");
  hint.textContent = "No rate available, so no estimate. Reload, or try the full quote page.";
  fill($("#qq-basis"), "Unavailable");
});

// ---------- identity ----------
loadIdentity().then((id) => {
  fill($("#st-id"), "#" + AGENT_ID.toString());
  fill($("#st-id-sub"), id.ok
    ? badge("Verified owner", "ok")
    : [badge("Owner mismatch", "err"), " ", el("a", { class: "link", href: celoscanAddr(id.owner) }, short(id.owner))]);
}).catch(() => {
  fill($("#st-id"), "#" + AGENT_ID.toString());
  fill($("#st-id-sub"), "Could not check owner. ", el("a", { class: "link", href: "agent.html" }, "Open agent page"));
});

// ---------- transactions + activity ----------
const activity = $("#activity");

const HASH_RE = /^0x[0-9a-f]{64}$/i;

function activityRow(tx) {
  const tagged = isTagged(tx);
  const hash = String(tx.hash ?? "");
  const no = HASH_RE.test(hash) ? receiptNo(hash) : null;
  return el("li", {},
    el("span", {},
      el("span", { class: "soft", style: "display:block" }, txLabel(tx)),
      el("span", { class: "micro" }, tx.timestamp ? lagosTime(tx.timestamp) + " WAT" : "Pending"),
    ),
    el("span", { class: "row", style: "justify-content:flex-end;gap:8px;flex-wrap:wrap" },
      badge(tagged ? "Tagged" : "No tag", tagged ? "ok" : "neutral"),
      el("a", { class: "link mono", href: celoscanTx(tx.hash), "aria-label": `Transaction ${tx.hash} on Celoscan` }, short(tx.hash)),
      no ? el("a", { class: "link", href: `receipt.html#${no}`, "aria-label": `Receipt ${no}`, title: no }, "Receipt") : null,
    ),
  );
}

loadTxPage().then(({ items, next }) => {
  const count = items.length + (next ? "+" : "");
  const tagged = items.filter(isTagged).length;
  const payouts = items.filter((t) => txKind(t) === "payout").length;

  fill($("#st-tx"), String(count));
  fill($("#st-tx-sub"), `${tagged} carry the tag`);
  fill($("#st-pay"), String(payouts));
  fill($("#st-pay-sub"), payouts === 0 ? "No payout yet" : `cNGN transfers to a recipient`);

  activity.removeAttribute("aria-busy");
  if (!items.length) {
    fill(activity, el("p", { class: "empty" }, "No transactions from the agent wallet yet."));
    return;
  }
  fill(activity, el("ul", { class: "kv-list" }, items.slice(0, 5).map(activityRow)));
}).catch(() => {
  fail("#st-tx", "#st-tx-sub", "Explorer unavailable");
  fail("#st-pay", "#st-pay-sub", "Explorer unavailable");
  activity.removeAttribute("aria-busy");
  fill(activity, el("div", { class: "alert err" },
    icon("alert"),
    el("span", {}, "Could not load transactions from Blockscout. Reload to retry, or ",
      el("a", { class: "link", href: celoscanAddr(AGENT) }, "view the agent on Celoscan"), "."),
  ));
});
