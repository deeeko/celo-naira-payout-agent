import { TAG, short, lagosTime, $, el, badge, icon, loadTxPage, loadTxByHash, decodeTag, txStatus, celoscanTx, celoscanAddr, initChrome } from "../assets/core.js";

initChrome();

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const form = $("#check-form");
const input = $("#tx-input");
const hint = $("#tx-hint");
const btn = $("#check-btn");
const result = $("#result");
const resultBody = $("#result-body");
const resultHash = $("#result-hash");
const samples = $("#samples");

let seq = 0;

const HINT_DEFAULT = "A 66-character hash starting with 0x.";

function setInvalid(msg) {
  hint.textContent = msg || HINT_DEFAULT;
  hint.classList.toggle("err", !!msg);
  if (msg) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function addrLink(a) {
  if (!a) return el("span", { class: "muted" }, "—");
  return el("a", { class: "link mono", href: celoscanAddr(a), target: "_blank", rel: "noopener", title: a }, short(a), " ", icon("ext"));
}

function show(...nodes) {
  result.hidden = false;
  resultBody.replaceChildren(...nodes);
}

function loading(hash) {
  resultHash.textContent = short(hash);
  const row = (w) => el("li", {}, el("span", {}, el("span", { class: "skel", style: "width:64px" })), el("span", {}, el("span", { class: "skel", style: `width:${w}px` })));
  show(
    el("div", { class: "alert" }, el("span", { class: "skel", style: "width:100%;height:20px" })),
    el("ul", { class: "kv-list mt-16", "aria-busy": "true" }, [120, 110, 110, 80, 120, 140, 30].map(row)),
    el("span", { class: "sr-only" }, "Checking transaction…"),
  );
}

function verdict(tag) {
  if (tag && tag.codes.includes(TAG)) {
    return el("div", { class: "alert" }, icon("shield", "i i-lg"),
      el("div", {}, badge("Verified", "ok"),
        el("p", { class: "mt-8" }, "Carries this agent's tag (", el("code", { class: "inline" }, TAG), ").")));
  }
  if (tag) {
    const codes = tag.codes.filter(Boolean);
    return el("div", { class: "alert warn" }, icon("alert", "i i-lg"),
      el("div", {}, badge("Other tag", "warn"),
        el("p", { class: "mt-8" }, "Tagged, but not with this agent's code.",
          codes.length ? [" Codes found: ", codes.join(", "), "."] : " No codes could be decoded.")));
  }
  return el("div", { class: "alert err" }, icon("alert", "i i-lg"),
    el("div", {}, badge("Not tagged", "err"),
      el("p", { class: "mt-8" }, "No attribution tag. This transaction's calldata does not end with the ERC-8021 marker.")));
}

function suffixHex(input, tag) {
  const h = (input ?? "").replace(/^0x/, "");
  if (!tag) return null;
  const len = tag.schema === 0 ? new TextEncoder().encode(tag.codes.join(",")).length : 0;
  const bytes = Math.min(len + 18, h.length / 2);
  return "0x" + h.slice(-bytes * 2);
}

function renderTx(tx) {
  const tag = decodeTag(tx.input);
  const [statusText, statusKind] = txStatus(tx);
  const codes = tag ? tag.codes.filter(Boolean) : [];
  const raw = suffixHex(tx.input, tag);
  const nodes = [
    verdict(tag),
    el("ul", { class: "kv-list mt-16" },
      el("li", {}, el("span", {}, "Status"), el("span", {}, badge(statusText, statusKind))),
      el("li", {}, el("span", {}, "From"), el("span", {}, addrLink(tx.from))),
      el("li", {}, el("span", {}, "To"), el("span", {}, tx.to ? addrLink(tx.to) : el("span", { class: "muted" }, "Contract creation"))),
      el("li", {}, el("span", {}, "Block"), el("span", { class: "num" }, tx.blockNumber != null ? tx.blockNumber.toLocaleString("en-NG") : "Pending")),
      el("li", {}, el("span", {}, "Time"), el("span", { class: "num" }, tx.timestamp ? lagosTime(tx.timestamp) + " WAT" : "—")),
      el("li", {}, el("span", {}, "Codes found"), el("span", { class: "mono" }, codes.length ? codes.join(", ") : "None")),
      el("li", {}, el("span", {}, "Schema"), el("span", { class: "num" }, tag ? String(tag.schema) : "—")),
    ),
  ];
  if (raw) {
    nodes.push(el("div", { class: "field mt-16" },
      el("span", { class: "label" }, "Tag bytes at the end of calldata"),
      el("pre", { class: "code-block" }, raw)));
  }
  nodes.push(el("div", { class: "row mt-16" },
    el("a", { class: "btn btn-secondary btn-sm", href: celoscanTx(tx.hash), target: "_blank", rel: "noopener" }, "View on Celoscan", icon("ext")),
    el("button", { class: "btn btn-ghost btn-sm", type: "button", dataset: { copy: location.href, copyLabel: "Link copied" } }, icon("copy"), "Copy link to this check")));
  show(...nodes);
}

async function check(hash) {
  hash = hash.trim();
  if (!HASH_RE.test(hash)) {
    setInvalid("Enter a 66-character hash starting with 0x.");
    input.focus();
    return;
  }
  setInvalid("");
  input.value = hash;
  const url = new URL(location.href);
  url.searchParams.set("tx", hash);
  history.replaceState(null, "", url);

  const my = ++seq;
  btn.disabled = true;
  loading(hash);
  try {
    const tx = await loadTxByHash(hash);
    if (my !== seq) return;
    if (!tx) {
      show(el("div", { class: "alert err" }, icon("alert"),
        el("span", {}, "No transaction with this hash on Celo mainnet. Check that you copied the full hash, or search for it on ",
          el("a", { class: "link", href: celoscanTx(hash), target: "_blank", rel: "noopener" }, "Celoscan"), ".")));
      return;
    }
    renderTx(tx);
  } catch (e) {
    if (my !== seq) return;
    const retry = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("refresh"), "Try again");
    retry.addEventListener("click", () => check(hash));
    show(
      el("div", { class: "alert err" }, icon("alert"),
        el("span", {}, "Could not reach Celo's RPC (", String(e?.message ?? e), "). Check your connection and try again, or open the transaction on ",
          el("a", { class: "link", href: celoscanTx(hash), target: "_blank", rel: "noopener" }, "Celoscan"), ".")),
      el("div", { class: "row mt-16" }, retry),
    );
  } finally {
    if (my === seq) btn.disabled = false;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  check(input.value);
});
input.addEventListener("input", () => { if (hint.classList.contains("err")) setInvalid(""); });

async function loadSamples() {
  const label = $("#samples-label");
  try {
    const { items } = await loadTxPage();
    const picks = items.slice(0, 3);
    if (!picks.length) { samples.hidden = true; return; }
    samples.replaceChildren(label, ...picks.map((t) => {
      const b = el("button", { class: "btn btn-secondary btn-sm mono", type: "button", "aria-label": `Check the agent's transaction ${t.hash}` }, short(t.hash));
      b.addEventListener("click", () => { input.value = t.hash; check(t.hash); });
      return b;
    }));
  } catch {
    samples.hidden = true;
  }
}

loadSamples();

const initial = new URLSearchParams(location.search).get("tx");
if (initial) {
  input.value = initial;
  check(initial);
}
