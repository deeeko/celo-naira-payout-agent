import { AGENT, loadTxPage, celoscanTx, celoscanAddr, lagosTime, short, isTagged, txKind, txLabel, txStatus, el, badge, icon, toast, download, $, $$, initChrome } from "../assets/core.js";

initChrome();

const COLS = ["Activity", "Status", "Attribution tag", "Time (WAT)", "Transaction"];
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const EMPTY = {
  all: "No transactions from the agent wallet yet.",
  payout: "No payouts yet.",
  convert: "No conversions yet.",
  approve: "No approvals yet.",
  identity: "No identity transactions yet.",
};
const NAMES = { all: "transactions", payout: "payouts", convert: "conversions", approve: "approvals", identity: "identity transactions" };

const state = { rows: [], next: null, filter: "all", query: "", loading: false, failed: false, gen: 0 };

const tbody = $("#rows");
const moreBtn = $("#more");
const moreErr = $("#more-err");
const count = $("#count");
const exportBtn = $("#export");
const refreshBtn = $("#refresh");

// ---------- rendering ----------
const cell = (label, cls, ...kids) => el("td", { "data-label": label, class: cls }, ...kids);

function skeletonRows(n = 6) {
  const widths = [150, 70, 70, 110, 120];
  return Array.from({ length: n }, () =>
    el("tr", { "aria-hidden": "true" }, COLS.map((c, i) => cell(c, i === 0 ? "lead-cell" : null, el("span", { class: "skel", style: `width:${widths[i]}px` })))),
  );
}

function emptyRow(...kids) {
  return el("tr", { class: "empty" }, el("td", { colspan: String(COLS.length) }, ...kids));
}

function row(tx) {
  const [statusText, statusKind] = txStatus(tx);
  const tagged = isTagged(tx);
  const hash = String(tx.hash ?? "");
  const valid = HASH_RE.test(hash);
  const time = tx.timestamp ? lagosTime(tx.timestamp) : "—";
  const hashCell = valid
    ? el("span", { class: "tx-hash" },
        el("a", { class: "mono", href: celoscanTx(hash), target: "_blank", rel: "noopener", title: hash, "aria-label": `Open transaction ${short(hash)} on Celoscan` }, short(hash)),
        el("button", { class: "icon-btn sm", type: "button", "aria-label": "Copy transaction hash", dataset: { copy: hash, copyLabel: "Transaction hash copied" } }, icon("copy")))
    : el("span", { class: "muted" }, "—");
  return el("tr", {},
    cell("Activity", "lead-cell", el("span", { class: "strong" }, txLabel(tx))),
    cell("Status", null, badge(statusText, statusKind)),
    cell("Attribution tag", null, tagged ? badge("Tagged", "ok") : badge("Missing", "warn")),
    cell("Time (WAT)", "num", time),
    cell("Transaction", null, hashCell),
  );
}

function visibleRows() {
  const q = state.query.trim().toLowerCase();
  return state.rows.filter((tx) =>
    (state.filter === "all" || txKind(tx) === state.filter) &&
    (!q || String(tx.hash ?? "").toLowerCase().includes(q)));
}

function renderTable() {
  if (state.failed && !state.rows.length) {
    tbody.replaceChildren(emptyRow(
      el("span", { class: "row", style: "justify-content:center" }, icon("alert"), "Could not load transactions from Blockscout."),
      el("div", { class: "mt-8" },
        el("a", { class: "link", href: celoscanAddr(AGENT), target: "_blank", rel: "noopener" }, "View the agent wallet on Celoscan"),
        " or ",
        el("button", { class: "btn btn-ghost btn-sm", type: "button", id: "retry" }, "Try again")),
    ));
    $("#retry")?.addEventListener("click", () => reload());
    return;
  }
  if (state.loading && !state.rows.length) { tbody.replaceChildren(...skeletonRows()); return; }

  const list = visibleRows();
  if (!list.length) {
    let msg;
    if (state.query.trim()) msg = "No loaded transaction matches that hash.";
    else if (state.next) msg = `No ${NAMES[state.filter]} in the loaded transactions.`;
    else msg = EMPTY[state.filter];
    const hint = state.next ? el("div", { class: "mt-8 small" }, "Load more to include older transactions.") : null;
    tbody.replaceChildren(emptyRow(msg, hint));
    return;
  }
  tbody.replaceChildren(...list.map(row));
}

function renderStats() {
  const set = (id, text) => { $(id).textContent = text; };
  if (state.failed && !state.rows.length) {
    for (const id of ["#s-loaded", "#s-tagged", "#s-payouts", "#s-last"]) set(id, "—");
    set("#s-tagged-sub", "ERC-8021 attribution in calldata");
    return;
  }
  if (state.loading && !state.rows.length) return;

  const n = state.rows.length;
  const tagged = state.rows.filter(isTagged).length;
  const payouts = state.rows.filter((t) => txKind(t) === "payout").length;
  const allLoaded = !state.next;

  set("#s-loaded", allLoaded ? String(n) : `${n}+`);
  set("#s-loaded-sub", allLoaded ? "Full history from the agent wallet" : "More available below");
  set("#s-tagged", n ? `${tagged} / ${n}` : "—");
  set("#s-tagged-sub", n ? `${Math.round((tagged / n) * 100)}% carry the ERC-8021 tag` : "ERC-8021 attribution in calldata");
  set("#s-payouts", String(payouts));
  if (!allLoaded) set("#s-payouts-sub", "in loaded transactions");
  else set("#s-payouts-sub", payouts === 0 ? "No payout yet" : "cNGN transfers to the recipient");
  const newest = state.rows.find((t) => t.timestamp);
  set("#s-last", newest ? lagosTime(newest.timestamp) : "—");

  // Only claim "registering its identity" when that is literally what every loaded transaction is.
  $("#no-payout").hidden = !(allLoaded && n > 0 && payouts === 0 && state.rows.every((t) => txKind(t) === "identity"));
}

function renderFooter() {
  const shown = visibleRows().length;
  if (state.loading && !state.rows.length) count.textContent = "Loading transactions…";
  else if (state.failed && !state.rows.length) count.textContent = "Showing 0";
  else count.textContent = shown === state.rows.length ? `Showing ${shown}` : `Showing ${shown} of ${state.rows.length} loaded`;

  moreBtn.hidden = !state.next;
  moreBtn.disabled = state.loading;
  moreBtn.textContent = state.loading && state.rows.length ? "Loading…" : "Load more";
  exportBtn.disabled = !state.rows.length;
  refreshBtn.disabled = state.loading;
  $("#tx-card").setAttribute("aria-busy", String(state.loading));
}

function render() { renderTable(); renderStats(); renderFooter(); }

// ---------- data ----------
const fetchPage = (next) => loadTxPage(next);

async function reload() {
  const gen = ++state.gen;
  Object.assign(state, { rows: [], next: null, loading: true, failed: false });
  moreErr.hidden = true;
  for (const id of ["#s-loaded", "#s-tagged", "#s-payouts", "#s-last"]) $(id).replaceChildren(el("span", { class: "skel lg" }));
  render();
  try {
    const page = await fetchPage(null);
    if (gen !== state.gen) return;
    state.rows = page.items;
    state.next = page.next;
  } catch {
    if (gen !== state.gen) return;
    state.failed = true;
  }
  state.loading = false;
  render();
}

async function loadMore() {
  if (!state.next || state.loading) return;
  const gen = state.gen;
  state.loading = true;
  moreErr.hidden = true;
  renderFooter();
  try {
    const page = await fetchPage(state.next);
    if (gen !== state.gen) return;
    const seen = new Set(state.rows.map((t) => t.hash));
    state.rows.push(...page.items.filter((t) => !seen.has(t.hash)));
    state.next = page.next;
  } catch {
    if (gen !== state.gen) return;
    moreErr.textContent = "Could not load older transactions. Try again.";
    moreErr.hidden = false;
  }
  state.loading = false;
  render();
}

// ---------- CSV ----------
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function exportCsv() {
  if (!state.rows.length) return;
  const header = ["hash", "activity", "status", "tagged", "time_utc", "celoscan_url"];
  const lines = state.rows.map((tx) => {
    const hash = String(tx.hash ?? "");
    const t = tx.timestamp ? new Date(tx.timestamp) : null;
    return [
      hash,
      txLabel(tx),
      txStatus(tx)[0],
      isTagged(tx) ? "yes" : "no",
      t && !isNaN(t) ? t.toISOString() : "",
      HASH_RE.test(hash) ? celoscanTx(hash) : "",
    ].map(csvCell).join(",");
  });
  download("naira-payout-transactions.csv", [header.join(","), ...lines].join("\r\n") + "\r\n");
  toast(`Exported ${state.rows.length} transactions`);
}

// ---------- controls ----------
for (const b of $$("#filter button")) {
  b.addEventListener("click", () => {
    state.filter = b.dataset.kind;
    for (const o of $$("#filter button")) o.setAttribute("aria-pressed", String(o === b));
    renderTable(); renderFooter();
  });
}
$("#q").addEventListener("input", (e) => { state.query = e.target.value; renderTable(); renderFooter(); });
refreshBtn.addEventListener("click", () => reload());
moreBtn.addEventListener("click", () => loadMore());
exportBtn.addEventListener("click", exportCsv);

reload();
