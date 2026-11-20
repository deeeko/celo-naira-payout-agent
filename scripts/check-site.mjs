// Static checks for the live site. Run in CI before every deploy: node scripts/check-site.mjs
// Fails (exit 1) on: broken internal links/assets, pages missing the CSP or the design system,
// page scripts that don't parse, or JSON/SVG assets that are malformed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SITE = path.resolve("site");
const errors = [];
const fail = (msg) => errors.push(msg);

const pages = fs.readdirSync(SITE).filter((f) => f.endsWith(".html"));
if (!pages.includes("index.html")) fail("site/index.html is missing");

for (const page of pages) {
  const html = fs.readFileSync(path.join(SITE, page), "utf8");
  const isFallback = page === "404.html"; // served for any missing path, so it uses absolute URLs

  if (!/http-equiv="Content-Security-Policy"/.test(html)) fail(`${page}: missing Content-Security-Policy meta`);
  if (!/assets\/styles\.css/.test(html)) fail(`${page}: does not load assets/styles.css`);
  if (!/<title>[^<]+<\/title>/.test(html)) fail(`${page}: missing <title>`);
  if (!isFallback && !/name="viewport"/.test(html)) fail(`${page}: missing viewport meta`);
  if (/\son[a-z]+="/i.test(html)) fail(`${page}: inline event handler found (blocked by CSP)`);

  // every local href/src must exist
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    let ref = m[1];
    if (/^(https?:|mailto:|tel:|data:|#|ethereum:)/i.test(ref)) continue;
    ref = ref.split("#")[0].split("?")[0];
    if (!ref) continue;
    if (ref.startsWith("/celo-naira-payout-agent/")) ref = ref.slice("/celo-naira-payout-agent/".length) || "index.html";
    else if (ref.startsWith("/")) { fail(`${page}: root-absolute link "${m[1]}" will break on GitHub Pages`); continue; }
    if (ref.endsWith("/")) ref += "index.html";
    if (ref === "rate.json") continue; // generated at deploy time
    if (!fs.existsSync(path.join(SITE, ref))) fail(`${page}: broken link/asset "${m[1]}"`);
  }

  // in-page anchors used by the sidebar/nav (#id) must exist on that page
  for (const m of html.matchAll(/\shref="#([A-Za-z][\w-]*)"/g)) {
    if (!new RegExp(`\\sid="${m[1]}"`).test(html)) fail(`${page}: anchor #${m[1]} has no matching id`);
  }
}

// every script parses
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
for (const file of walk(SITE).filter((f) => f.endsWith(".js") && !f.includes(`${path.sep}_spec${path.sep}`))) {
  try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); }
  catch (e) { fail(`${path.relative(".", file)}: ${String(e.stderr || e.message).split("\n").find((l) => l.trim()) || "syntax error"}`); }
}
for (const file of walk(SITE).filter((f) => f.endsWith(".svg"))) {
  const svg = fs.readFileSync(file, "utf8");
  if (!/^<svg[\s>]/.test(svg.trim()) || !svg.trim().endsWith("</svg>")) fail(`${path.relative(".", file)}: not a well-formed SVG document`);
}
for (const file of walk(SITE).filter((f) => f.endsWith(".json") && !f.endsWith("rate.json"))) {
  try { JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail(`${path.relative(".", file)}: invalid JSON`); }
}

if (errors.length) {
  console.error(`Site check failed (${errors.length}):\n` + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log(`Site check passed: ${pages.length} pages, all local links, assets and scripts OK.`);
