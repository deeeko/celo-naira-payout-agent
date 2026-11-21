import { AGENT, AGENT_ID, CAP, $, el, badge, icon, naira, short, lagosTime, lagosClock, celoscanTx, celoscanAddr, loadRate, loadIdentity, loadTxPage, receiptNo, isTagged, txKind, txLabel, initChrome, ntagUrl, toast, loadNtagOps, resolveNtags, ownerOf } from "../assets/core.js";
import { getSession, signIn, onSessionChange, watchSession, explainWalletError, injectedWallet, lookupNtag, cachedNtag } from "../assets/session.js";
import { ntagCard, ntagFinder, stage, greeting, alertBox } from "../assets/ntag-ui.js";

initChrome();

// ---------- hero: the front door (sign in, find an nTag) or, signed in, a greeting with the user's tag card ----------
const hero = {
  eyebrow: $("#hero-eyebrow"), title: $("#hero-title"), lead: $("#hero-lead"), actions: $("#hero-actions"),
  find: $("#hero-find"), msg: $("#hero-msg"), art: $("#hero-art"),
};
let heroKey = null; // what the hero currently shows, so session pings don't rebuild it needlessly

function heroSignedOut() {
  hero.eyebrow.replaceChildren("nTags on Celo");
  hero.title.replaceChildren("Send dollars to ", el("em", {}, "@ada"), ". She gets naira.");
  hero.lead.textContent = "Claim a short nTag tied to your Celo wallet. Anyone can pay it in USD₮ or cNGN, and the agent converts on Textile FX and pays your wallet. Signing in is free and sends nothing.";
  const signBtn = el("button", { class: "btn btn-primary btn-lg", type: "button", id: "hero-signin" }, icon("wallet"), el("span", {}, "Sign in with your wallet"));
  signBtn.addEventListener("click", async () => {
    const eth = injectedWallet();
    if (!eth) { location.href = "account.html"; return; } // explains how to open the site in a wallet
    signBtn.disabled = true;
    signBtn.lastChild.textContent = "Check your wallet…";
    hero.msg.replaceChildren();
    try {
      await signIn(eth);
      toast("Signed in");
    } catch (e) {
      signBtn.disabled = false;
      signBtn.lastChild.textContent = "Sign in with your wallet";
      hero.msg.replaceChildren(alertBox("err", "alert", el("p", {}, e?.plain || e?.code === "NO_WALLET" ? e.message : explainWalletError(e))));
    }
  });
  hero.actions.replaceChildren(signBtn, el("a", { class: "btn btn-secondary btn-lg", href: "quote.html" }, "Get a quote"));
  hero.art.replaceChildren(stage(ntagCard({ tag: "ada", name: "Ada Obi", address: "0x7a3e00000000000000000000000000000000c0de", since: 1_795_000_000 }),
    "An example card. Yours shows your tag, name and wallet."));
}

function heroSignedIn(s, info) {
  const tag = info?.tag ?? null;
  hero.eyebrow.replaceChildren(el("span", { class: "live-dot", "aria-hidden": "true", style: "margin:0 2px 0 0" }), "Signed in");
  if (tag) {
    hero.title.replaceChildren(`${greeting()}, `, el("em", {}, "@" + tag), ".");
    hero.lead.textContent = "Your tag is live. Share it and anyone can pay you in dollars or naira; the agent pays the wallet you signed in with.";
    hero.actions.replaceChildren(
      el("a", { class: "btn btn-primary btn-lg", href: "account.html" }, "Go to your account", icon("right")),
      el("button", { class: "btn btn-secondary btn-lg", type: "button", dataset: { copy: ntagUrl(tag), copyLabel: "Link copied" } }, icon("copy"), "Copy your link"));
  } else {
    hero.title.replaceChildren(`${greeting()}. Now claim your `, el("em", {}, "@name"), ".");
    hero.lead.textContent = info === undefined
      ? "Checking whether this wallet already has an nTag…"
      : `You're signed in as ${short(s.address)}. Pick a short tag so people can pay you by name instead of a long address. It costs only the network fee, a fraction of a cent.`;
    hero.actions.replaceChildren(
      el("a", { class: "btn btn-primary btn-lg", href: "account.html" }, "Claim your nTag", icon("right")),
      el("a", { class: "btn btn-secondary btn-lg", href: "account.html" }, "Go to your account"));
  }
  const card = ntagCard(tag
    ? { tag, name: info?.name, address: s.address, as: "a", href: ntagUrl(tag), label: `Your nTag @${tag}. Open your pay page` }
    : { tag: "", address: s.address, kind: "preview" });
  if (tag) {
    // "since" comes from the resolved state (cached for 30 s, shared with the search below)
    loadNtagOps().then((ops) => { const e = ownerOf(resolveNtags(ops), tag); if (e) card.update({ since: e.since }); }).catch(() => {});
  }
  hero.art.replaceChildren(stage(card, tag ? "Your card. Tap it to open your pay page." : "Your card, once you claim a tag."));
}

function renderHero() {
  const s = getSession();
  const info = s ? cachedNtag(s.address) : undefined;
  const key = s ? `${s.address}:${info === undefined ? "?" : info.tag ?? "-"}:${info?.name ?? ""}` : "out";
  if (key === heroKey) return;
  heroKey = key;
  hero.msg.replaceChildren();
  if (!s) heroSignedOut(); else heroSignedIn(s, info);
  if (s && info === undefined) {
    lookupNtag(s.address).then(() => renderHero()).catch(() => {
      heroKey = null;
      heroSignedIn(s, { tag: null });
      hero.lead.textContent = "Couldn't check your nTag right now. Open your account to see it or claim one.";
    });
  }
}
hero.find.replaceChildren(ntagFinder({ id: "hero-find-input", label: "Find an nTag to pay", address: () => getSession()?.address }));
onSessionChange(renderHero);
watchSession();
renderHero();

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
