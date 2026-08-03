const COLORS = new Set(["black", "red", "green", "yellow", "blue", "magenta", "cyan", "pink", "white"]);

const LIMITS = {
  lines: 4000,
  labels: 256,
  numbers: 64,
  strings: 32,
  stringLength: 4096,
  arrays: 16,
  arrayCells: 8192,
  callDepth: 64,
  canvasCols: 120,
  canvasRows: 60,
  steps: 1_000_000
};

const KEY_CODES = {
  ArrowUp: 1,
  ArrowDown: 2,
  ArrowLeft: 3,
  ArrowRight: 4,
  Enter: 5,
  Escape: 6,
  Backspace: 8,
  Tab: 9,
  " ": 32
};

function clampByte(value) {
  const n = Number(value) || 0;
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.trunc(n);
}

const BUFFER_LIMITS = {
  defaultBytes: 65536,
  maxBytes: 262144
};

// --- URL pieces (mirrors appUrlSplit/appUrlNormalizePath/appHtmlResolveUrl in AppRunner.ino)
// Deliberately hand-rolled rather than built on the URL class: the firmware cannot use one,
// and the two implementations have to agree character for character or a .dapp that follows
// links correctly on hardware will follow different ones in the emulator.

function urlSplit(url) {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return { scheme: "", origin: "", path: "" };
  const hostStart = schemeEnd + 3;
  const hostEnd = url.indexOf("/", hostStart);
  if (hostEnd < 0) return { scheme: url.slice(0, schemeEnd), origin: url, path: "/" };
  return {
    scheme: url.slice(0, schemeEnd),
    origin: url.slice(0, hostEnd),
    path: url.slice(hostEnd)
  };
}

// collapses "." and ".." so a chain of relative links cannot walk off the root
function urlNormalizePath(path) {
  const segments = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    if (segments.length < 32) segments.push(segment);
  }
  let out = segments.length ? `/${segments.join("/")}` : "";
  if (out === "" || (path.length > 0 && path.endsWith("/"))) out += "/";
  return out;
}

// "" means "not a followable http(s) target" -- callers test the result rather than
// carrying a separate ok flag
function resolveUrl(base, href) {
  let target = String(href).trim();
  if (!target) return "";
  const lowered = target.toLowerCase();
  if (lowered.startsWith("http://") || lowered.startsWith("https://")) return target;
  if (target.startsWith("#")) return "";
  const colon = target.indexOf(":");
  const slash = target.indexOf("/");
  if (colon > 0 && (slash < 0 || colon < slash) && !target.startsWith("//")) return "";

  const { scheme, origin, path } = urlSplit(String(base));
  if (!origin) return "";
  if (target.startsWith("//")) return `${scheme}:${target}`;

  let basePath = path;
  if (target.startsWith("?")) {
    const cut = basePath.indexOf("?");
    if (cut >= 0) basePath = basePath.slice(0, cut);
    return origin + basePath + target;
  }

  // the query is carried across untouched: a "/" inside one is not a segment boundary
  let query = "";
  const q = target.indexOf("?");
  if (q >= 0) {
    query = target.slice(q);
    target = target.slice(0, q);
  }
  if (target.startsWith("/")) return origin + urlNormalizePath(target) + query;

  const cut = basePath.indexOf("?");
  if (cut >= 0) basePath = basePath.slice(0, cut);
  const lastSlash = basePath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? basePath.slice(0, lastSlash + 1) : "/";
  return origin + urlNormalizePath(dir + target) + query;
}

// --- HTML to text (mirrors DappHtmlRender in AppRunner.ino)

const HTML_BLOCK_TAGS = new Set([
  "p", "div", "br", "hr", "li", "tr", "ul", "ol", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6", "pre", "table", "title", "form",
  "nav", "main", "aside", "header", "footer", "figure", "option",
  "article", "section", "blockquote", "body", "head"
]);

const HTML_NAMED_ENTITIES = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 0xa0,
  mdash: 0x2014, ndash: 0x2013, hellip: 0x2026, lsquo: 0x2018, rsquo: 0x2019,
  ldquo: 0x201c, rdquo: 0x201d, bull: 0x2022, middot: 0xb7, copy: 0xa9,
  reg: 0xae, trade: 0x2122, laquo: 0xab, raquo: 0xbb, times: 0xd7,
  deg: 0xb0, pound: 0xa3, euro: 0x20ac,
  szlig: 0xdf, aelig: 0xe6
};

const ACCENT_SUFFIXES = ["acute", "grave", "circ", "tilde", "uml", "ring", "cedil", "slash"];

// "eacute", "uuml", "ntilde" and the rest of the Latin-1 accent names all transliterate to
// their base letter, so they are matched by shape rather than listed one by one. Case comes
// from the source name so &Eacute; still yields "E".
function accentEntity(name) {
  if (name.length < 4) return -1;
  const base = name[0];
  if (!"aeiouncyAEIOUNCY".includes(base)) return -1;
  return ACCENT_SUFFIXES.includes(name.slice(1).toLowerCase()) ? base.charCodeAt(0) : -1;
}

// the panel font cannot draw anything above 126, so the renderer transliterates rather
// than emitting characters the display would turn into '?'
const LATIN1_FOLD =
  "AAAAAAECEEEEIIII" +
  "DNOOOOOxOUUUUYPs" +
  "aaaaaaeceeeeiiii" +
  "dnooooo/ouuuuypy";

function foldCodepoint(cp) {
  if (cp < 32) return "";
  if (cp < 127) return String.fromCharCode(cp);
  // the ligatures and the sharp s are two letters, so they cannot come from the table
  if (cp === 0xdf) return "ss";
  if (cp === 0xc6) return "AE";
  if (cp === 0xe6) return "ae";
  if (cp >= 0xc0 && cp <= 0xff) return LATIN1_FOLD[cp - 0xc0];
  switch (cp) {
    case 0xa0: return " ";
    case 0xa3: return "GBP";
    case 0xa9: return "(c)";
    case 0xab: case 0xbb: return '"';
    case 0xae: return "(r)";
    case 0xb7: case 0x2022: return "*";
    case 0xd7: return "x";
    case 0x2018: case 0x2019: case 0x201b: return "'";
    case 0x201c: case 0x201d: case 0x201e: return '"';
    case 0x2013: case 0x2014: case 0x2212: return "-";
    case 0x2026: return "...";
    case 0x20ac: return "EUR";
    case 0x2122: return "(tm)";
    default: return "";
  }
}

const HTML_TEXT = 0;
const HTML_TAG = 1;
const HTML_COMMENT = 2;
const HTML_SKIP_LT = 3;

class HtmlRenderer {
  constructor({ base = "", wrapcol = 76, maxlinks = 200, collectLinks = true } = {}) {
    this.base = base;
    this.wrapcol = wrapcol >= 16 && wrapcol <= 240 ? wrapcol : 76;
    this.maxlinks = Math.max(0, maxlinks);
    this.collectLinks = collectLinks;

    this.textLines = [];
    this.linkLines = [];
    this.lines = 0;
    this.links = 0;
    this.bytes = 0;

    this.state = HTML_TEXT;
    this.skip = false;
    this.skipTag = "";
    this.inEntity = false;
    this.entity = "";
    this.tagbuf = "";
    this.tagn = 0;
    this.dash1 = 0;
    this.dash2 = 0;
    this.line = "";
    this.word = "";
    this.utf8Need = 0;
    this.utf8Cp = 0;
  }

  flushLine() {
    if (!this.line) return;
    this.textLines.push(this.line);
    this.lines += 1;
    this.line = "";
  }

  flushWord() {
    if (!this.word) return;
    if (!this.line) {
      this.line = this.word;
    } else if (this.line.length + 1 + this.word.length > this.wrapcol) {
      this.flushLine();
      this.line = this.word;
    } else {
      this.line += ` ${this.word}`;
    }
    this.word = "";
  }

  emitCp(cp) {
    if (this.skip) return;
    if (cp === 0xa0) {
      this.flushWord();
      return;
    }
    this.word += foldCodepoint(cp);
    if (this.word.length >= this.wrapcol) this.flushWord();
  }

  resolveEntity() {
    const name = this.entity;
    this.entity = "";
    if (this.skip) return;
    const lowered = name.toLowerCase();
    let cp = -1;
    if (lowered.startsWith("#x")) cp = parseInt(lowered.slice(2), 16);
    else if (lowered.startsWith("#")) cp = parseInt(lowered.slice(1), 10);
    else if (lowered in HTML_NAMED_ENTITIES) cp = HTML_NAMED_ENTITIES[lowered];
    else cp = accentEntity(name);
    if (Number.isFinite(cp) && cp > 0) {
      this.emitCp(cp);
      return;
    }
    // not an entity after all -- put the source text back verbatim, semicolon included,
    // since that character was consumed getting here
    this.emitCp(38);
    for (const ch of name) this.emitCp(ch.charCodeAt(0));
    this.emitCp(59);
  }

  // in: tagbuf, everything between < and >
  endTag() {
    if (!this.tagbuf) return;
    const first = this.tagbuf[0];
    if (first === "!" || first === "?") return;
    const closing = first === "/";
    let i = closing ? 1 : 0;
    let name = "";
    while (i < this.tagbuf.length && name.length < 12 && /[a-z0-9]/i.test(this.tagbuf[i])) {
      name += this.tagbuf[i].toLowerCase();
      i += 1;
    }
    if (!name) return;

    if (name === "script" || name === "style" || name === "template") {
      if (closing) {
        if (this.skipTag === name) {
          this.skip = false;
          this.skipTag = "";
        }
      } else {
        this.skip = true;
        this.skipTag = name;
      }
      return;
    }
    if (this.skip) return;

    if (name === "a") {
      this.anchorTag(closing);
      return;
    }
    if (HTML_BLOCK_TAGS.has(name)) {
      this.flushWord();
      this.flushLine();
      return;
    }
    if (name === "td" || name === "th") this.flushWord();
  }

  // the closing </a> flushes nothing on purpose, so "link</a>." keeps its punctuation
  anchorTag(closing) {
    if (closing) return;
    if (!this.collectLinks || this.links >= this.maxlinks) return;
    const href = this.tagAttribute("href");
    if (!href) return;
    const absolute = resolveUrl(this.base, href);
    if (!absolute) return;
    this.flushWord();
    this.links += 1;
    this.word = `[${this.links}]`;
    this.flushWord();
    this.linkLines.push(`${this.links} ${absolute}`);
  }

  tagAttribute(wanted) {
    const source = this.tagbuf;
    for (let i = 0; i < source.length; i += 1) {
      // an attribute name only starts after whitespace, so href inside another value
      // (?href=...) is not mistaken for the attribute itself
      if (i > 0 && !/\s/.test(source[i - 1])) continue;
      if (source.slice(i, i + wanted.length).toLowerCase() !== wanted) continue;
      let j = i + wanted.length;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (source[j] !== "=") continue;
      j += 1;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (j >= source.length) return "";
      let quote = "";
      if (source[j] === '"' || source[j] === "'") {
        quote = source[j];
        j += 1;
      }
      let value = "";
      while (j < source.length && value.length < 300) {
        const ch = source[j];
        if (quote ? ch === quote : /\s/.test(ch) || ch === ">") break;
        value += ch;
        j += 1;
      }
      return value.replaceAll("&amp;", "&");
    }
    return "";
  }

  feedByte(byte) {
    this.bytes += 1;

    if (this.state === HTML_COMMENT) {
      if (byte === 62 && this.dash1 === 45 && this.dash2 === 45) {
        this.state = HTML_TEXT;
      } else {
        this.dash2 = this.dash1;
        this.dash1 = byte;
      }
      return;
    }

    if (this.state === HTML_SKIP_LT) {
      // inside <script>, only "</" can begin a tag -- "if (a<b)" must stay text
      if (byte === 47) {
        this.state = HTML_TAG;
        this.tagbuf = "/";
        this.tagn = 1;
      } else {
        this.state = HTML_TEXT;
      }
      return;
    }

    if (this.state === HTML_TAG) {
      if (byte === 62) {
        this.state = HTML_TEXT;
        this.endTag();
        this.tagbuf = "";
        this.tagn = 0;
        return;
      }
      if (this.tagn < 400) {
        this.tagbuf += String.fromCharCode(byte);
        this.tagn += 1;
        if (this.tagn === 3 && this.tagbuf === "!--") {
          this.state = HTML_COMMENT;
          this.dash1 = 0;
          this.dash2 = 0;
        }
      }
      return;
    }

    if (this.inEntity) {
      if (byte === 59) {
        this.inEntity = false;
        this.resolveEntity();
      } else if (byte <= 32 || this.entity.length >= 12) {
        this.inEntity = false;
        const replay = this.entity;
        this.entity = "";
        this.emitCp(38);
        for (const ch of replay) this.emitCp(ch.charCodeAt(0));
        this.feedByte(byte);
      } else {
        this.entity += String.fromCharCode(byte);
      }
      return;
    }

    if (byte === 60) {
      this.state = this.skip ? HTML_SKIP_LT : HTML_TAG;
      if (!this.skip) {
        this.tagbuf = "";
        this.tagn = 0;
      }
      return;
    }
    if (byte === 38) {
      this.inEntity = true;
      this.entity = "";
      return;
    }

    if (this.utf8Need > 0) {
      if ((byte & 0xc0) === 0x80) {
        this.utf8Cp = (this.utf8Cp << 6) | (byte & 0x3f);
        this.utf8Need -= 1;
        if (this.utf8Need === 0) this.emitCp(this.utf8Cp);
        return;
      }
      this.utf8Need = 0;
    }
    if (byte >= 0x80) {
      if ((byte & 0xe0) === 0xc0) {
        this.utf8Need = 1;
        this.utf8Cp = byte & 0x1f;
      } else if ((byte & 0xf0) === 0xe0) {
        this.utf8Need = 2;
        this.utf8Cp = byte & 0x0f;
      } else if ((byte & 0xf8) === 0xf0) {
        this.utf8Need = 3;
        this.utf8Cp = byte & 0x07;
      }
      return;
    }

    if (byte <= 32) {
      this.flushWord();
      return;
    }
    this.emitCp(byte);
  }

  feed(bytes) {
    for (let i = 0; i < bytes.length; i += 1) this.feedByte(bytes[i]);
  }

  finish() {
    this.flushWord();
    this.flushLine();
  }
}

class DappRuntimeError extends Error {
  constructor(message, line = 0) {
    super(message);
    this.name = "DappRuntimeError";
    this.line = line;
  }
}

class DappStop extends Error {
  constructor() {
    super("stopped");
    this.name = "DappStop";
  }
}

function stripQuotes(value) {
  const text = String(value).trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function splitArgs(source, max = Infinity) {
  const result = [];
  let index = 0;

  while (index < source.length && result.length < max) {
    while (/\s/.test(source[index] || "")) index += 1;
    if (index >= source.length) break;

    if (result.length === max - 1) {
      result.push(source.slice(index).trim());
      break;
    }

    const start = index;
    const quote = source[index] === `"` || source[index] === `'` ? source[index] : null;
    if (quote) {
      index += 1;
      while (index < source.length && source[index] !== quote) index += 1;
      if (index < source.length) index += 1;
    } else {
      while (index < source.length && !/\s/.test(source[index])) index += 1;
    }
    result.push(source.slice(start, index));
  }

  return result;
}

function normalizePath(path) {
  const parts = stripQuotes(path).replaceAll("\\", "/").split("/");
  const clean = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") clean.pop();
    else clean.push(part);
  }
  return `/${clean.join("/")}`;
}

function applyMetadataDirective(line, runtime) {
  let text = String(line).trim();
  if (text.startsWith("#")) text = text.slice(1).trim();
  else if (text.startsWith("//")) text = text.slice(2).trim();
  else return;
  if (!text.startsWith("@")) return;

  const firstSpace = text.search(/\s/);
  const field = (firstSpace < 0 ? text.slice(1) : text.slice(1, firstSpace)).toLowerCase();
  const value = (firstSpace < 0 ? "" : text.slice(firstSpace).trim()).toLowerCase();
  if (field === "echo") {
    if (value === "off") runtime.echoInput = false;
    else if (value === "on") runtime.echoInput = true;
  }
}

class ExpressionParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  parse() {
    const value = this.expression(0);
    this.space();
    if (this.index !== this.source.length || !Number.isFinite(value)) {
      throw new Error("invalid expression");
    }
    return value;
  }

  expression(minPower) {
    let left = this.prefix();
    const operators = {
      "+": [10, 11, (a, b) => a + b],
      "-": [10, 11, (a, b) => a - b],
      "*": [20, 21, (a, b) => a * b],
      "/": [20, 21, (a, b) => a / b],
      "%": [20, 21, (a, b) => a % b],
      "^": [30, 30, (a, b) => a ** b]
    };

    while (true) {
      this.space();
      const op = this.source[this.index];
      const spec = operators[op];
      if (!spec || spec[0] < minPower) break;
      this.index += 1;
      const right = this.expression(spec[1]);
      left = spec[2](left, right);
    }
    return left;
  }

  prefix() {
    this.space();
    const char = this.source[this.index];
    if (char === "+" || char === "-") {
      this.index += 1;
      const value = this.expression(25);
      return char === "-" ? -value : value;
    }
    if (char === "(") {
      this.index += 1;
      const value = this.expression(0);
      this.space();
      if (this.source[this.index] !== ")") throw new Error("missing )");
      this.index += 1;
      return value;
    }
    if (/[0-9.]/.test(char || "")) return this.number();
    if (/[a-z_]/i.test(char || "")) return this.identifier();
    throw new Error("expected a value");
  }

  number() {
    const match = this.source.slice(this.index).match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
    if (!match) throw new Error("bad number");
    this.index += match[0].length;
    return Number(match[0]);
  }

  identifier() {
    const match = this.source.slice(this.index).match(/^[a-z_][a-z0-9_]*/i);
    const name = match[0].toLowerCase();
    this.index += match[0].length;
    this.space();

    if (this.source[this.index] !== "(") {
      if (name === "pi") return Math.PI;
      if (name === "e") return Math.E;
      throw new Error(`unknown name ${name}`);
    }

    this.index += 1;
    const args = [];
    this.space();
    if (this.source[this.index] !== ")") {
      while (true) {
        args.push(this.expression(0));
        this.space();
        if (this.source[this.index] !== ",") break;
        this.index += 1;
      }
    }
    if (this.source[this.index] !== ")") throw new Error("missing )");
    this.index += 1;

    const functions = {
      abs: Math.abs,
      acos: Math.acos,
      asin: Math.asin,
      atan: Math.atan,
      atan2: Math.atan2,
      ceil: Math.ceil,
      cos: Math.cos,
      cosh: Math.cosh,
      exp: Math.exp,
      floor: Math.floor,
      ln: Math.log,
      log: Math.log10,
      log10: Math.log10,
      pow: Math.pow,
      sin: Math.sin,
      sinh: Math.sinh,
      sqrt: Math.sqrt,
      tan: Math.tan,
      tanh: Math.tanh
    };
    if (!functions[name]) throw new Error(`unknown function ${name}`);
    return functions[name](...args);
  }

  space() {
    while (/\s/.test(this.source[this.index] || "")) this.index += 1;
  }
}

export function evaluateExpression(source) {
  return new ExpressionParser(String(source)).parse();
}

export class DappRuntime {
  constructor(io, fileSystem, environment = {}) {
    this.io = io;
    this.fileSystem = fileSystem;
    this.environment = environment;
    this.running = false;
    this.stopRequested = false;
    this.keyQueue = [];
    this.inputCancel = null;
  }

  stop() {
    this.stopRequested = true;
    this.inputCancel?.();
    this.delayCancel?.();
  }

  pushKey(event) {
    const key = event.key.toLowerCase();
    if (event.ctrlKey && key === "x") {
      this.stop();
      return -1;
    }
    const code = event.ctrlKey && (key === "c" || key === "t") ? KEY_CODES.Escape : (
      KEY_CODES[event.key] ?? (
      event.key.length === 1 ? event.key.charCodeAt(0) : 0
      )
    );
    if (code) this.keyQueue.push(code);
    return code;
  }

  async run(source) {
    if (this.running) return { ok: false, running: true };
    this.running = true;
    this.io.status("running", "RUNNING");

    try {
      this.reset(source);
      await this.execute();
      this.io.status("idle", "FINISHED");
      return { ok: true };
    } catch (error) {
      if (error instanceof DappStop) {
        this.io.output("run: stopped", "yellow");
        this.io.status("idle", "STOPPED");
        return { ok: false, stopped: true };
      }
      const line = error.line ? ` (line ${error.line})` : "";
      this.io.output(`run: ${error.message}${line}`, "red");
      this.io.status("error", "ERROR");
      return { ok: false, error };
    } finally {
      this.running = false;
      this.inputCancel = null;
      this.delayCancel = null;
      this.closeFile();
      this.htmlClose();
      this.buf = null;
      this.bufLen = 0;
      this.io.waveStop?.();
      this.endCanvas();
    }
  }

  reset(source) {
    this.lines = String(source).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    if (this.lines.length > LIMITS.lines) {
      throw new DappRuntimeError(`app has more than ${LIMITS.lines} lines`);
    }

    this.labels = new Map();
    this.numbers = new Map();
    this.strings = new Map();
    this.arrays = new Map();
    this.arrayCells = 0;
    this.callStack = [];
    this.color = "white";
    this.pc = 0;
    this.steps = 0;
    this.fok = 0;
    this.feof = 0;
    this.httpcode = 0;
    this.httplen = 0;
    this.httptruncated = 0;
    this.httpok = 0;
    this.jsonok = 0;
    this.buf = null;
    this.bufLen = 0;
    this.bufOk = 0;
    this.html = null;
    this.htmlTarget = null;
    this.htmlok = 0;
    this.htmllines = 0;
    this.htmllinks = 0;
    this.htmlbytes = 0;
    this.httpHeaders = new Map();
    this.openFile = null;
    this.canvas = null;
    this.echoInput = true;
    this.stopRequested = false;
    this.keyQueue.length = 0;
    this.startedAt = performance.now();

    let reachedExecutable = false;
    for (let index = 0; index < this.lines.length; index += 1) {
      const line = this.lines[index].trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) {
        if (!reachedExecutable) applyMetadataDirective(line, this);
        continue;
      }
      reachedExecutable = true;
      let name = "";
      if (line.startsWith(":")) name = line.slice(1).trim();
      else if (/^LABEL(?:\s|$)/i.test(line)) name = line.slice(5).trim();
      if (name && !this.labels.has(name)) {
        if (this.labels.size >= LIMITS.labels) throw new DappRuntimeError(`too many labels (max ${LIMITS.labels})`);
        this.labels.set(name, index);
      }
    }
  }

  async execute() {
    while (this.pc >= 0 && this.pc < this.lines.length) {
      this.checkStop();
      this.steps += 1;
      if (this.steps > LIMITS.steps) {
        throw this.error(`stopped after ${LIMITS.steps} steps without a WAIT (possible loop)`);
      }
      if (this.steps % 256 === 0) await this.delay(0);

      const raw = this.lines[this.pc];
      this.pc += 1;
      const lineNumber = this.pc;
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith(":")) continue;

      const firstSpace = line.search(/\s/);
      const op = (firstSpace < 0 ? line : line.slice(0, firstSpace)).toUpperCase();
      const arg = firstSpace < 0 ? "" : line.slice(firstSpace).trim();

      try {
        await this.instruction(op, arg);
      } catch (error) {
        if (error instanceof DappRuntimeError && !error.line) error.line = lineNumber;
        throw error;
      }
    }
  }

  async instruction(op, arg) {
    if (op === "LABEL") return;
    if (op === "PRINT" || op === "ECHO") {
      this.io.output(this.expandText(arg), this.color);
      return;
    }
    if (op === "COLOR") {
      const requested = arg.trim().toLowerCase();
      this.color = COLORS.has(requested) ? requested : "white";
      return;
    }
    if (op === "CLEAR" || op === "CLS") {
      if (this.canvas) this.clearCanvas();
      else this.io.clear();
      return;
    }
    if (op === "WAIT" || op === "SLEEP") {
      const ms = Math.max(0, this.valueOf(arg));
      await this.delay(ms);
      if (ms > 0) this.steps = 0;
      return;
    }
    if (["SET", "ADD", "SUB", "MUL", "DIV", "MOD"].includes(op)) {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error(`${op} needs <name> <value>`);
      const value = this.valueOf(parts[1]);
      if ((op === "DIV" || op === "MOD") && value === 0) throw this.error(`${op} by zero`);
      const current = this.readTarget(parts[0]);
      const next = {
        SET: value,
        ADD: current + value,
        SUB: current - value,
        MUL: current * value,
        DIV: Math.trunc(current / value),
        MOD: current % value
      }[op];
      this.writeTarget(parts[0], Math.trunc(next));
      return;
    }
    if (op === "EXPR") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("EXPR needs <name> <expression>");
      const expression = this.expandNumeric(parts[1]);
      let result;
      try {
        result = new ExpressionParser(expression).parse();
      } catch {
        throw this.error(`EXPR cannot evaluate: ${expression}`);
      }
      const rounded = result >= 0 ? Math.floor(result + .5) : Math.ceil(result - .5);
      this.writeTarget(parts[0], rounded);
      return;
    }
    if (op === "DIM") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("DIM needs <name> <size>");
      this.dim(parts[0], this.valueOf(parts[1]));
      return;
    }
    if (op === "LIFE") {
      const parts = splitArgs(arg, 4);
      if (parts.length < 4) throw this.error("LIFE needs <current-array> <next-array> <cols> <rows>");
      this.lifeStep(parts[0], parts[1], this.valueOf(parts[2]), this.valueOf(parts[3]));
      this.steps = 0;
      return;
    }
    if (op === "SETSTR" || op === "APPEND") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error(`${op} needs <name> <text>`);
      const addition = this.expandText(parts[1]);
      const value = op === "APPEND" ? (this.strings.get(parts[0]) || "") + addition : addition;
      this.setString(parts[0], value);
      return;
    }
    if (op === "CHR") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("CHR needs <name> <code>");
      const code = this.valueOf(parts[1]);
      this.setString(parts[0], code >= 32 && code < 127 ? String.fromCharCode(code) : " ");
      return;
    }
    if (op === "HEX") {
      const parts = splitArgs(arg, 3);
      if (parts.length < 2) throw this.error("HEX needs <name> <value> [width]");
      const width = parts.length >= 3 ? this.valueOf(parts[2]) : 2;
      if (width < 1 || width > 8) throw this.error("HEX width must be 1..8");
      const value = this.valueOf(parts[1]) >>> 0;
      this.setString(parts[0], value.toString(16).toUpperCase().padStart(width, "0"));
      return;
    }
    if (op === "JSONESC") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("JSONESC needs <name> <text>");
      const escaped = JSON.stringify(this.stringOperand(parts[1])).slice(1, -1);
      this.jsonok = escaped.length <= LIMITS.stringLength ? 1 : 0;
      this.setString(parts[0], this.jsonok ? escaped : "");
      return;
    }
    if (op === "JSONGET") {
      const parts = splitArgs(arg, 3);
      if (parts.length < 3) throw this.error("JSONGET needs <name> <json> <path>");
      let value;
      try {
        value = JSON.parse(this.stringOperand(parts[1]));
        const path = this.stringOperand(parts[2]);
        const segments = [...path.matchAll(/(?:^|\.)([^.\[]+)|\[(\d+)\]/g)];
        if (!segments.length && path) throw new Error("bad path");
        let consumed = "";
        for (const match of segments) {
          consumed += match[0];
          value = value[match[1] ?? Number(match[2])];
          if (value === undefined || value === null) throw new Error("missing path");
        }
        if (consumed !== path) throw new Error("bad path");
        const result = typeof value === "string" ? value : JSON.stringify(value);
        if (result.length > LIMITS.stringLength) throw new Error("too long");
        this.setString(parts[0], result);
        this.jsonok = 1;
      } catch {
        this.setString(parts[0], "");
        this.jsonok = 0;
      }
      return;
    }
    if (op === "SUBSTR") {
      const parts = splitArgs(arg, 4);
      if (parts.length < 4) throw this.error("SUBSTR needs <name> <text> <start> <count>");
      const source = this.stringOperand(parts[1]);
      const start = Math.max(0, Math.min(source.length, this.valueOf(parts[2])));
      const count = Math.max(0, this.valueOf(parts[3]));
      this.setString(parts[0], source.slice(start, start + count));
      return;
    }
    if (op === "LEN" || op === "CHARAT") {
      const parts = splitArgs(arg, 3);
      const needed = op === "LEN" ? 2 : 3;
      if (parts.length < needed) throw this.error(`${op} needs <name> <text>${op === "CHARAT" ? " <index>" : ""}`);
      const source = this.stringOperand(parts[1]);
      const value = op === "LEN"
        ? source.length
        : (source.charCodeAt(this.valueOf(parts[2])) || 0);
      this.writeTarget(parts[0], value);
      return;
    }
    if (op === "INPUT" || op === "INPUTSECRET") {
      const parts = splitArgs(arg, 2);
      if (!parts.length) throw this.error(`${op} needs <name> [prompt]`);
      this.ensureString(parts[0]);
      const prompt = parts.length > 1 ? this.expandText(parts[1]) : `${parts[0]}> `;
      const value = await new Promise((resolve, reject) => {
        this.inputCancel = () => reject(new DappStop());
        this.io.input(prompt, resolve, op === "INPUTSECRET", this.echoInput);
      });
      this.inputCancel = null;
      this.setString(parts[0], value);
      this.steps = 0;
      return;
    }
    if (op === "KEY") {
      if (!arg) throw this.error("KEY needs <name>");
      this.writeTarget(arg, this.keyQueue.shift() || 0);
      return;
    }
    if (op === "LED") {
      const parts = splitArgs(arg, 3);
      if (parts.length < 3) throw this.error("LED needs <red> <green> <blue>");
      this.led = {
        red: clampByte(this.valueOf(parts[0])),
        green: clampByte(this.valueOf(parts[1])),
        blue: clampByte(this.valueOf(parts[2]))
      };
      this.io.led?.(this.led);
      return;
    }
    if (op === "WAVE") {
      const parts = splitArgs(arg, 4);
      if (parts.length < 4) throw this.error("WAVE needs <channel> sine|triangle|square|noise|off <hz> <level>");
      const channel = this.valueOf(parts[0]);
      const waveform = this.stringOperand(parts[1]).toLowerCase();
      const frequency = this.valueOf(parts[2]);
      const level = this.valueOf(parts[3]);
      if (channel < 1 || channel > 3 || !["off", "sine", "sin", "triangle", "tri", "square", "sq", "noise"].includes(waveform)
          || frequency < 1 || frequency > 12000 || level < 0 || level > 100) {
        throw this.error("WAVE needs channel 1..3, hz 1..12000, level 0..100, and a valid waveform");
      }
      await Promise.resolve(this.io.wave?.({ channel, waveform, frequency, level }));
      return;
    }
    if (op === "WAVESTOP") {
      this.io.waveStop?.();
      return;
    }
    if (op === "CANVAS") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("CANVAS needs <cols> <rows>");
      this.beginCanvas(this.valueOf(parts[0]), this.valueOf(parts[1]));
      return;
    }
    if (op === "ENDCANVAS") {
      this.endCanvas();
      return;
    }
    if (op === "PUT") {
      const parts = splitArgs(arg, 3);
      if (parts.length < 3) throw this.error("PUT needs <col> <row> <text>");
      if (!this.canvas) throw this.error("PUT needs a CANVAS first");
      this.putCanvas(this.valueOf(parts[0]), this.valueOf(parts[1]), this.expandText(parts[2]));
      return;
    }
    if (op === "FLIP") {
      if (!this.canvas) throw this.error("FLIP needs a CANVAS first");
      this.io.canvas(this.canvas);
      return;
    }
    if (op === "FOPEN") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("FOPEN needs <path> read|write|append|update");
      this.open(parts[0], parts[1]);
      return;
    }
    if (op === "FCLOSE") {
      this.closeFile();
      return;
    }
    if (op === "FREAD") {
      if (!arg) throw this.error("FREAD needs <name>");
      if (!this.openFile || !this.openFile.readable) throw this.error("FREAD needs a file FOPENed for read");
      if (this.openFile.position >= this.openFile.content.length) {
        this.feof = 1;
        this.setString(arg, "");
      } else {
        this.feof = 0;
        const newline = this.openFile.content.indexOf("\n", this.openFile.position);
        const end = newline < 0 ? this.openFile.content.length : newline;
        this.setString(arg, this.openFile.content.slice(this.openFile.position, end).replace(/\r$/, ""));
        this.openFile.position = newline < 0 ? end : end + 1;
      }
      return;
    }
    if (op === "FREADB") {
      if (!arg) throw this.error("FREADB needs <name>");
      if (!this.openFile || !this.openFile.readable) throw this.error("FREADB needs a file FOPENed for read or update");
      if (this.openFile.position >= this.openFile.content.length) {
        this.feof = 1;
        this.writeTarget(arg, 0);
      } else {
        this.feof = 0;
        this.writeTarget(arg, this.openFile.content.charCodeAt(this.openFile.position) & 255);
        this.openFile.position += 1;
      }
      return;
    }
    if (op === "FWRITE") {
      if (!this.openFile || !this.openFile.writable) throw this.error("FWRITE needs a file FOPENed for write or append");
      this.writeOpenFile(`${this.expandText(arg)}\n`);
      return;
    }
    if (op === "FWRITEB") {
      if (!this.openFile || !this.openFile.writable) throw this.error("FWRITEB needs a file FOPENed for write, append, or update");
      const value = this.valueOf(arg);
      if (!arg || value < 0 || value > 255) throw this.error("FWRITEB needs one byte value (0..255)");
      this.writeOpenFile(String.fromCharCode(value));
      return;
    }
    if (op === "FSEEK") {
      if (!this.openFile) throw this.error("FSEEK needs an open file");
      const offset = this.valueOf(arg);
      if (!arg || offset < 0) throw this.error("FSEEK needs an absolute offset >= 0");
      this.openFile.position = Math.min(Math.trunc(offset), this.openFile.content.length);
      this.fok = offset <= this.openFile.content.length ? 1 : 0;
      this.feof = 0;
      return;
    }
    if (op === "FTELL" || op === "FSIZE") {
      if (!this.openFile) throw this.error(`${op} needs an open file`);
      if (!arg) throw this.error(`${op} needs <name>`);
      this.writeTarget(arg, op === "FTELL" ? this.openFile.position : this.openFile.content.length);
      return;
    }
    if (op === "HTTPCLEAR") {
      this.httpHeaders.clear();
      return;
    }
    if (op === "HTTPHEADER") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("HTTPHEADER needs <name> <value>");
      const name = this.stringOperand(parts[0]).trim();
      const value = this.stringOperand(parts[1]);
      if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        throw this.error("HTTPHEADER needs a safe <name> <value>");
      }
      const prior = [...this.httpHeaders.keys()].find(key => key.toLowerCase() === name.toLowerCase());
      if (!prior && this.httpHeaders.size >= 8) throw this.error("HTTPHEADER supports at most 8 headers");
      if (prior) this.httpHeaders.delete(prior);
      this.httpHeaders.set(name, value);
      return;
    }
    if (op === "HTTPGET" || op === "HTTPPOST") {
      const parts = splitArgs(arg, 4);
      const needed = op === "HTTPGET" ? 2 : 3;
      if (parts.length < needed) throw this.error(op === "HTTPGET"
        ? "HTTPGET needs <name> <http-or-https-url> [max-bytes]"
        : "HTTPPOST needs <name> <http-or-https-url> <body> [max-bytes]");
      const maxIndex = op === "HTTPGET" ? 2 : 3;
      const maximum = parts.length > maxIndex ? this.valueOf(parts[maxIndex]) : LIMITS.stringLength;
      if (maximum < 1 || maximum > LIMITS.stringLength) throw this.error(`${op} max-bytes must be 1..${LIMITS.stringLength}`);
      this.ensureString(parts[0]);
      this.httpcode = 0;
      this.httplen = 0;
      this.httptruncated = 0;
      this.httpok = 0;
      try {
        const rawUrl = this.stringOperand(parts[1]);
        const baseUrl = globalThis.location?.href || "https://browser.invalid/";
        const url = new URL(rawUrl, baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported URL protocol");
        const request = {
          url: url.href,
          method: op === "HTTPPOST" ? "POST" : "GET",
          headers: Object.fromEntries(this.httpHeaders),
          body: op === "HTTPPOST" ? this.stringOperand(parts[2]) : undefined
        };
        if (this.io.authorizeHttp && !await this.io.authorizeHttp(request)) {
          this.setString(parts[0], "");
          this.httpcode = -2;
          this.io.output("HTTP request blocked by browser policy", "yellow");
          this.steps = 0;
          return;
        }
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store"
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const accepted = bytes.slice(0, maximum);
        this.setString(parts[0], new TextDecoder().decode(accepted));
        this.httpcode = response.status;
        this.httplen = accepted.length;
        this.httptruncated = bytes.length > maximum ? 1 : 0;
        this.httpok = response.ok ? 1 : 0;
      } catch {
        this.setString(parts[0], "");
        this.httpcode = -1;
      }
      this.steps = 0;
      return;
    }
    if (op === "BUFNEW") {
      const bytes = arg ? this.valueOf(arg) : BUFFER_LIMITS.defaultBytes;
      if (bytes < 1 || bytes > BUFFER_LIMITS.maxBytes) {
        throw this.error(`BUFNEW size must be 1..${BUFFER_LIMITS.maxBytes}`);
      }
      this.buf = new Uint8Array(Math.trunc(bytes));
      this.bufLen = 0;
      this.bufOk = 1;
      return;
    }
    if (op === "BUFFREE") {
      this.buf = null;
      this.bufLen = 0;
      this.bufOk = 1;
      return;
    }
    if (op === "BUFCLEAR") {
      this.bufLen = 0;
      this.bufOk = this.buf ? 1 : 0;
      return;
    }
    if (op === "BUFAT") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("BUFAT needs <name> <position>");
      const position = this.valueOf(parts[1]);
      // out of range reads 0 rather than stopping: a scan loop tests $buflen itself
      const value = this.buf && position >= 0 && position < this.bufLen ? this.buf[position] : 0;
      this.writeTarget(parts[0], value);
      return;
    }
    if (op === "BUFSUB") {
      const parts = splitArgs(arg, 3);
      if (parts.length < 3) throw this.error("BUFSUB needs <name> <position> <count>");
      const position = this.valueOf(parts[1]);
      let count = this.valueOf(parts[2]);
      let piece = "";
      if (this.buf && position >= 0 && position < this.bufLen && count > 0) {
        count = Math.min(count, LIMITS.stringLength, this.bufLen - position);
        for (let i = 0; i < count; i += 1) {
          const byte = this.buf[position + i];
          // the buffer holds bytes and a NUL cannot survive the print path
          if (byte === 0) break;
          piece += String.fromCharCode(byte);
        }
      }
      this.setString(parts[0], piece);
      return;
    }
    if (op === "BUFWRITE") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("BUFWRITE needs <position> <text>");
      const position = this.valueOf(parts[0]);
      const text = this.stringOperand(parts[1]);
      this.bufOk = 0;
      if (this.buf && position >= 0 && position + text.length <= this.buf.length) {
        for (let i = 0; i < text.length; i += 1) {
          this.buf[position + i] = text.charCodeAt(i) & 255;
        }
        this.bufLen = Math.max(this.bufLen, position + text.length);
        this.bufOk = 1;
      }
      return;
    }
    if (op === "BUFSCAN" || op === "BUFTAKE") {
      // token-at-a-time scanning: a per-byte loop in script costs ~25 interpreter steps
      // per byte, and stopping on a character class makes the script pay per token
      const take = op === "BUFTAKE";
      const parts = splitArgs(arg, 4);
      const needed = take ? 3 : 2;
      if (parts.length < needed) {
        throw this.error(take
          ? "BUFTAKE needs <strname> <numname> <position> [stopset]"
          : "BUFSCAN needs <numname> <position> [stopset]");
      }
      let position = Math.max(0, this.valueOf(parts[take ? 2 : 1]));
      // an empty stop set means whitespace, which is what most scans want
      const stops = parts.length > needed ? this.stringOperand(parts[needed]) : "";
      let piece = "";
      while (this.buf && position < this.bufLen) {
        const byte = this.buf[position];
        const stop = stops === "" ? byte <= 32 : stops.includes(String.fromCharCode(byte));
        if (stop) break;
        if (take && piece.length < LIMITS.stringLength) piece += String.fromCharCode(byte);
        position += 1;
      }
      this.writeTarget(parts[take ? 1 : 0], position);
      if (take) this.setString(parts[0], piece);
      return;
    }
    if (op === "BUFSAVE" || op === "BUFLOAD") {
      if (!arg) throw this.error(`${op} needs <path>`);
      if (this.openFile) throw this.error(`${op} needs the script's file handle closed (FCLOSE)`);
      const path = normalizePath(this.expandText(arg));
      this.bufOk = 0;
      if (!this.buf) return;
      if (op === "BUFSAVE") {
        let text = "";
        for (let i = 0; i < this.bufLen; i += 1) text += String.fromCharCode(this.buf[i]);
        this.fileSystem.write(path, text);
        this.bufOk = 1;
      } else {
        const text = this.fileSystem.read(path);
        if (text == null) return;
        const want = Math.min(text.length, this.buf.length);
        for (let i = 0; i < want; i += 1) this.buf[i] = text.charCodeAt(i) & 255;
        this.bufLen = want;
        this.bufOk = 1;
      }
      return;
    }
    if (op === "HTTPGETBUF") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 1) throw this.error("HTTPGETBUF needs <http-or-https-url> [max-bytes]");
      if (!this.buf) this.buf = new Uint8Array(BUFFER_LIMITS.defaultBytes);
      let maximum = parts.length > 1 ? this.valueOf(parts[1]) : this.buf.length;
      if (maximum < 1 || maximum > this.buf.length) maximum = this.buf.length;
      this.bufLen = 0;
      const bytes = await this.fetchBytes(this.stringOperand(parts[0]));
      if (bytes) {
        const accepted = Math.min(bytes.length, maximum);
        this.buf.set(bytes.subarray(0, accepted), 0);
        this.bufLen = accepted;
        this.httptruncated = bytes.length > maximum ? 1 : 0;
      }
      this.httplen = this.bufLen;
      this.steps = 0;
      return;
    }
    if (op === "URLABS") {
      const parts = splitArgs(arg, 3);
      if (parts.length < 3) throw this.error("URLABS needs <name> <base-url> <href>");
      // "" means "not a followable http(s) target" -- the caller tests the result
      this.setString(parts[0], resolveUrl(this.stringOperand(parts[1]), this.stringOperand(parts[2])));
      return;
    }
    if (op === "URLPART") {
      const parts = splitArgs(arg, 3);
      if (parts.length < 3) throw this.error("URLPART needs <name> <url> scheme|origin|host|path|dir");
      const { scheme, origin, path } = urlSplit(this.stringOperand(parts[1]));
      const which = this.stringOperand(parts[2]).toLowerCase();
      let value;
      if (which === "scheme") value = scheme;
      else if (which === "origin") value = origin;
      else if (which === "host") value = origin.slice(scheme.length + 3);
      else if (which === "path") value = path;
      else if (which === "dir") {
        const q = path.indexOf("?");
        const clean = q >= 0 ? path.slice(0, q) : path;
        const lastSlash = clean.lastIndexOf("/");
        value = origin + (lastSlash >= 0 ? clean.slice(0, lastSlash + 1) : "/");
      } else {
        throw this.error("URLPART part must be scheme, origin, host, path or dir");
      }
      this.setString(parts[0], value);
      return;
    }
    if (op === "HTMLOPEN") {
      const parts = splitArgs(arg, 5);
      if (parts.length < 3) {
        throw this.error("HTMLOPEN needs <textpath> <linkpath|-> <base-url> [wrapcol] [maxlinks]");
      }
      // the firmware has one script file handle and the renderer needs two of its own,
      // so it refuses to start while the script is holding a file -- matched here so a
      // .dapp that works in the emulator works on hardware
      if (this.openFile) throw this.error("HTMLOPEN needs the script's file handle closed (FCLOSE)");
      this.htmlBegin({
        textPath: normalizePath(this.expandText(parts[0])),
        linkPath: this.expandText(parts[1]),
        base: this.stringOperand(parts[2]),
        wrapcol: parts.length > 3 ? this.valueOf(parts[3]) : 76,
        maxlinks: parts.length > 4 ? this.valueOf(parts[4]) : 200
      });
      return;
    }
    if (op === "HTMLFEED") {
      if (!this.html) throw this.error("HTMLFEED without HTMLOPEN");
      const parts = splitArgs(arg, 3);
      if (parts.length < 1) throw this.error("HTMLFEED needs url <url> | buf [pos count] | text <string>");
      await this.htmlFeedSource(op, parts);
      return;
    }
    if (op === "HTMLCLOSE") {
      this.htmlClose();
      return;
    }
    if (op === "HTMLTEXT") {
      const parts = splitArgs(arg, 5);
      if (parts.length < 3) {
        throw this.error("HTMLTEXT needs <url> <textpath> <linkpath|-> [wrapcol] [maxlinks]");
      }
      if (this.openFile) throw this.error("HTMLTEXT needs the script's file handle closed (FCLOSE)");
      const url = this.stringOperand(parts[0]);
      // the page's own URL is the base every relative href resolves against
      this.htmlBegin({
        textPath: normalizePath(this.expandText(parts[1])),
        linkPath: this.expandText(parts[2]),
        base: url,
        wrapcol: parts.length > 3 ? this.valueOf(parts[3]) : 76,
        maxlinks: parts.length > 4 ? this.valueOf(parts[4]) : 200
      });
      const bytes = await this.fetchBytes(url);
      if (bytes) this.html.feed(bytes);
      this.syncHtml();
      this.httplen = this.htmlbytes;
      this.htmlClose();
      this.steps = 0;
      return;
    }
    if (op === "HTMLSTR") {
      const parts = splitArgs(arg, 3);
      if (parts.length < 2) throw this.error("HTMLSTR needs <name> url <url> | buf | text <string>");
      this.ensureString(parts[0]);
      // links need a file to number against, so a string render never collects them
      this.html = new HtmlRenderer({ base: "", collectLinks: false });
      this.htmlTarget = null;
      this.htmlok = 1;
      const kind = parts[1].toLowerCase();
      if (kind === "url") {
        if (parts.length < 3) throw this.error("HTMLSTR url needs <url>");
        this.html.base = this.stringOperand(parts[2]);
        const bytes = await this.fetchBytes(this.html.base);
        if (bytes) this.html.feed(bytes);
        this.steps = 0;
      } else if (kind === "buf") {
        if (this.buf) this.html.feed(this.buf.subarray(0, this.bufLen));
      } else if (kind === "text") {
        if (parts.length < 3) throw this.error("HTMLSTR text needs <string>");
        this.html.feed(new TextEncoder().encode(this.stringOperand(parts[2])));
      } else {
        this.html = null;
        throw this.error("HTMLSTR source must be url, buf or text");
      }
      this.html.finish();
      this.syncHtml();
      this.setString(parts[0], this.html.textLines.join("\n").slice(0, LIMITS.stringLength));
      this.html = null;
      return;
    }
    if (op === "FEXISTS") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("FEXISTS needs <name> <path>");
      this.writeTarget(parts[0], this.fileSystem.exists(normalizePath(this.expandText(parts[1]))) ? 1 : 0);
      return;
    }
    if (op === "FDELETE") {
      if (!arg) throw this.error("FDELETE needs <path>");
      this.fok = this.fileSystem.delete(normalizePath(this.expandText(arg))) ? 1 : 0;
      return;
    }
    if (op === "FLIST") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error("FLIST needs <directory> <output-file>");
      const directory = normalizePath(this.expandText(parts[0]));
      const output = normalizePath(this.expandText(parts[1]));
      const rows = this.fileSystem.list?.(directory);
      const content = rows?.map(row => `${row.directory ? "D" : "F"}|${row.name}|${row.size || 0}`).join("\n");
      this.fok = rows && this.fileSystem.write(output, content ? `${content}\n` : "") ? 1 : 0;
      return;
    }
    if (op === "FMKDIR") {
      if (!arg) throw this.error("FMKDIR needs <path>");
      this.fok = this.fileSystem.mkdir?.(normalizePath(this.expandText(arg))) ? 1 : 0;
      return;
    }
    if (op === "FCOPY" || op === "FMOVE") {
      const parts = splitArgs(arg, 2);
      if (parts.length < 2) throw this.error(`${op} needs <source> <destination>`);
      const source = normalizePath(this.expandText(parts[0]));
      const destination = normalizePath(this.expandText(parts[1]));
      const result = op === "FCOPY" ? this.fileSystem.copy?.(source, destination)
        : this.fileSystem.move?.(source, destination);
      this.fok = result ? 1 : 0;
      return;
    }
    if (op === "DAPPER") {
      const parts = splitArgs(this.expandText(arg), 7).map(stripQuotes);
      if (!parts.length) throw this.error("DAPPER needs a package-manager action");
      if (typeof this.environment.dapper !== "function") {
        this.io.output("Dapper: package-manager bridge is unavailable in this runtime", "red");
        return;
      }
      await this.environment.dapper(parts);
      this.steps = 0;
      return;
    }
    if (op === "RAND") {
      const parts = splitArgs(arg, 3);
      if (parts.length < 2) throw this.error("RAND needs <name> <max> or <name> <min> <max>");
      let min = 0;
      let max;
      if (parts.length === 2) {
        max = this.valueOf(parts[1]) - 1;
        if (max < 0) throw this.error("RAND max must be greater than 0");
      } else {
        min = this.valueOf(parts[1]);
        max = this.valueOf(parts[2]);
      }
      if (min > max) [min, max] = [max, min];
      this.writeTarget(parts[0], Math.floor(Math.random() * (max - min + 1)) + min);
      return;
    }
    if (op === "GOTO" || op === "GOSUB") {
      this.jump(arg, op === "GOSUB");
      return;
    }
    if (op === "RETURN") {
      if (!this.callStack.length) throw this.error("RETURN without GOSUB");
      this.pc = this.callStack.pop();
      return;
    }
    if (op === "IF") {
      const parts = splitArgs(arg, 5);
      const jump = (parts[3] || "").toUpperCase();
      if (parts.length < 5 || !["GOTO", "GOSUB"].includes(jump)) {
        throw this.error("IF syntax is IF <left> <op> <right> GOTO|GOSUB <label>");
      }
      if (this.compare(this.valueOf(parts[0]), parts[1], this.valueOf(parts[2]))) {
        this.jump(parts[4], jump === "GOSUB");
      }
      return;
    }
    if (op === "IFEQ" || op === "IFNE") {
      const parts = splitArgs(arg, 4);
      const jump = (parts[2] || "").toUpperCase();
      if (parts.length < 4 || !["GOTO", "GOSUB"].includes(jump)) {
        throw this.error(`${op} syntax is ${op} <left> <right> GOTO|GOSUB <label>`);
      }
      const equal = this.stringOperand(parts[0]) === this.stringOperand(parts[1]);
      if ((op === "IFEQ" && equal) || (op === "IFNE" && !equal)) {
        this.jump(parts[3], jump === "GOSUB");
      }
      return;
    }
    if (op === "EXIT" || op === "END") {
      this.pc = this.lines.length;
      return;
    }
    throw this.error(`unknown app command: ${op}`);
  }

  error(message) {
    return new DappRuntimeError(message);
  }

  checkStop() {
    if (this.stopRequested) throw new DappStop();
  }

  async delay(ms) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, Math.min(ms, 2_147_483_647));
      this.delayCancel = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.delayCancel = null;
    this.checkStop();
  }

  builtIn(name, asString = false) {
    const elapsed = Math.floor(performance.now() - this.startedAt);
    const values = {
      battery: 100,
      cwd: "/apps",
      heap: 0,
      ip: "browser",
      millis: elapsed,
      seconds: Math.floor(elapsed / 1000),
      wifi: 1,
      ledok: 1,
      audiook: 0,
      fok: this.fok,
      feof: this.feof,
      httpcode: this.httpcode,
      httplen: this.httplen,
      httptruncated: this.httptruncated,
      httpok: this.httpok,
      jsonok: this.jsonok,
      buflen: this.bufLen,
      bufcap: this.buf ? this.buf.length : 0,
      bufok: this.bufOk,
      htmlok: this.htmlok,
      htmllines: this.htmllines,
      htmllinks: this.htmllinks,
      htmlbytes: this.htmlbytes,
      kup: 1,
      kdown: 2,
      kleft: 3,
      kright: 4,
      kenter: 5,
      kesc: 6,
      kback: 8,
      ktab: 9,
      kspace: 32
    };
    const key = name.toLowerCase();
    if (key in this.environment) {
      const configured = this.environment[key];
      const value = typeof configured === "function" ? configured() : configured;
      return asString ? String(value ?? "") : Number(value) || 0;
    }
    if (!(key in values)) return asString ? "" : 0;
    if (asString && key.startsWith("k")) return "";
    return asString ? String(values[key]) : Number(values[key]) || 0;
  }

  parseSubscript(token) {
    const text = token.trim().replace(/^\$/, "");
    const open = text.indexOf("[");
    if (open <= 0 || !text.endsWith("]")) return null;
    return { name: text.slice(0, open).trim(), index: text.slice(open + 1, -1).trim() };
  }

  valueOf(token) {
    const text = stripQuotes(String(token).trim()).replace(/^\$/, "");
    const subscript = this.parseSubscript(text);
    if (subscript) return this.arrayCell(subscript.name, this.valueOf(subscript.index));
    if (/^[+-]?\d+$/.test(text)) return Number(text);
    if (this.numbers.has(text)) return this.numbers.get(text);
    return this.builtIn(text);
  }

  stringValue(token) {
    const text = String(token).trim().replace(/^\$/, "");
    const subscript = this.parseSubscript(text);
    if (subscript) return String(this.arrayCell(subscript.name, this.valueOf(subscript.index)));
    if (this.strings.has(text)) return this.strings.get(text);
    if (this.numbers.has(text)) return String(this.numbers.get(text));
    return this.builtIn(text, true);
  }

  scanReference(text, index) {
    const match = text.slice(index + 1).match(/^[a-z0-9_]+/i);
    if (!match) return null;
    let end = index + 1 + match[0].length;
    if (text[end] === "[") {
      let depth = 0;
      while (end < text.length) {
        if (text[end] === "[") depth += 1;
        if (text[end] === "]") {
          depth -= 1;
          if (depth === 0) {
            end += 1;
            break;
          }
        }
        end += 1;
      }
    }
    return { ref: text.slice(index + 1, end), end };
  }

  expand(text, numeric) {
    const source = numeric ? String(text) : stripQuotes(text);
    let result = "";
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== "$") {
        result += source[index];
        continue;
      }
      const match = this.scanReference(source, index);
      if (!match) {
        result += "$";
        continue;
      }
      result += numeric ? this.valueOf(match.ref) : this.stringValue(match.ref);
      index = match.end - 1;
    }
    return result;
  }

  expandText(text) {
    return this.expand(text, false);
  }

  expandNumeric(text) {
    return this.expand(text, true);
  }

  stringOperand(token) {
    const text = String(token).trim();
    const quoted = (text.startsWith(`"`) && text.endsWith(`"`)) || (text.startsWith(`'`) && text.endsWith(`'`));
    const bare = text.replace(/^\$/, "");
    if (text.startsWith("$") || (!quoted && (this.strings.has(bare) || this.numbers.has(bare)))) {
      return this.stringValue(text);
    }
    return this.expandText(text);
  }

  ensureNumber(name) {
    const clean = String(name).trim().replace(/^\$/, "");
    if (!this.numbers.has(clean)) {
      if (this.numbers.size >= LIMITS.numbers) throw this.error("too many variables");
      this.numbers.set(clean, 0);
    }
    return clean;
  }

  ensureString(name) {
    const clean = String(name).trim().replace(/^\$/, "");
    if (!this.strings.has(clean)) {
      if (this.strings.size >= LIMITS.strings) throw this.error("too many string variables");
      this.strings.set(clean, "");
    }
    return clean;
  }

  setString(name, value) {
    this.strings.set(this.ensureString(name), String(value).slice(0, LIMITS.stringLength));
  }

  readTarget(token) {
    const subscript = this.parseSubscript(token);
    return subscript
      ? this.arrayCell(subscript.name, this.valueOf(subscript.index))
      : (this.numbers.get(this.ensureNumber(token)) || 0);
  }

  writeTarget(token, value) {
    const subscript = this.parseSubscript(token);
    if (subscript) {
      const array = this.getArray(subscript.name);
      const index = this.checkedIndex(array, subscript.name, this.valueOf(subscript.index));
      array[index] = Math.trunc(value);
    } else {
      this.numbers.set(this.ensureNumber(token), Math.trunc(value));
    }
  }

  getArray(name) {
    const array = this.arrays.get(name);
    if (!array) throw this.error(`no array named ${name} (DIM it first)`);
    return array;
  }

  checkedIndex(array, name, index) {
    if (!Number.isInteger(index) || index < 0 || index >= array.length) {
      throw this.error(`index ${index} outside ${name}[0..${array.length - 1}]`);
    }
    return index;
  }

  arrayCell(name, index) {
    const array = this.getArray(name);
    return array[this.checkedIndex(array, name, index)];
  }

  dim(name, size) {
    const count = Math.trunc(size);
    if (count <= 0) throw this.error("DIM size must be greater than 0");
    if (this.arrays.has(name)) {
      const current = this.arrays.get(name);
      if (current.length !== count) throw this.error(`${name} is already DIM'd at ${current.length}`);
      current.fill(0);
      return;
    }
    if (this.arrays.size >= LIMITS.arrays) throw this.error(`too many arrays (max ${LIMITS.arrays})`);
    if (this.arrayCells + count > LIMITS.arrayCells) throw this.error(`out of array space (max ${LIMITS.arrayCells} cells total)`);
    this.arrays.set(name, new Array(count).fill(0));
    this.arrayCells += count;
  }

  lifeStep(currentName, nextName, cols, rows) {
    const width = Math.trunc(cols);
    const height = Math.trunc(rows);
    if (width < 1 || height < 1 || width > LIMITS.canvasCols || height > LIMITS.canvasRows) {
      throw this.error(`LIFE size must be 1..${LIMITS.canvasCols} by 1..${LIMITS.canvasRows}`);
    }

    const current = this.getArray(currentName.replace(/^\$/, "").trim());
    const next = this.getArray(nextName.replace(/^\$/, "").trim());
    const cells = width * height;
    if (current.length < cells || next.length < cells) {
      throw this.error(`LIFE arrays must each have at least ${cells} cells`);
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let neighbours = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            neighbours += current[ny * width + nx] !== 0 ? 1 : 0;
          }
        }

        const alive = current[y * width + x] !== 0;
        next[y * width + x] = neighbours === 3 || (alive && neighbours === 2) ? 1 : 0;
      }
    }

    for (let i = 0; i < cells; i += 1) current[i] = next[i];
  }

  jump(label, subroutine) {
    const name = String(label).trim().replace(/^:/, "");
    if (!this.labels.has(name)) throw this.error(`label not found: ${name}`);
    if (subroutine) {
      if (this.callStack.length >= LIMITS.callDepth) {
        throw this.error(`GOSUB nested deeper than ${LIMITS.callDepth} (a RETURN is probably missing)`);
      }
      this.callStack.push(this.pc);
    }
    this.pc = this.labels.get(name);
  }

  compare(left, operator, right) {
    return {
      "=": left === right,
      "==": left === right,
      "!=": left !== right,
      "<>": left !== right,
      "<": left < right,
      "<=": left <= right,
      ">": left > right,
      ">=": left >= right
    }[operator] || false;
  }

  beginCanvas(cols, rows) {
    const width = Math.trunc(cols);
    const height = Math.trunc(rows);
    if (width < 1 || height < 1 || width > LIMITS.canvasCols || height > LIMITS.canvasRows) {
      throw this.error(`CANVAS size must be 1..${LIMITS.canvasCols} by 1..${LIMITS.canvasRows}`);
    }
    this.canvas = {
      cols: width,
      rows: height,
      cells: Array.from({ length: height }, () =>
        Array.from({ length: width }, () => ({ char: " ", color: "white" }))
      )
    };
    this.io.canvas(this.canvas);
  }

  clearCanvas() {
    for (const row of this.canvas.cells) {
      for (const cell of row) {
        cell.char = " ";
        cell.color = "white";
      }
    }
  }

  putCanvas(col, row, text) {
    const y = Math.trunc(row);
    if (y < 0 || y >= this.canvas.rows) return;
    [...String(text)].forEach((char, offset) => {
      const x = Math.trunc(col) + offset;
      if (x >= 0 && x < this.canvas.cols) this.canvas.cells[y][x] = { char, color: this.color };
    });
  }

  endCanvas() {
    if (this.canvas) {
      this.canvas = null;
      this.io.endCanvas();
    }
  }

  open(pathToken, modeToken) {
    this.closeFile();
    this.fok = 0;
    this.feof = 0;
    const path = normalizePath(this.expandText(pathToken));
    const mode = stripQuotes(modeToken).toLowerCase();
    if (!["read", "r", "write", "w", "append", "a", "update", "rw", "r+"].includes(mode)) {
      throw this.error("FOPEN mode must be read, write, append, or update");
    }
    const readable = ["read", "r", "update", "rw", "r+"].includes(mode);
    const writable = !["read", "r"].includes(mode);
    if (readable && !this.fileSystem.exists(path)) return;
    let content = this.fileSystem.read(path) || "";
    if (mode === "write" || mode === "w") {
      content = "";
      this.fileSystem.write(path, content);
    }
    this.openFile = {
      path,
      content,
      position: ["append", "a"].includes(mode) ? content.length : 0,
      readable,
      writable
    };
    this.fok = 1;
  }

  writeOpenFile(bytes) {
    const text = String(bytes);
    const start = this.openFile.position;
    const end = start + text.length;
    this.openFile.content = this.openFile.content.slice(0, start) + text + this.openFile.content.slice(end);
    this.openFile.position = end;
    this.fileSystem.write(this.openFile.path, this.openFile.content);
  }

  closeFile() {
    this.openFile = null;
  }

  // shared by HTTPGETBUF/HTMLTEXT/HTMLFEED url/HTMLSTR url. Returns the raw body or null,
  // and leaves $httpcode/$httpok set either way. Unlike the firmware there is no session
  // to pool here: fetch() and the browser own connection reuse.
  async fetchBytes(rawUrl) {
    this.httpcode = 0;
    this.httplen = 0;
    this.httptruncated = 0;
    this.httpok = 0;
    try {
      const baseUrl = globalThis.location?.href || "https://browser.invalid/";
      const url = new URL(rawUrl, baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("unsupported URL protocol");
      }
      const request = {
        url: url.href,
        method: "GET",
        headers: Object.fromEntries(this.httpHeaders)
      };
      if (this.io.authorizeHttp && !await this.io.authorizeHttp(request)) {
        this.httpcode = -2;
        this.io.output("HTTP request blocked by browser policy", "yellow");
        return null;
      }
      const response = await fetch(request.url, {
        method: "GET",
        headers: request.headers,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store"
      });
      this.httpcode = response.status;
      this.httpok = response.ok ? 1 : 0;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      this.httpcode = -1;
      return null;
    }
  }

  syncHtml() {
    if (!this.html) return;
    this.htmllines = this.html.lines;
    this.htmllinks = this.html.links;
    this.htmlbytes = this.html.bytes;
  }

  htmlBegin({ textPath, linkPath, base, wrapcol, maxlinks }) {
    this.htmlClose();
    const collectLinks = linkPath !== "-";
    this.html = new HtmlRenderer({ base, wrapcol, maxlinks, collectLinks });
    this.htmlTarget = { textPath, linkPath: collectLinks ? normalizePath(linkPath) : null };
    this.htmllines = 0;
    this.htmllinks = 0;
    this.htmlbytes = 0;
    this.htmlok = 1;
  }

  async htmlFeedSource(op, parts) {
    const kind = parts[0].toLowerCase();
    if (kind === "url") {
      if (parts.length < 2) throw this.error(`${op} url needs <url>`);
      const bytes = await this.fetchBytes(this.stringOperand(parts[1]));
      if (bytes) this.html.feed(bytes);
      this.syncHtml();
      this.httplen = this.htmlbytes;
      this.steps = 0;
      return;
    }
    if (kind === "buf") {
      let position = parts.length > 1 ? Math.max(0, this.valueOf(parts[1])) : 0;
      let length = parts.length > 2 ? this.valueOf(parts[2]) : this.bufLen - position;
      length = Math.min(length, this.bufLen - position);
      if (this.buf && length > 0) this.html.feed(this.buf.subarray(position, position + length));
      this.syncHtml();
      return;
    }
    if (kind === "text") {
      if (parts.length < 2) throw this.error(`${op} text needs <string>`);
      this.html.feed(new TextEncoder().encode(this.stringOperand(parts[1])));
      this.syncHtml();
      return;
    }
    throw this.error(`${op} source must be url, buf or text`);
  }

  htmlClose() {
    if (!this.html || !this.htmlTarget) {
      this.html = null;
      this.htmlTarget = null;
      return;
    }
    this.html.finish();
    this.syncHtml();
    const trailing = this.html.textLines.length ? "\n" : "";
    this.fileSystem.write(this.htmlTarget.textPath, this.html.textLines.join("\n") + trailing);
    if (this.htmlTarget.linkPath) {
      const linkTrailing = this.html.linkLines.length ? "\n" : "";
      this.fileSystem.write(this.htmlTarget.linkPath, this.html.linkLines.join("\n") + linkTrailing);
    }
    this.html = null;
    this.htmlTarget = null;
  }
}
