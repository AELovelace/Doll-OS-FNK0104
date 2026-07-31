import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourcePath = path.join(repoRoot, "docs", "DAPP-BOOK.md");
const templatePath = path.join(repoRoot, "dapp-web", "book-template.html");
const outputPath = path.join(repoRoot, "dapp-web", "book.html");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(source) {
  const codeSpans = [];
  let text = escapeHtml(source);

  text = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(])\*([^*]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
  return text;
}

function makeSlug(title, used) {
  const base = title
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "") || "section";
  const count = used.get(base) || 0;
  used.set(base, count + 1);
  return count ? `${base}-${count + 1}` : base;
}

function markdownToHtml(markdown) {
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const html = [];
  const headings = [];
  const usedSlugs = new Map();
  let paragraph = [];
  let listType = null;
  let inCode = false;
  let codeLanguage = "text";
  let codeLines = [];

  function closeParagraph() {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(" ").trim())}</p>`);
    paragraph = [];
  }

  function closeList() {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  }

  function closeBlocks() {
    closeParagraph();
    closeList();
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (inCode) {
      if (/^```/.test(line)) {
        html.push(`<pre><code class="language-${escapeHtml(codeLanguage)}">${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        inCode = false;
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = line.match(/^```(.*)$/);
    if (fence) {
      closeBlocks();
      inCode = true;
      codeLanguage = fence[1].trim() || "text";
      continue;
    }

    if (index === 0 && /^# /.test(line)) continue;
    if (index === 2 && line === "*Learning to program the DOLL-OS shell, one tiny executable at a time.*") continue;

    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      closeBlocks();
      const depth = heading[1].length;
      const title = heading[2].trim();
      const slug = makeSlug(title, usedSlugs);
      headings.push({ depth, title, slug });
      html.push(`<h${depth} id="${slug}">${inlineMarkdown(title)}</h${depth}>`);
      continue;
    }

    if (/^\s*---\s*$/.test(line)) {
      closeBlocks();
      html.push("<hr>");
      continue;
    }

    const ordered = line.match(/^\s*(\d+)\.\s+(.+)$/);
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (ordered || unordered) {
      closeParagraph();
      const wanted = ordered ? "ol" : "ul";
      if (listType !== wanted) {
        closeList();
        listType = wanted;
        html.push(`<${listType}>`);
      }

      let item = ordered ? ordered[2] : unordered[1];
      while (index + 1 < lines.length && /^\s{2,}\S/.test(lines[index + 1]) &&
             !/^\s*(?:\d+\.|[-*])\s+/.test(lines[index + 1])) {
        item += ` ${lines[index + 1].trim()}`;
        index += 1;
      }
      html.push(`<li>${inlineMarkdown(item)}</li>`);
      continue;
    }

    if (!line.trim()) {
      closeBlocks();
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  if (inCode) {
    html.push(`<pre><code class="language-${escapeHtml(codeLanguage)}">${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  closeBlocks();
  return { content: html.join("\n"), headings };
}

function buildToc(headings) {
  const links = headings
    .filter(heading => heading.depth <= 3)
    .map(heading =>
      `<li class="toc-depth-${heading.depth}"><a href="#${heading.slug}">${escapeHtml(heading.title)}</a></li>`
    );
  return `<ol class="toc-list">\n${links.join("\n")}\n</ol>`;
}

const [markdown, template] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(templatePath, "utf8")
]);
const { content, headings } = markdownToHtml(markdown);
const output = template
  .replace("{{BOOK_TOC}}", buildToc(headings))
  .replace("{{BOOK_CONTENT}}", content)
  .replace("<!doctype html>", "<!doctype html>\n<!-- Generated from docs/DAPP-BOOK.md by tools/build-dapp-book.mjs. -->");

await writeFile(outputPath, output, "utf8");
console.log(`Built ${path.relative(repoRoot, outputPath)} from ${headings.length} headings.`);
