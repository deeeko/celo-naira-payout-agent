import { initChrome, AGENT, AGENT_ID, REGISTRY, TAG, celoscanAddr, num2, short, lagosClock, $, el, badge, icon, loadIdentity, loadBalances } from "../assets/core.js";

initChrome();

const DASH = "—";
const set = (node, ...children) => node.replaceChildren(...children);
const errorAlert = (message, href, linkText) =>
  el("div", { class: "alert err", role: "alert" }, icon("alert"),
    el("span", {}, message + " ", el("a", { class: "link", href }, linkText), "."));

// ---------- static facts (known constants, no network) ----------
const regLink = $("#id-registry");
regLink.href = celoscanAddr(REGISTRY);
regLink.textContent = short(REGISTRY);
regLink.title = REGISTRY;

$("#w-addr").textContent = AGENT;
$("#w-copy").dataset.copy = AGENT;
$("#w-link").href = celoscanAddr(AGENT);
$("#tag-text").textContent = TAG;
$("#tag-copy").dataset.copy = TAG;

// ---------- identity + registration file ----------
const text = (v) => el("span", {}, v == null || v === "" ? DASH : String(v));
const yesNo = (v) => (v === true ? badge("Yes", "ok") : v === false ? badge("No", "neutral") : text(null));

async function renderIdentity() {
  const body = $("#id-body");
  try {
    const { ok, owner, file } = await loadIdentity();

    const ownerLink = el("a", { class: "link mono", href: celoscanAddr(owner), title: owner }, short(owner));
    set($("#id-owner"), ownerLink);
    set($("#id-status"), ok ? badge("Verified owner", "ok") : badge("Owner mismatch", "err"));

    set($("#id-name"), text(file?.name));
    set($("#id-desc"), text(file?.description));
    set($("#id-active"), yesNo(file?.active));
    set($("#id-x402"), yesNo(file?.x402Support));

    const regs = Array.isArray(file?.registrations) ? file.registrations : [];
    const matches = regs.some((r) => String(r?.agentId) === AGENT_ID.toString());
    set($("#id-cross"), file == null ? text(null) : matches ? badge("Matches onchain ID", "ok") : badge("No matching ID in file", "warn"));

    if (!ok) {
      const e = $("#id-error");
      set(e, el("div", { class: "alert warn" }, icon("alert"),
        el("span", {}, "The registry reports a different owner than the agent wallet. Check the identity NFT on ",
          el("a", { class: "link", href: celoscanAddr(REGISTRY) }, "Celoscan"), ".")));
      e.hidden = false;
    }

    renderFile(file);
  } catch (err) {
    for (const id of ["#id-owner", "#id-name", "#id-desc", "#id-active", "#id-x402", "#id-cross"]) set($(id), text(null));
    set($("#id-status"), badge("Unavailable", "err"));
    const e = $("#id-error");
    set(e, errorAlert("Could not read the identity from Celo right now. Try reloading, or view it on", celoscanAddr(REGISTRY), "Celoscan"));
    e.hidden = false;
    renderFile(undefined);
  } finally {
    body.removeAttribute("aria-busy");
  }
}

function renderFile(file) {
  const pre = $("#file-json");
  const btn = $("#file-copy");
  if (file) {
    const json = JSON.stringify(file, null, 2);
    pre.textContent = json;
    btn.dataset.copy = json;
    btn.disabled = false;
    return;
  }
  $("#file-wrap").hidden = true;
  const e = $("#file-error");
  set(e, file === null
    ? errorAlert("The registry returned a token URI that is not an inline JSON file, so it is not shown here. Inspect it on", celoscanAddr(REGISTRY), "Celoscan")
    : errorAlert("Could not load the registration file. Try reloading, or read it on", celoscanAddr(REGISTRY), "Celoscan"));
  e.hidden = false;
}

// ---------- balances ----------
const balCells = () => [$("#b-celo"), $("#b-usdt"), $("#b-cngn")];
const skel = () => el("span", { class: "skel", style: "width:70px" });

async function renderBalances() {
  const btn = $("#bal-refresh");
  const err = $("#bal-error");
  btn.disabled = true;
  err.hidden = true;
  for (const c of balCells()) set(c, skel());
  $("#bal-time").textContent = "Reading balances…";
  try {
    const { celo, usdt, cngn } = await loadBalances();
    const [a, b, c] = balCells();
    a.textContent = num2.format(celo);
    b.textContent = num2.format(usdt);
    c.textContent = num2.format(cngn);
    $("#bal-time").textContent = `Read at ${lagosClock(Date.now())} WAT`;
  } catch {
    for (const c of balCells()) c.textContent = DASH;
    set(err, errorAlert("Could not read balances from Celo right now. Try refresh, or check the wallet on", celoscanAddr(AGENT), "Celoscan"));
    err.hidden = false;
    $("#bal-time").textContent = "Balances unavailable";
  } finally {
    btn.disabled = false;
  }
}

$("#bal-refresh").addEventListener("click", renderBalances);

renderIdentity();
renderBalances();
