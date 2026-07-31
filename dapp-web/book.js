const $ = selector => document.querySelector(selector);
const toc = $("#book-toc");
const toggle = $("#toc-toggle");
const scrim = $("#toc-scrim");

function setToc(open) {
  toc.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", String(open));
  scrim.hidden = !open;
}

toggle.addEventListener("click", () => setToc(!toc.classList.contains("open")));
$("#toc-close").addEventListener("click", () => setToc(false));
scrim.addEventListener("click", () => setToc(false));
toc.addEventListener("click", event => {
  if (event.target.closest("a") && window.innerWidth <= 900) setToc(false);
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function highlightLine(raw) {
  if (/^\s*(#|\/\/)/.test(raw)) return `<span class="tok-comment">${escapeHtml(raw)}</span>`;

  let line = escapeHtml(raw);
  const strings = [];
  line = line.replace(/(".*?"|'.*?')/g, value => {
    strings.push(value);
    return `\u0000${strings.length - 1}\u0000`;
  });
  line = line.replace(/^(\s*)(:[a-z_][a-z0-9_]*|LABEL\s+[a-z_][a-z0-9_]*)/i, "$1<span class=\"tok-label\">$2</span>");
  line = line.replace(/^(\s*)([A-Z][A-Z0-9_]*)/i, "$1<span class=\"tok-command\">$2</span>");
  line = line.replace(/(\$[a-z_][a-z0-9_]*(?:\[[^\]]+\])?)/gi, "<span class=\"tok-var\">$1</span>");
  line = line.replace(/(^|[\s([])([+-]?\d+(?:\.\d+)?)(?=$|[\s,)\]])/g, "$1<span class=\"tok-number\">$2</span>");
  line = line.replace(/\u0000(\d+)\u0000/g, (_, index) => `<span class="tok-string">${strings[Number(index)]}</span>`);
  return line;
}

for (const block of document.querySelectorAll(".book-content pre code")) {
  const source = block.textContent.replace(/\n$/, "");
  block.innerHTML = source.split("\n").map(highlightLine).join("\n");

  const button = document.createElement("button");
  button.className = "copy-code";
  button.type = "button";
  button.textContent = "COPY";
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(source);
    button.textContent = "COPIED";
    setTimeout(() => {
      button.textContent = "COPY";
    }, 1200);
  });
  block.parentElement.append(button);
}

const tocLinks = new Map(
  [...document.querySelectorAll(".toc-list a")].map(link => [
    link.getAttribute("href").slice(1),
    link
  ])
);

const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    for (const link of tocLinks.values()) link.classList.remove("active");
    tocLinks.get(entry.target.id)?.classList.add("active");
  }
}, { rootMargin: "-15% 0px -75% 0px" });

for (const heading of document.querySelectorAll(".book-content h2, .book-content h3")) {
  observer.observe(heading);
}

function alignFragment() {
  if (!window.location.hash) return;
  const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
  if (!target) return;
  const top = target.getBoundingClientRect().top + window.scrollY - 86;
  window.scrollTo({ top, behavior: "instant" });
}

alignFragment();
document.fonts.ready.then(() => requestAnimationFrame(alignFragment));
window.addEventListener("load", alignFragment);
window.addEventListener("hashchange", alignFragment);
