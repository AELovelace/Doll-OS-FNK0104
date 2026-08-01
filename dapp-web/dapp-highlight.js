function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function highlightDappLine(raw) {
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
  return line.replace(/\u0000(\d+)\u0000/g, (_, index) => `<span class="tok-string">${strings[Number(index)]}</span>`);
}

export function highlightDappSource(source) {
  return `${String(source).split("\n").map(highlightDappLine).join("\n")}\n`;
}
