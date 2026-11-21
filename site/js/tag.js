import { $, el, icon, short, celoscanAddr, lagosTime, initChrome, loadNtagOps, resolveNtags, ownerOf, normalizeNtag, ntagError } from "../assets/core.js";

initChrome();

// Public nTag page: tag.html#ada, tag.html?t=ada, or /@ada on Vercel (rewritten to tag.html?t=ada).
// The pay flow is described in site/_spec/NTAGS.md section 4.

const root = $("#tag-root");

function readTag() {
  const q = new URLSearchParams(location.search).get("t");
  const h = decodeURIComponent(location.hash.replace(/^#/, ""));
  return normalizeNtag(q || h);
}

async function render() {
  const tag = readTag();
  if (!tag) {
    root.replaceChildren(el("div", { class: "card" }, el("div", { class: "card-b" }, el("p", { class: "soft" }, "Add a tag to the address, like tag.html#ada."))));
    return;
  }
  const err = ntagError(tag);
  if (err) {
    root.replaceChildren(el("div", { class: "alert warn" }, icon("alert"), el("p", {}, `@${tag} isn't a valid nTag: ${err}.`)));
    return;
  }
  document.title = `@${tag} · Naira Payout`;
  $("#tag-title").replaceChildren("Pay ", el("em", {}, "@" + tag));
  root.replaceChildren(el("p", { class: "small muted", role: "status" }, el("span", { class: "skel" }), " Looking up @" + tag + "…"));
  let entry;
  try { entry = ownerOf(resolveNtags(await loadNtagOps()), tag); }
  catch {
    const retry = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("refresh"), "Try again");
    retry.addEventListener("click", render);
    root.replaceChildren(el("div", { class: "alert err", role: "alert" }, icon("alert"), el("div", {}, el("p", {}, "Couldn't reach the Celo explorer to look up this tag."), el("div", { class: "row mt-8" }, retry))));
    return;
  }
  if (!entry) {
    root.replaceChildren(el("section", { class: "card" }, el("div", { class: "card-b stack" },
      el("p", {}, el("b", {}, `Nobody has @${tag} yet.`)),
      el("div", { class: "row" }, el("a", { class: "btn btn-primary", href: "account.html" }, `Claim @${tag} yourself`)))));
    return;
  }
  root.replaceChildren(el("section", { class: "card" }, el("div", { class: "card-b" },
    el("ul", { class: "kv-list" },
      el("li", {}, el("span", {}, "nTag"), el("span", { class: "np-tagname" }, "@" + tag)),
      entry.name ? el("li", {}, el("span", {}, "Name"), el("span", {}, entry.name)) : null,
      el("li", {}, el("span", {}, "Wallet"), el("a", { class: "mono link", href: celoscanAddr(entry.owner), title: entry.owner }, short(entry.owner))),
      el("li", {}, el("span", {}, "Since"), el("span", { class: "num" }, `${lagosTime(entry.since * 1000)} WAT`))))));
}

addEventListener("hashchange", render);
render();
