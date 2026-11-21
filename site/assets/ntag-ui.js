// nTag UI pieces shared by the landing, account and tag pages: the tag card (tilt + holographic sheen), the live
// "find an nTag" search, availability wording, tag suggestions, the QR code and transaction confirmation polling.
// The top level stays free of window/document access so the pure helpers can be tested in Node.
import {
  el, icon, short, ntagUrl, normalizeNtag, ntagError, ntagAvailability, resolveNtags, ownerOf, loadNtagOps, loadReceipt,
  lagos,
} from "./core.js";
import { avatar } from "./session.js";

const SVG_NS = "http://www.w3.org/2000/svg";
export const sameAddr = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** An Error whose message is already plain language (shown as is, not passed through explainWalletError). */
export const plainError = (message, extra = {}) => Object.assign(new Error(message), { plain: true }, extra);

export function alertBox(kind, iconName, ...children) {
  return el("div", { class: `alert${kind ? " " + kind : ""}`, role: kind === "err" ? "alert" : null }, icon(iconName), el("div", {}, ...children));
}

// ---------- pure helpers (tested in test/ntag-ui.test.mjs) ----------
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "Nov 2026" from unix seconds, in Lagos time. */
export const monthYear = (sec) => lagos(sec * 1000, { month: "short", year: "numeric" });
/** "21 Dec 2026" from unix seconds, in Lagos time. */
export const dayMonthYear = (sec) => lagos(sec * 1000, { day: "numeric", month: "short", year: "numeric" });

/**
 * The sentence shown for a tag's availability. kind = ntagAvailability(...) result. Returns { text, tone } where tone
 * is "ok" | "warn" | "err" | "muted". `lock` = state.locks.get(tag), `owner` = ownerOf(state, tag).
 */
export function availabilityMessage(tag, kind, { owner = null, lock = null } = {}) {
  switch (kind) {
    case "free": return { text: `@${tag} is available.`, tone: "ok" };
    case "yours": return { text: `@${tag} is already yours.`, tone: "ok" };
    case "taken": return { text: `@${tag} is taken${owner?.owner ? ` by ${short(owner.owner)}` : ""}.`, tone: "err" };
    case "reserved": return { text: `@${tag} is reserved, so nobody can claim it.`, tone: "warn" };
    case "locked": return { text: `@${tag} was released recently. Until ${lock ? dayMonthYear(lock.until) : "the 30-day hold ends"}, only its previous owner can claim it.`, tone: "warn" };
    case "invalid": return { text: `${cap(ntagError(tag) ?? "not a valid tag")}.`, tone: "err" };
    default: return { text: "", tone: "muted" };
  }
}

/** Live rule checklist for the tag input: [{ id, label, ok (true/false/null when empty) }]. */
export function ntagRules(t) {
  const v = String(t ?? "");
  const has = v.length > 0;
  return [
    { id: "len", label: "3 to 20 characters", ok: has ? v.length >= 3 && v.length <= 20 : null },
    { id: "chars", label: "a–z, 0–9 and _", ok: has ? /^[a-z0-9_]+$/.test(v) : null },
    { id: "start", label: "Starts with a letter", ok: has ? /^[a-z]/.test(v) : null },
    { id: "under", label: "No __ and no _ at the end", ok: has ? !v.includes("__") && !v.endsWith("_") : null },
  ];
}

/** Turns what someone typed into tag form as they type: lower-case, no leading @, no spaces, at most 20 characters. */
export const cleanTagInput = (s) => normalizeNtag(s).replace(/\s+/g, "").slice(0, 20);

/**
 * Up to n free tags close to `base` (and the display name, if any), for when the one asked for is taken.
 * Every suggestion passes the tag rules and is "free" in `state` for `address`.
 */
export function suggestNtags(base, name, state, address, n = 3) {
  let b = String(base ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").replace(/_+/g, "_").replace(/_+$/, "");
  if (!/^[a-z]/.test(b)) b = "n" + b;
  b = b.slice(0, 15).replace(/_+$/, "");
  if (b.length < 2) b = (b + "pay").slice(0, 5);
  const words = String(name ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/).filter((w) => /^[a-z]/.test(w));
  const first = words[0], last = words.length > 1 ? words[words.length - 1] : null;
  const cands = [];
  if (last && last !== b) cands.push(b + last, b + "_" + last, b + "_" + last[0]);
  if (first && first !== b) cands.push(first + "_" + b, first + b);
  cands.push(b + "_ng", b + "ng", "the" + b, b + "01", b + "_pay", b + "hq", b + "x", b + "_07", b + "_9ja", "real" + b);
  for (let i = 2; i <= 99; i++) cands.push(b + String(i).padStart(2, "0"));
  const out = [];
  for (const c of cands) {
    const t = c.slice(0, 20).replace(/_+$/, "");
    if (out.includes(t) || ntagError(t)) continue;
    if (ntagAvailability(state, t, address) !== "free") continue;
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

/** "Good morning" / "Good afternoon" / "Good evening", by the hour in Lagos. */
export function greeting(date = new Date()) {
  const h = Number(lagos(date, { hour: "numeric", hourCycle: "h23" }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** The WhatsApp share link for a tag. */
export function whatsappUrl(tag, url = ntagUrl(tag)) {
  return "https://wa.me/?text=" + encodeURIComponent(`You can pay me in dollars or naira on Celo with my nTag @${tag}: ${url}`);
}

// ---------- the ring mark ----------
export function ringMark(cls = "ntag-ring") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("aria-hidden", "true");
  const ring = (cx, cy, color) => {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", "9.2");
    c.setAttribute("fill", "none"); c.setAttribute("stroke", color); c.setAttribute("stroke-width", "2.6");
    return c;
  };
  svg.append(ring(12.6, 19.4, "#6ff0b0"), ring(19.4, 12.6, "#fcff52"));
  return svg;
}

// ---------- the nTag card ----------
/**
 * Builds the card. props: { tag, name, address, since (sec), kind: "live" | "preview" | "ghost", stamp (text),
 * as: "div" | "button" | "a", href, label (accessible name) }. Returns the element; call card.update(props) to change it.
 */
export function ntagCard(props = {}) {
  const as = props.as ?? "div";
  const handle = el("span", { class: "ntag-handle" });
  const name = el("span", { class: "ntag-name" });
  const addr = el("span", { class: "ntag-addr" });
  const since = el("span", { class: "ntag-since" });
  const stampText = el("span", {});
  const stamp = el("span", { class: "ntag-stamp", "aria-hidden": "true" }, icon("check"), stampText);
  const front = el("div", { class: "ntag-face ntag-front" },
    el("span", { class: "ntag-guilloche" }),
    el("div", { class: "ntag-top" }, el("span", { class: "ntag-brand" }, ringMark(), "nTag"), el("span", { class: "ntag-net" }, "Celo")),
    el("div", { class: "ntag-main" }, handle, name),
    el("div", { class: "ntag-bottom" }, addr, since),
    el("span", { class: "ntag-sheen" }), el("span", { class: "ntag-glare" }));
  const back = el("div", { class: "ntag-face ntag-back", "aria-hidden": "true" },
    el("span", { class: "ntag-guilloche" }), ringMark("ntag-ring lg"), el("span", { class: "ntag-back-line" }, "Pay by name on Celo"),
    el("span", { class: "ntag-sheen" }));
  const attrs = { class: "ntag-card" };
  if (as === "button") attrs.type = "button";
  if (as === "a") attrs.href = props.href;
  const card = el(as, attrs, el("div", { class: "ntag-tilt" }, el("div", { class: "ntag-flip" }, front, back), stamp));
  if (as === "div") card.setAttribute("aria-hidden", "true"); // decorative: the same facts are on the page as text

  card.update = (p = {}) => {
    Object.assign(props, p);
    const kind = props.kind ?? "live";
    const tag = props.tag || "";
    const shown = tag || "yourtag";
    card.classList.toggle("is-preview", kind === "preview");
    card.classList.toggle("is-ghost", kind === "ghost");
    card.style.setProperty("--len", String(shown.length + 1));
    handle.classList.toggle("is-placeholder", !tag);
    handle.replaceChildren(el("span", { class: "ntag-at" }, "@"), shown);
    const nm = (props.name ?? "").trim();
    name.classList.toggle("is-placeholder", !nm);
    name.textContent = nm || (kind === "preview" ? "Display name (optional)" : kind === "ghost" ? "Not claimed yet" : "");
    addr.textContent = props.address ? short(props.address) : "0x····…····";
    since.textContent = props.since ? `Since ${monthYear(props.since)}` : kind === "preview" ? "Preview" : "";
    stampText.textContent = props.stamp ?? "";
    card.classList.toggle("is-stamped", Boolean(props.stamp));
    if (as !== "div") card.setAttribute("aria-label", props.label ?? `nTag @${shown}${nm ? ", " + nm : ""}`);
    return card;
  };
  card.update();
  if (props.tilt !== false) enableTilt(card);
  return card;
}

/** Pointer-following tilt (at most 8 degrees) and sheen, via CSS custom properties. Off with reduced motion and on touch. */
export function enableTilt(card) {
  if (reducedMotion()) return;
  let raf = 0, last = null;
  const apply = () => {
    raf = 0;
    if (!last) return;
    const r = card.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.min(1, Math.max(0, (last.x - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (last.y - r.top) / r.height));
    card.style.setProperty("--rx", ((0.5 - y) * 16).toFixed(2) + "deg");
    card.style.setProperty("--ry", ((x - 0.5) * 16).toFixed(2) + "deg");
    card.style.setProperty("--mx", (x * 100).toFixed(1) + "%");
    card.style.setProperty("--my", (y * 100).toFixed(1) + "%");
    card.style.setProperty("--hyp", Math.min(1, Math.hypot(x - 0.5, y - 0.5) * 2).toFixed(3));
  };
  card.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    last = { x: e.clientX, y: e.clientY };
    card.classList.add("is-active");
    if (!raf) raf = requestAnimationFrame(apply);
  });
  card.addEventListener("pointerleave", () => {
    last = null;
    card.classList.remove("is-active");
    for (const [k, v] of [["--rx", "0deg"], ["--ry", "0deg"], ["--mx", "32%"], ["--my", "18%"], ["--hyp", "0"]]) card.style.setProperty(k, v);
  });
}

/** The claim moment: the card flips in, the stamp lands, a ring of light. Resolves when it has played. */
export function revealCard(card, stamp = "Yours") {
  card.update({ stamp });
  card.classList.remove("is-revealing");
  void card.offsetWidth; // restart the animation
  card.classList.add("is-revealing");
  const ms = reducedMotion() ? 300 : 2400;
  return sleep(ms).then(() => card.classList.remove("is-revealing"));
}

/** A card on its "stage" (floor shadow + glow), with an optional caption. */
export const stage = (card, caption) => el("div", { class: "ntag-stage" }, card, caption ? el("p", { class: "ntag-caption" }, caption) : null);

// ---------- QR code ----------
/** QR as DOM SVG (no innerHTML, no data: URLs, works under the CSP). Same drawing as get-paid.js. */
export function renderQr(box, text, label = "QR code of the link") {
  const lib = globalThis.qrcode;
  if (typeof lib !== "function") {
    box.replaceChildren(el("p", { class: "small muted" }, "The QR code couldn't be drawn. Copy the link instead."));
    return;
  }
  const qr = lib(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), quiet = 4, size = n + quiet * 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", size); bg.setAttribute("height", size); bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d); path.setAttribute("fill", "#07120c");
  svg.append(bg, path);
  box.replaceChildren(svg);
}

/** Link field + Copy, WhatsApp, Open and a QR toggle for a tag. */
export function shareBlock(tag, { openLabel = "Open pay page" } = {}) {
  const url = ntagUrl(tag);
  const qrBox = el("div", { class: "nt-qr", id: `qr-${tag}`, hidden: true });
  const qrBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-expanded": "false", "aria-controls": `qr-${tag}` }, icon("scan"), "Show QR code");
  qrBtn.addEventListener("click", () => {
    const show = qrBox.hidden;
    if (show && !qrBox.firstChild) renderQr(qrBox, url, `QR code for the @${tag} pay page`);
    qrBox.hidden = !show;
    qrBtn.setAttribute("aria-expanded", String(show));
    qrBtn.lastChild.textContent = show ? "Hide QR code" : "Show QR code";
  });
  return el("div", { class: "nt-share" },
    el("div", { class: "nt-linkfield" }, el("span", { title: url }, url.replace(/^https?:\/\//, "")),
      el("button", { class: "btn btn-primary btn-sm", type: "button", dataset: { copy: url, copyLabel: "Link copied" } }, icon("copy"), "Copy link")),
    el("div", { class: "row" },
      el("a", { class: "btn btn-wa btn-sm", href: whatsappUrl(tag, url), target: "_blank", rel: "noopener" }, "Share on WhatsApp"),
      el("a", { class: "btn btn-secondary btn-sm", href: url }, icon("right"), openLabel),
      qrBtn),
    qrBox);
}

// ---------- transactions ----------
/**
 * Polls for a receipt. Resolves the receipt when it succeeded, null if it is still pending after `tries`.
 * Throws a plain error if it failed onchain.
 */
export async function waitForReceipt(hash, { tries = 72, ms = 2500, failMessage = "The transaction failed on Celo. Only the network fee was spent." } = {}) {
  for (let i = 0; i < tries; i++) {
    await sleep(ms);
    let rc = null;
    try { rc = await loadReceipt(hash); } catch { continue; }
    if (!rc) continue;
    if (rc.status === "0x1") return rc;
    throw plainError(failMessage, { hash });
  }
  return null;
}

// ---------- find an nTag (landing, tag page) ----------
/**
 * Live search: type @ada, see who owns it (or that it's free), then "Pay @ada". Returns the element.
 * opts: { id, label, value, address (the signed-in wallet, or a function returning it, for "that's you") }
 */
export function ntagFinder(opts = {}) {
  const id = opts.id ?? "find-tag";
  const input = el("input", {
    id, type: "text", placeholder: "ada", autocomplete: "off", autocapitalize: "none", spellcheck: "false",
    maxlength: "21", enterkeyhint: "go", "aria-describedby": `${id}-out`,
  });
  const out = el("div", { class: "nt-find-result", id: `${id}-out`, "aria-live": "polite" });
  let timer = null, seq = 0, best = null;
  const me = () => (typeof opts.address === "function" ? opts.address() : opts.address);
  const hit = (cls, av, title, sub, action) => el("div", { class: `nt-hit ${cls}` }, av, el("div", { class: "nt-hit-text" }, el("b", {}, title), el("span", {}, sub)), action);
  const run = async () => {
    const my = ++seq;
    const t = cleanTagInput(input.value);
    best = null;
    if (!t) { out.replaceChildren(); return; }
    const err = ntagError(t);
    if (err && !/reserved/.test(err)) { out.replaceChildren(el("p", { class: "small muted" }, `${cap(err)}.`)); return; }
    out.replaceChildren(el("p", { class: "small muted", role: "status" }, `Looking up @${t}…`));
    let state;
    try { state = resolveNtags(await loadNtagOps()); } catch {
      if (my !== seq) return;
      const retry = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("refresh"), "Try again");
      retry.addEventListener("click", run);
      out.replaceChildren(el("div", { class: "row" }, el("p", { class: "small muted" }, "Couldn't reach the Celo explorer."), retry));
      return;
    }
    if (my !== seq) return;
    const entry = ownerOf(state, t);
    const kind = ntagAvailability(state, t, me());
    if (entry) {
      const url = ntagUrl(t);
      best = url;
      const mine = Boolean(me()) && sameAddr(entry.owner, me());
      out.replaceChildren(hit("owned", avatar(entry.owner), "@" + t, `${entry.name ? entry.name + " · " : ""}${short(entry.owner)}`,
        el("a", { class: "btn btn-primary btn-sm", href: mine ? "account.html" : url }, mine ? "That's you" : `Pay @${t}`, icon("right"))));
      return;
    }
    if (kind === "reserved") {
      out.replaceChildren(hit("none", el("span", { class: "np-avatar" }, icon("lock")), "@" + t, "Reserved. Nobody can claim it.", null));
      return;
    }
    const m = availabilityMessage(t, kind, { lock: state.locks.get(t) });
    out.replaceChildren(hit(kind === "free" ? "free" : "none", el("span", { class: "np-avatar" }, icon(kind === "free" ? "check" : "lock")), "@" + t,
      kind === "free" ? "Nobody has this tag yet." : m.text,
      kind === "free" ? el("a", { class: "btn btn-secondary btn-sm", href: `account.html#claim=${t}` }, "Claim it") : null));
  };
  input.addEventListener("input", () => {
    const clean = cleanTagInput(input.value);
    if (clean !== input.value) {
      const atEnd = input.selectionStart === input.value.length;
      input.value = clean;
      if (atEnd) input.setSelectionRange(clean.length, clean.length);
    }
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && best) location.href = best; });
  if (opts.value) { input.value = cleanTagInput(opts.value); setTimeout(run, 0); }
  return el("div", { class: "nt-find", role: "search" },
    el("label", { class: "nt-find-label", for: id }, icon("search"), opts.label ?? "Find an nTag"),
    el("div", { class: "nt-taginput sm" }, el("span", { class: "nt-at", "aria-hidden": "true" }, "@"), input),
    out);
}
