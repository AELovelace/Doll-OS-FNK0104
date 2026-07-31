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

export class DappRuntime {
  constructor(io, fileSystem) {
    this.io = io;
    this.fileSystem = fileSystem;
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
    this.httpHeaders = new Map();
    this.openFile = null;
    this.canvas = null;
    this.stopRequested = false;
    this.keyQueue.length = 0;
    this.startedAt = performance.now();

    for (let index = 0; index < this.lines.length; index += 1) {
      const line = this.lines[index].trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
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
        this.io.input(prompt, resolve, op === "INPUTSECRET");
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
      this.io.wave?.({ channel, waveform, frequency, level });
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
        const response = await fetch(this.stringOperand(parts[1]), {
          method: op === "HTTPPOST" ? "POST" : "GET",
          headers: Object.fromEntries(this.httpHeaders),
          body: op === "HTTPPOST" ? this.stringOperand(parts[2]) : undefined
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
      audiook: this.io.wave ? 1 : 0,
      fok: this.fok,
      feof: this.feof,
      httpcode: this.httpcode,
      httplen: this.httplen,
      httptruncated: this.httptruncated,
      httpok: this.httpok,
      jsonok: this.jsonok,
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
}
