import { $, el, icon, badge, short, celoscanAddr, initChrome, toast, ntagUrl, DISCONNECT_NOTE_FULL, DISCONNECT_NOTE_PARTIAL } from "../assets/core.js";
import { getSession, signIn, signOut, onSessionChange, watchSession, explainWalletError, injectedWallet, lookupNtag, avatar } from "../assets/session.js";

initChrome();

// Account page: sign-in panel when signed out; the signed-in wallet and its nTag otherwise.
// The full claim flow is described in site/_spec/NTAGS.md section 4.

const root = $("#account-root");
let note = null; // a one-off message shown under the panel (e.g. after signing out)

function alertBox(kind, iconName, ...children) {
  return el("div", { class: `alert${kind ? " " + kind : ""}`, role: kind === "err" ? "alert" : null }, icon(iconName), el("div", {}, ...children));
}

function signedOutPanel() {
  const eth = injectedWallet();
  const msg = el("div", { "aria-live": "polite" });
  const body = [
    el("p", { class: "soft" }, "Connect your wallet and sign a short message. Signing is free, sends nothing and needs no password."),
  ];
  if (!eth) {
    const page = location.href.split("#")[0];
    body.push(alertBox("", "info",
      el("p", {}, el("b", {}, "No wallet found in this browser."), " Open this page inside MiniPay, MetaMask or another Celo wallet's browser, then sign in there."),
      el("div", { class: "row mt-16" },
        el("button", { class: "btn btn-secondary btn-sm", type: "button", dataset: { copy: page, copyLabel: "Page link copied" } }, icon("copy"), "Copy page link"),
        el("a", { class: "btn btn-secondary btn-sm", href: "https://metamask.app.link/dapp/" + page.replace(/^https?:\/\//, "") }, icon("ext"), "Open in MetaMask"))));
  } else {
    const b = el("button", { class: "btn btn-primary btn-lg", type: "button" }, icon("wallet"), "Sign in with your wallet");
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.lastChild.textContent = "Check your wallet…";
      msg.replaceChildren();
      try {
        await signIn(eth);
        toast("Signed in");
      } catch (e) {
        b.disabled = false;
        b.lastChild.textContent = "Sign in with your wallet";
        msg.replaceChildren(alertBox("err", "alert", el("p", {}, e?.plain || e?.code === "NO_WALLET" ? e.message : explainWalletError(e))));
      }
    });
    body.push(el("div", { class: "row" }, b));
  }
  body.push(msg);
  return el("section", { class: "card", "aria-labelledby": "signin-h" },
    el("div", { class: "card-h" }, el("h2", { id: "signin-h" }, "Sign in"), badge("Signed out", "neutral")),
    el("div", { class: "card-b stack" }, ...body));
}

function signedInPanel(s) {
  const tagLine = el("span", { class: "soft" }, el("span", { class: "skel" }));
  lookupNtag(s.address).then(({ tag, name }) => {
    if (!tag) { tagLine.replaceChildren("No nTag yet"); return; }
    tagLine.replaceChildren(el("a", { class: "link np-tagname", href: ntagUrl(tag) }, "@" + tag), name ? ` · ${name}` : "");
  }).catch(() => tagLine.replaceChildren("Couldn't look up your nTag right now"));
  const out = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("logout"), "Sign out");
  out.addEventListener("click", async () => {
    out.disabled = true;
    const revoked = await signOut();
    note = revoked ? DISCONNECT_NOTE_FULL : DISCONNECT_NOTE_PARTIAL;
    toast("Signed out");
  });
  return el("section", { class: "card", "aria-labelledby": "wallet-h" },
    el("div", { class: "card-h" }, el("h2", { id: "wallet-h" }, "Wallet"), el("span", { class: "badge ok" }, el("span", { class: "dot" }), "Signed in")),
    el("div", { class: "card-b stack" },
      el("div", { class: "row", style: "gap:14px" }, avatar(s.address, "lg"),
        el("div", {}, el("a", { class: "mono link", href: celoscanAddr(s.address), title: s.address }, short(s.address)), el("div", { class: "small" }, tagLine))),
      el("ul", { class: "kv-list" },
        el("li", {}, el("span", {}, "Network"), el("span", {}, "Celo mainnet")),
        el("li", {}, el("span", {}, "Session ends"), el("span", { class: "num" }, new Date(s.exp * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })))),
      el("div", { class: "row" }, out)));
}

function render(s = getSession()) {
  const parts = [s ? signedInPanel(s) : signedOutPanel()];
  if (!s && note) { parts.push(alertBox("", "info", el("p", {}, note))); note = null; }
  root.replaceChildren(...parts);
}

onSessionChange(render);
watchSession();
render();
