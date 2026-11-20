import { initChrome, $$ } from "../assets/core.js";

// Copy buttons use data-copy, handled by initChrome. The only page behaviour here is
// marking the "On this page" link for the section currently in view.
initChrome();

const links = $$(".toc a");
const sections = links.map((a) => document.getElementById(a.getAttribute("href").slice(1))).filter(Boolean);

function mark(id) {
  for (const a of links) {
    if (a.getAttribute("href") === `#${id}`) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}

if ("IntersectionObserver" in window && sections.length) {
  const visible = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
    const first = sections.find((s) => visible.has(s.id));
    if (first) mark(first.id);
  }, { rootMargin: "-96px 0px -55% 0px" });
  sections.forEach((s) => io.observe(s));
}
