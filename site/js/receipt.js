import {
  AGENT, AGENT_ID, TAG, TOKENS, CORRIDORS, REPUTATION, SEL, EXPLORER_API,
  $, el, badge, icon, naira, usd, num2, short, lagosTime, celoscanTx, celoscanAddr,
  rpc, getJson, loadTxByHash, loadReceipt, decodeTransfers, decodeTag, loadTxPage, txKind,
  tokenSymbol, units6, encodeCall, tagSuffix, loadIdentity, copyText, initChrome,
} from "../assets/core.js";

initChrome();

// Receipt links the agent prints point at the published site, so shares and on-chain feedback
// always carry the public URL, even when this page is opened from a local copy.
const SITE_RECEIPT = "https://deeeko.github.io/celo-naira-payout-agent/receipt.html";
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const REQ_RE = /^r_[a-z0-9]{6,16}$/;
const CELO_CHAIN = "0xa4ec";
const eq = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const knownToken = (a) => tokenSymbol(a) !== "token";
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const body = $("#receipt-body");
const statusSlot = $("#receipt-status");
const actions = $("#receipt-actions");
const rateCard = $("#rate");
const rateBody = $("#rate-body");
const shareWa = $("#share-wa");
let shareUrl = SITE_RECEIPT;
let seq = 0;

$("#copy-link").addEventListener("click", () => copyText(shareUrl, "Link copied"));
$("#print-btn").addEventListener("click", () => window.print());

// ---------- small builders ----------
const addrLink = (a) => el("a", { class: "link mono", href: celoscanAddr(a), target: "_blank", rel: "noopener", title: a }, short(a), " ", icon("ext"));
const txLink = (h) => el("a", { class: "link mono", href: celoscanTx(h), target: "_blank", rel: "noopener", title: h }, short(h), " ", icon("ext"));
const kv = (label, ...value) => el("li", {}, el("span", {}, label), el("span", {}, ...value));
const alertBox = (kind, iconName, ...content) => el("div", { class: `alert${kind ? " " + kind : ""}` }, icon(iconName), el("div", {}, ...content));
const btnLink = (cls, href, text, ext) => el("a", { class: `btn ${cls} btn-sm`, href, ...(ext ? { target: "_blank", rel: "noopener" } : {}) }, text, ext ? icon("ext") : null);
function tagBadge(tx) {
  const tagged = !!decodeTag(tx.input)?.codes?.includes(TAG);
  return el("a", { href: `verify.html?tx=${tx.hash}`, title: tagged ? "Carries the agent's attribution tag. Open the check." : "No agent attribution tag. Open the check." },
    badge(tagged ? "Tagged" : "No tag", tagged ? "ok" : "warn"));
}
function setStatus(text, kind) {
  statusSlot.replaceChildren(text ? el("span", { class: `badge ${kind}` }, kind === "ok" ? el("span", { class: "dot" }) : null, text) : "");
}
function show(...nodes) { body.removeAttribute("aria-busy"); body.replaceChildren(...nodes); }

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const p = q.get("p"), s = q.get("s"), r = q.get("r");
  return { p, s: s && HASH_RE.test(s) ? s : null, badS: !!s && !HASH_RE.test(s), r: r && REQ_RE.test(r) ? r : null };
}
function canonicalUrl({ p, s, r }) {
  return `${SITE_RECEIPT}#p=${p}${s ? `&s=${s}` : ""}${r ? `&r=${r}` : ""}`;
}

// ---------- states ----------
function showLoading() {
  body.setAttribute("aria-busy", "true");
  const row = (label, w) => kv(label, el("span", { class: "skel", style: `width:${w}px` }));
  show(
    el("div", { class: "receive" }, el("span", { class: "label" }, "Recipient got"), el("output", { class: "num" }, el("span", { class: "skel lg", style: "width:180px" }))),
    el("ul", { class: "kv-list mt-16" }, row("Exchange rate", 120), row("Converted", 90), row("Route", 150), row("Recipient", 110), row("Time", 110), row("Payout transaction", 140), row("Conversion transaction", 140)),
    el("span", { class: "sr-only" }, "Loading receipt…"),
  );
  body.setAttribute("aria-busy", "true");
}

function showNoHash(damaged) {
  setStatus(null);
  show(
    damaged
      ? alertBox("err", "alert", el("p", {}, "This receipt link is damaged: the payout hash in it isn't a valid transaction hash. Ask whoever sent it to share the link again."))
      : alertBox("", "info", el("p", {}, "This link doesn't include a payout, so there is no receipt to show.")),
    el("p", { class: "soft mt-16" }, "Receipts come from the agent. After each payout it prints a link to this page that carries the payout's transaction hash, and the page rebuilds the receipt from Celo. The link looks like this:"),
    el("pre", { class: "code-block mt-16" }, "receipt.html#p=<payout hash>&s=<conversion hash>"),
    el("p", { class: "soft mt-16" }, "To look at what the agent has sent so far, open its transactions. To check any single transaction for the agent's tag, use Verify."),
    el("div", { class: "row mt-24" },
      el("a", { class: "btn btn-primary", href: "transactions.html" }, "See the agent's transactions", icon("right")),
      el("a", { class: "btn btn-secondary", href: "verify.html" }, icon("shield"), "Verify a transaction")),
  );
}

function showProblem(kind, message, hash, retry) {
  const btns = [];
  if (retry) {
    const b = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("refresh"), "Try again");
    b.addEventListener("click", retry);
    btns.push(b);
  }
  if (hash) btns.push(btnLink("btn-secondary", celoscanTx(hash), "View on Celoscan", true));
  btns.push(btnLink("btn-ghost", "transactions.html", "See the agent's transactions"));
  show(alertBox(kind, "alert", ...[].concat(message)), el("div", { class: "row mt-16" }, btns));
}

function showNotPayout(tx, message, detail) {
  setStatus("Not a payout", "neutral");
  show(
    alertBox("warn", "alert", el("p", {}, message), el("p", { class: "small mt-8" }, detail)),
    el("ul", { class: "kv-list mt-16" },
      kv("From", tx.from ? addrLink(tx.from) : "—"),
      kv("To", tx.to ? addrLink(tx.to) : el("span", { class: "muted" }, "Contract creation")),
      kv("Time", el("span", { class: "num" }, tx.timestamp ? lagosTime(tx.timestamp) + " WAT" : "—")),
      kv("Transaction", el("span", { class: "tx-cell" }, txLink(tx.hash), tagBadge(tx)))),
    el("div", { class: "row mt-24" },
      el("a", { class: "btn btn-secondary btn-sm", href: `verify.html?tx=${tx.hash}` }, icon("shield"), "Check its tag on Verify"),
      btnLink("btn-secondary", celoscanTx(tx.hash), "View on Celoscan", true),
      btnLink("btn-ghost", "transactions.html", "See the agent's transactions")),
  );
}

// ---------- chain reconstruction ----------
const sum = (list) => list.reduce((a, t) => a + t.value, 0n);

/** The conversion that funded the payout: from the link (s) or the agent's latest convert before the payout. */
async function findSwap(s, payout, corridor) {
  let hash = s, source = "link";
  if (!hash) {
    source = "search";
    let next = null;
    for (let i = 0; i < 5 && !hash; i++) {
      const page = await loadTxPage(next);
      const hit = page.items.find((t) => !eq(t.hash, payout.hash) && t.status === "ok" && txKind(t) === "convert"
        && payout.blockNumber != null && Number(t.block_number) <= payout.blockNumber);
      if (hit) hash = hit.hash;
      if (!page.next) break;
      next = page.next;
    }
    if (!hash) return { missing: "No conversion by the agent was found before this payout." };
  }
  const [tx, rc] = await Promise.all([loadTxByHash(hash), loadReceipt(hash)]);
  if (!tx || !rc) return { missing: "The conversion transaction in this link wasn't found on Celo mainnet.", hash };
  const tr = decodeTransfers(rc);
  const sold = sum(tr.filter((t) => eq(t.from, AGENT) && eq(t.token, TOKENS[corridor.sell].address)));
  const bought = sum(tr.filter((t) => eq(t.to, AGENT) && eq(t.token, TOKENS[corridor.buy].address)));
  if (rc.status !== "0x1" || !sold || !bought) {
    return { missing: `The ${source === "link" ? "linked" : "agent's latest"} conversion doesn't show the agent selling ${TOKENS[corridor.sell].symbol} for ${TOKENS[corridor.buy].symbol}.`, hash, tx };
  }
  return { tx, sold: units6(sold), bought: units6(bought), source };
}

async function load() {
  const my = ++seq;
  const h = readHash();
  rateCard.hidden = true;
  actions.hidden = true;
  if (!h.p) return showNoHash(false);
  if (!HASH_RE.test(h.p)) return showNoHash(true);
  setStatus(null);
  showLoading();
  try {
    const [tx, rc] = await Promise.all([loadTxByHash(h.p), loadReceipt(h.p)]);
    if (my !== seq) return;
    if (!tx) {
      setStatus("Not found", "err");
      return showProblem("err", el("p", {}, "No transaction with this hash on Celo mainnet. Check that the link wasn't cut short, or ask whoever sent it to share it again."), h.p);
    }
    if (!rc) {
      setStatus("Pending", "warn");
      showProblem("warn", el("p", {}, "This transaction isn't confirmed yet. The receipt fills in automatically once it is."), h.p);
      await sleep(5000);
      if (my === seq) load();
      return;
    }
    if (rc.status !== "0x1") {
      setStatus("Failed", "err");
      return showProblem("err", el("p", {}, "This transaction failed on chain, so nothing was paid."), h.p);
    }
    const transfers = decodeTransfers(rc);
    const out = transfers.filter((t) => eq(t.from, AGENT) && knownToken(t.token));
    const into = transfers.filter((t) => eq(t.to, AGENT) && knownToken(t.token));
    if (!out.length) {
      return showNotPayout(tx, "This transaction is not a payout: it has no token transfer from the agent.",
        "A receipt is for a payout, where the agent sends cNGN or USD₮ to a recipient. This hash belongs to a different kind of transaction.");
    }
    if (into.length) {
      return showNotPayout(tx, "This transaction is a conversion, not a payout: the agent both sent and received tokens in it.",
        "Open the receipt link the agent printed after the payout. It carries the payout's hash.");
    }
    const pay = out[0];
    const sameLeg = out.filter((t) => eq(t.token, pay.token) && eq(t.to, pay.to));
    const amount = units6(sum(sameLeg));
    const corridor = eq(pay.token, TOKENS.cNGN.address) ? CORRIDORS["usdt-cngn"] : CORRIDORS["cngn-usdt"];

    let swap;
    try { swap = await findSwap(h.s, tx, corridor); }
    catch (e) { swap = { missing: `Couldn't load the conversion (${e?.message ?? e}).`, error: true }; }
    if (my !== seq) return;
    renderReceipt({ h, tx, pay, amount, corridor, swap });
    renderRate(canonicalUrl(h));
  } catch (e) {
    if (my !== seq) return;
    setStatus("Unavailable", "err");
    showProblem("err", el("p", {}, `Could not reach Celo's RPC (${e?.message ?? e}). Check your connection and try again, or open the transaction on Celoscan.`), h.p, load);
  }
}

function renderReceipt({ h, tx, pay, amount, corridor, swap }) {
  const isNaira = corridor.buy === "cNGN";
  const amountText = isNaira ? naira(amount) : usd(amount);
  const time = tx.timestamp ? lagosTime(tx.timestamp) + " WAT" : "—";
  let rateText = null, convertedText = null;
  if (!swap.missing) {
    const ngnPerUsd = isNaira ? swap.bought / swap.sold : swap.sold / swap.bought;
    rateText = `1 USD₮ = ${naira(ngnPerUsd)}`;
    convertedText = `${num2.format(swap.sold)} ${TOKENS[corridor.sell].symbol} → ${num2.format(swap.bought)} ${TOKENS[corridor.buy].symbol}`;
  }
  const missing = () => el("span", { class: "muted" }, "—");

  setStatus("Paid", "ok");
  const nodes = [
    el("div", { class: "receive" },
      el("span", { class: "label" }, "Recipient got"),
      el("output", { class: "num" }, amountText),
      el("p", { class: "micro" }, isNaira ? "Paid as cNGN on Celo, redeemable for naira" : "Paid as USD₮ on Celo")),
    el("ul", { class: "kv-list mt-16" },
      kv("Exchange rate", rateText ? el("span", { class: "num" }, rateText) : missing()),
      kv("Converted", convertedText ? el("span", { class: "num" }, convertedText) : missing()),
      kv("Route", `${corridor.label} on Textile FX`),
      kv("Recipient", addrLink(pay.to)),
      kv("Time", el("span", { class: "num" }, time)),
      h.r ? kv("Payment request", el("span", { class: "mono" }, h.r)) : null,
      kv("Network", "Celo mainnet"),
      kv("Payout transaction", el("span", { class: "tx-cell" }, txLink(tx.hash), tagBadge(tx))),
      kv("Conversion transaction", swap.tx ? el("span", { class: "tx-cell" }, txLink(swap.tx.hash), tagBadge(swap.tx)) : swap.hash ? txLink(swap.hash) : missing())),
  ];
  if (swap.missing) {
    nodes.push(alertBox("warn", "info", el("p", { class: "small" }, swap.missing, " The payout above is confirmed; only the rate and converted amount can't be shown.")));
    nodes.at(-1).classList.add("mt-16");
  } else if (swap.source === "search") {
    nodes.push(el("p", { class: "small muted mt-16" }, "This link doesn't name the conversion, so the receipt uses the agent's latest conversion before the payout."));
  }
  if (h.badS) nodes.push(el("p", { class: "small muted mt-8" }, "The conversion hash in this link was damaged and has been ignored."));
  show(...nodes);

  shareUrl = canonicalUrl(h);
  const summary = `Payout receipt: ${amountText} paid to ${short(pay.to)} on ${time}`
    + (rateText ? `, converted ${convertedText} on Textile FX (${rateText})` : "")
    + `. Check it on Celo: ${shareUrl}`;
  shareWa.href = "https://wa.me/?text=" + encodeURIComponent(summary);
  actions.hidden = false;
}

// ---------- rate this payout ----------
let account = null;
let rateUrl = "";
let stars = 0;
let rateSeq = 0;

function renderRate(url) {
  rateUrl = url;
  rateCard.hidden = false;
  const intro = el("p", { class: "soft small" }, "Paid through this agent? Rate the payout on the agent's public ERC-8004 reputation record. The rating is a transaction from your own wallet, which you approve there.");
  const eth = window.ethereum;
  if (!eth) {
    rateBody.replaceChildren(intro,
      alertBox("", "info", el("p", {}, "No wallet found in this browser. To rate, open this page in a wallet's built-in browser, such as MiniPay or MetaMask mobile: copy the link, then paste it into the wallet's browser.")),
      el("div", { class: "row" }, el("button", { class: "btn btn-secondary btn-sm", type: "button", dataset: { copy: url, copyLabel: "Link copied" } }, icon("copy"), "Copy link")));
    return;
  }
  if (account) return renderRateForm();
  const connect = el("button", { class: "btn btn-primary", type: "button" }, "Connect wallet");
  const msg = el("div", { "aria-live": "polite" });
  connect.addEventListener("click", async () => {
    connect.disabled = true;
    msg.replaceChildren();
    try {
      const accs = await eth.request({ method: "eth_requestAccounts" });
      if (!accs?.length) throw new Error("The wallet returned no account.");
      account = accs[0];
      renderRateForm();
    } catch (e) {
      connect.disabled = false;
      msg.replaceChildren(alertBox("err", "alert", el("p", {}, explain(e))));
    }
  });
  rateBody.replaceChildren(intro, el("div", { class: "row" }, connect), msg);
}

async function isVerifiedPayer(addr) {
  let params = null;
  for (let i = 0; i < 5; i++) {
    const qs = new URLSearchParams({ type: "ERC-20", filter: "to", ...(params ?? {}) });
    const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/token-transfers?${qs}`);
    for (const t of d.items ?? []) {
      if (eq(t.from?.hash, addr) && knownToken(t.token?.address_hash ?? t.token?.address)) return true;
    }
    if (!d.next_page_params) return false;
    params = d.next_page_params;
  }
  return false;
}

function renderRateForm() {
  const my = ++rateSeq;
  stars = 0;
  const payerCell = el("span", {}, el("span", { class: "skel", style: "width:90px" }));
  const payerNote = el("div", { "aria-live": "polite" });
  const ownerNote = el("div", { "aria-live": "polite" });
  const group = el("div", { class: "segmented stars", role: "group", "aria-labelledby": "stars-label", style: "justify-self:start" });
  const starHint = el("p", { class: "hint", id: "stars-hint", "aria-live": "polite" }, "Pick 1 to 5 stars.");
  const send = el("button", { class: "btn btn-primary", type: "button", disabled: true }, "Send rating");
  const result = el("div", { "aria-live": "polite" });
  for (let n = 1; n <= 5; n++) {
    const b = el("button", { type: "button", "aria-pressed": "false", "aria-label": `${n} star${n > 1 ? "s" : ""}`, dataset: { n: String(n) } }, `${n} ★`);
    b.addEventListener("click", () => {
      stars = n;
      for (const x of group.children) x.setAttribute("aria-pressed", String(x === b));
      starHint.textContent = `${"★".repeat(n)}${"☆".repeat(5 - n)}  ${n} out of 5`;
      if (!send.dataset.blocked) send.disabled = false;
    });
    group.append(b);
  }
  send.addEventListener("click", () => submit(send, result));

  rateBody.replaceChildren(
    el("ul", { class: "kv-list" },
      kv("Wallet", addrLink(account)),
      kv("Payer check", payerCell)),
    payerNote,
    ownerNote,
    el("div", { class: "field" },
      el("span", { class: "label", id: "stars-label" }, "Your rating"),
      group,
      starHint),
    el("div", { class: "row" }, send),
    el("p", { class: "small muted" }, "Your wallet asks you to approve one transaction on Celo, which costs a small network fee. The rating links back to this receipt."),
    result,
  );

  isVerifiedPayer(account).then((ok) => {
    if (my !== rateSeq) return;
    payerCell.replaceChildren(badge(ok ? "Verified payer" : "Unverified", ok ? "ok" : "neutral"));
    payerNote.replaceChildren(el("p", { class: "small muted" }, ok
      ? "This wallet has sent USD₮ or cNGN to the agent, so its rating shows as from a verified payer. That's our own check against deposits; the registry itself can't check it."
      : "This wallet has never sent USD₮ or cNGN to the agent, so its rating will show as \"unverified\". If you paid from another wallet, connect that one instead."));
  }).catch(() => {
    if (my !== rateSeq) return;
    payerCell.replaceChildren(el("span", { class: "muted" }, "—"));
    payerNote.replaceChildren(el("p", { class: "small muted" }, "Couldn't check this wallet's deposits right now. You can still send a rating; the Agent page re-checks it."));
  });

  loadIdentity().then((id) => {
    if (my !== rateSeq) return;
    if (eq(account, id.owner) || eq(account, AGENT)) {
      send.dataset.blocked = "1";
      send.disabled = true;
      ownerNote.replaceChildren(alertBox("err", "alert", el("p", {}, "This wallet owns the agent. The reputation registry rejects ratings from an agent's owner or operators, so it can't rate its own payouts. Connect the wallet that paid.")));
    }
  }).catch(() => { /* the contract still rejects self-feedback; submit() explains it */ });
}

function explain(e) {
  const m = String(e?.data?.message ?? e?.message ?? e ?? "");
  if (e?.code === 4001 || /user (rejected|denied|cancel)|rejected by user|denied transaction/i.test(m)) return "You cancelled in your wallet. Nothing was sent.";
  if (/self-feedback|self feedback|owner|operator/i.test(m)) return "The reputation registry rejected this rating because the wallet owns or operates the agent, and agents can't rate themselves. Connect the wallet that paid.";
  if (/insufficient funds/i.test(m)) return "This wallet doesn't have enough CELO for the network fee. Add a little CELO and try again.";
  if (e?.code === -32002) return "Your wallet already has a request open. Switch to it and finish or cancel that first.";
  return `The wallet reported: ${m || "unknown error"}. Try again, and check the wallet is on Celo mainnet.`;
}

async function ensureCelo(eth) {
  const id = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (id === CELO_CHAIN) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CELO_CHAIN }] });
  } catch (e) {
    const unknown = e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not been added|unknown chain/i.test(String(e?.message));
    if (!unknown) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [{
      chainId: CELO_CHAIN, chainName: "Celo", nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
      rpcUrls: ["https://forno.celo.org"], blockExplorerUrls: ["https://celoscan.io"],
    }] });
  }
  const now = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (now !== CELO_CHAIN) throw new Error("The wallet is still on another network. Switch it to Celo and try again.");
}

async function submit(send, result) {
  const eth = window.ethereum;
  if (!eth || !account || !(stars >= 1 && stars <= 5)) return;
  const from = account;
  const label = send.textContent;
  send.disabled = true;
  send.textContent = "Check your wallet…";
  result.replaceChildren();
  try {
    await ensureCelo(eth);
    const data = encodeCall(SEL.giveFeedback,
      ["uint256", "int128", "uint8", "string", "string", "string", "string", "bytes32"],
      [AGENT_ID, stars * 20, 0, "starred", "payout", rateUrl, "", "0x" + "00".repeat(32)]) + tagSuffix();
    // Dry-run on Forno first, so a registry rejection is explained before the wallet asks for a signature.
    try { await rpc("eth_call", [{ from, to: REPUTATION, data }, "latest"]); }
    catch (e) { if (/revert/i.test(String(e?.message))) throw e; /* RPC unreachable: let the wallet estimate */ }
    const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: REPUTATION, data }] });
    send.textContent = "Rating sent";
    result.replaceChildren(alertBox("", "info", el("p", {}, "Sent. Waiting for Celo to confirm it… ", txLink(hash))));
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      let rc = null;
      try { rc = await loadReceipt(hash); } catch { continue; }
      if (!rc) continue;
      if (rc.status === "0x1") {
        result.replaceChildren(alertBox("", "check",
          el("p", {}, `Your ${stars}-star rating is on chain. `, txLink(hash)),
          el("p", { class: "small mt-8" }, el("a", { class: "link", href: "agent.html" }, "See it with the agent's reviews"), ".")));
        return;
      }
      result.replaceChildren(alertBox("err", "alert", el("p", {}, "The rating transaction failed on chain, so nothing was recorded. ", txLink(hash))));
      send.disabled = false; send.textContent = label;
      return;
    }
    result.replaceChildren(alertBox("warn", "alert", el("p", {}, "Still not confirmed after three minutes. It may yet go through: check it on Celoscan. ", txLink(hash))));
  } catch (e) {
    result.replaceChildren(alertBox("err", "alert", el("p", {}, explain(e))));
    send.disabled = !!send.dataset.blocked;
    send.textContent = label;
  }
}

if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", (accs) => {
    if (!account) return;
    account = accs?.[0] ?? null;
    if (!rateCard.hidden) renderRate(rateUrl);
  });
}

addEventListener("hashchange", load);
load();
