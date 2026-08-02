import { evaluateExpression } from "./dapp-runtime.js";

const COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "pink", "white"];
export const FILE_SYSTEM_LIMITS = Object.freeze({
  files: 2048,
  directories: 512,
  fileBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
  pathLength: 256
});

export const COMMAND_COMPATIBILITY = Object.freeze({
  faithful: Object.freeze(["alias", "apps", "battery", "calc", "cat", "cd", "clear", "cp", "del", "dice", "free", "help", "ls", "mkdir", "mv", "pwd", "reboot", "rm", "run", "status", "unalias", "uptime"]),
  adapted: Object.freeze(["dapper", "edit", "ip", "radio", "wifi"]),
  gateway: Object.freeze(["asuka", "ftp", "gb", "motoko", "ping", "slave", "ssh", "telnet", "usb"])
});

export function normalizePath(base = "/", target = "") {
  const raw = String(target || base || "/").replaceAll("\\", "/");
  const joined = raw.startsWith("/") ? raw : `${base}/${raw}`;
  const parts = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function sanitizeDappFilename(value) {
  const leaf = String(value || "").trim().replaceAll("\\", "/").split("/").pop() || "untitled";
  const base = leaf.replace(/\.dapp$/i, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^[.-]+|[.-]+$/g, "");
  return `${(base || "untitled").slice(0, 70)}.dapp`;
}

export function splitCommand(input, maxParts = 8) {
  const source = String(input).trim();
  const parts = [];
  let index = 0;
  while (index < source.length && parts.length < maxParts) {
    while (source[index] === " ") index += 1;
    if (index >= source.length) break;
    const quote = source[index] === `"` || source[index] === `'` ? source[index++] : null;
    const start = index;
    if (quote) {
      while (index < source.length && source[index] !== quote) index += 1;
      parts.push(source.slice(start, index));
      if (source[index] === quote) index += 1;
    } else {
      while (index < source.length && source[index] !== " ") index += 1;
      parts.push(source.slice(start, index));
    }
  }
  return parts;
}

function parentPath(path) {
  const clean = normalizePath("/", path);
  if (clean === "/") return "/";
  const slash = clean.lastIndexOf("/");
  return slash === 0 ? "/" : clean.slice(0, slash);
}

function leafName(path) {
  return normalizePath("/", path).split("/").pop() || "/";
}

function isSystemAppPath(path) {
  const resolved = normalizePath("/", path);
  return resolved === "/system/apps" || resolved.startsWith("/system/apps/");
}

export class VirtualFileSystem {
  constructor({ storage = globalThis.localStorage, key = "doll-os-emulator-fs-v1", bundledApps = {}, systemAppIds = Object.keys(bundledApps) } = {}) {
    this.storage = storage;
    this.key = key;
    this.bundledApps = bundledApps;
    this.systemAppIds = new Set(systemAppIds);
    this.files = new Map();
    this.directories = new Set(["/"]);
    this.load();
    this.seedSystem();
  }

  load() {
    if (!this.storage) return;
    try {
      const saved = JSON.parse(this.storage.getItem(this.key));
      if (!saved) return;
      this.restore(saved);
    } catch {
      this.files = new Map();
      this.directories = new Set(["/"]);
    }
  }

  persist() {
    if (!this.storage) return;
    this.storage.setItem(this.key, JSON.stringify({
      files: Object.fromEntries(this.files),
      directories: [...this.directories]
    }));
  }

  seedSystem() {
    for (const path of ["/apps", "/system", "/system/apps", "/system/conf", "/sd", "/sd/apps"]) {
      this.directories.add(path);
    }
    for (const path of [...this.files.keys()]) {
      if (isSystemAppPath(path)) this.files.delete(path);
    }
    for (const id of this.systemAppIds) {
      const app = this.bundledApps[id];
      if (!app) continue;
      const source = typeof app === "string" ? app : app.source;
      const path = `/system/apps/${id}.dapp`;
      this.files.set(path, source);
    }
    if (!this.files.has("/system/conf/alias.dsys")) {
      this.files.set("/system/conf/alias.dsys", "# DOLL-OS command aliases\n# Format: name=command expansion\nnano=edit\n");
    }
    this.persist();
  }

  exists(path) {
    const resolved = normalizePath("/", path);
    return this.files.has(resolved) || this.directories.has(resolved);
  }

  isDirectory(path) {
    return this.directories.has(normalizePath("/", path));
  }

  read(path) {
    return this.files.get(normalizePath("/", path)) ?? null;
  }

  write(path, content) {
    const resolved = normalizePath("/", path);
    const value = String(content);
    if (isSystemAppPath(resolved) || resolved.length > FILE_SYSTEM_LIMITS.pathLength
        || value.length > FILE_SYSTEM_LIMITS.fileBytes || !this.directories.has(parentPath(resolved))) return false;
    if (!this.files.has(resolved) && this.files.size >= FILE_SYSTEM_LIMITS.files) return false;
    const currentSize = this.files.get(resolved)?.length || 0;
    const totalSize = [...this.files.values()].reduce((sum, file) => sum + file.length, 0) - currentSize + value.length;
    if (totalSize > FILE_SYSTEM_LIMITS.totalBytes) return false;
    this.files.set(resolved, value);
    this.persist();
    return true;
  }

  mkdir(path) {
    const resolved = normalizePath("/", path);
    if (isSystemAppPath(resolved) || resolved.length > FILE_SYSTEM_LIMITS.pathLength
        || this.directories.size >= FILE_SYSTEM_LIMITS.directories
        || this.exists(resolved) || !this.directories.has(parentPath(resolved))) return false;
    this.directories.add(resolved);
    this.persist();
    return true;
  }

  delete(path) {
    const resolved = normalizePath("/", path);
    if (isSystemAppPath(resolved)) return false;
    if (!this.files.delete(resolved)) return false;
    this.persist();
    return true;
  }

  remove(path, recursive = false) {
    const resolved = normalizePath("/", path);
    if (["/", "/system", "/system/apps", "/sd"].includes(resolved) || isSystemAppPath(resolved)) return false;
    if (this.files.delete(resolved)) {
      this.persist();
      return true;
    }
    if (!this.directories.has(resolved)) return false;
    const prefix = `${resolved}/`;
    const hasChildren = [...this.files.keys(), ...this.directories].some(item => item.startsWith(prefix));
    if (hasChildren && !recursive) return false;
    for (const file of [...this.files.keys()]) if (file.startsWith(prefix)) this.files.delete(file);
    for (const directory of [...this.directories]) if (directory === resolved || directory.startsWith(prefix)) this.directories.delete(directory);
    this.persist();
    return true;
  }

  list(path) {
    const resolved = normalizePath("/", path);
    if (!this.directories.has(resolved)) return null;
    const prefix = resolved === "/" ? "/" : `${resolved}/`;
    const rows = new Map();
    for (const directory of this.directories) {
      if (!directory.startsWith(prefix) || directory === resolved) continue;
      const rest = directory.slice(prefix.length);
      if (!rest.includes("/")) rows.set(rest, { name: rest, directory: true, size: 0 });
    }
    for (const [file, content] of this.files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest.includes("/")) rows.set(rest, { name: rest, directory: false, size: content.length });
    }
    return [...rows.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }

  copy(source, destination) {
    const from = normalizePath("/", source);
    let to = normalizePath("/", destination);
    if (!this.files.has(from)) return null;
    if (this.directories.has(to)) to = normalizePath(to, leafName(from));
    if (!this.directories.has(parentPath(to))) return null;
    if (!this.write(to, this.files.get(from))) return null;
    return to;
  }

  move(source, destination) {
    const from = normalizePath("/", source);
    if (isSystemAppPath(from)) return null;
    const to = this.copy(from, destination);
    if (!to) return null;
    this.files.delete(from);
    this.persist();
    return to;
  }

  snapshot() {
    const writableFiles = [...this.files].filter(([path]) => !isSystemAppPath(path));
    return JSON.stringify({ files: Object.fromEntries(writableFiles), directories: [...this.directories] }, null, 2);
  }

  restore(snapshot) {
    const parsed = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)
        || !Array.isArray(parsed.directories)) throw new Error("invalid disk image");
    if (Object.keys(parsed.files).length > FILE_SYSTEM_LIMITS.files
        || parsed.directories.length > FILE_SYSTEM_LIMITS.directories) throw new Error("disk image is too large");

    const directories = new Set(["/"]);
    for (const rawPath of parsed.directories) {
      if (typeof rawPath !== "string" || !rawPath.startsWith("/") || rawPath.length > FILE_SYSTEM_LIMITS.pathLength) throw new Error("invalid directory path");
      const path = normalizePath("/", rawPath);
      if (path !== rawPath || isSystemAppPath(path)) continue;
      directories.add(path);
    }
    for (const required of ["/apps", "/system", "/system/apps", "/system/conf", "/sd", "/sd/apps"]) directories.add(required);

    const files = new Map();
    let totalBytes = 0;
    for (const [rawPath, content] of Object.entries(parsed.files)) {
      if (typeof content !== "string" || !rawPath.startsWith("/") || rawPath.length > FILE_SYSTEM_LIMITS.pathLength) throw new Error("invalid file entry");
      const path = normalizePath("/", rawPath);
      if (path !== rawPath || isSystemAppPath(path)) continue;
      if (content.length > FILE_SYSTEM_LIMITS.fileBytes || !directories.has(parentPath(path))) throw new Error("invalid file entry");
      totalBytes += content.length;
      if (totalBytes > FILE_SYSTEM_LIMITS.totalBytes) throw new Error("disk image is too large");
      files.set(path, content);
    }
    this.files = files;
    this.directories = directories;
    this.directories.add("/");
    this.seedSystem();
  }

  factoryReset() {
    this.files.clear();
    this.directories = new Set(["/"]);
    this.seedSystem();
  }
}

function calculate(expression) {
  const result = evaluateExpression(String(expression).replaceAll("_", " "));
  if (!Number.isFinite(result)) throw new Error("invalid result");
  return result;
}

export class DollMachine {
  constructor({ fileSystem, bundledApps = {}, now = () => performance.now() }) {
    this.fileSystem = fileSystem;
    this.bundledApps = bundledApps;
    this.now = now;
    this.bootedAt = now();
    this.battery = 100;
    this.volume = 12;
    this.wifiConnected = true;
    this.ssid = "BROWSER-NET";
    this.ip = "192.168.4.23";
    this.sdMounted = true;
    this.radioPlaying = false;
  }

  reboot() {
    this.bootedAt = this.now();
    this.radioPlaying = false;
  }

  uptimeSeconds() {
    return Math.max(0, Math.floor((this.now() - this.bootedAt) / 1000));
  }
}

const HELP_LINES = [
  "Commands: alias, apps, asuka, battery, calc, cat, cd, clear, cp, dapper,",
  "          del, dice, edit, free, ftp, gb, help, ip, ls, mkdir, motoko, mv,",
  "          ping, pwd, radio, reboot, rm, run, slave, ssh, status, telnet,",
  "          unalias, uptime, usb, wifi"
];

export class DollShell {
  constructor(machine, hooks = {}) {
    this.machine = machine;
    this.fs = machine.fileSystem;
    this.hooks = hooks;
    this.cwd = "/";
    this.history = [];
    this.historyIndex = -1;
    this.historyDraft = "";
  }

  prompt() {
    const path = this.cwd.length > 24 ? `...${this.cwd.slice(-(24 - 3))}` : this.cwd;
    return `${path} > `;
  }

  write(text = "", color = "white") {
    this.hooks.output?.(String(text), COLORS.includes(color) ? color : "white");
  }

  aliases() {
    const result = new Map();
    for (const line of (this.fs.read("/system/conf/alias.dsys") || "").split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#") || !clean.includes("=")) continue;
      const split = clean.indexOf("=");
      result.set(clean.slice(0, split).trim(), clean.slice(split + 1).trim());
    }
    return result;
  }

  saveAliases(aliases) {
    const lines = ["# DOLL-OS command aliases", "# Format: name=command expansion"];
    for (const [name, expansion] of aliases) lines.push(`${name}=${expansion}`);
    this.fs.write("/system/conf/alias.dsys", `${lines.join("\n")}\n`);
  }

  expandAlias(command) {
    let expanded = command;
    for (let depth = 0; depth < 4; depth += 1) {
      const first = splitCommand(expanded, 2)[0];
      const replacement = this.aliases().get(first);
      if (!replacement) return expanded;
      const tail = expanded.trim().slice(first.length).trim();
      expanded = `${replacement}${tail ? ` ${tail}` : ""}`;
    }
    this.write("alias: expansion stopped after 4 levels", "red");
    return expanded;
  }

  recall(step, draft = "") {
    if (!this.history.length) return draft;
    if (this.historyIndex < 0) {
      if (step > 0) return draft;
      this.historyDraft = draft;
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex += step;
      if (this.historyIndex < 0) this.historyIndex = 0;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = -1;
        return this.historyDraft;
      }
    }
    return this.history[this.historyIndex];
  }

  async execute(command) {
    const entered = String(command).trim();
    this.historyIndex = -1;
    this.write(`${this.prompt()}${entered}`, "cyan");
    if (!entered) return;
    this.history.push(entered);
    if (this.history.length > 20) this.history.shift();

    const dispatch = this.expandAlias(entered);
    const parts = splitCommand(dispatch, 8);
    const verb = (parts[0] || "").toLowerCase();
    if (verb === "clear") {
      this.hooks.clear?.();
      return;
    }

    const handler = this[`command_${verb.replaceAll("-", "_")}`];
    if (!handler) {
      this.write(`Unknown command: ${dispatch}`, "red");
      return;
    }
    await handler.call(this, parts);
  }

  command_help() { HELP_LINES.forEach(line => this.write(line)); }
  command_pwd() { this.write(this.cwd); }

  command_cd(parts) {
    const target = normalizePath(this.cwd, parts[1] || "/");
    if (!this.fs.isDirectory(target)) return this.write(`cd: ${target} not found`, "red");
    if (target.startsWith("/sd") && !this.machine.sdMounted) return this.write("SD not mounted (enable it in MACHINE STATE)", "red");
    this.cwd = target;
  }

  command_ls(parts) {
    const target = normalizePath(this.cwd, parts[1] || "");
    if (target.startsWith("/sd") && !this.machine.sdMounted) return this.write("SD not mounted (enable it in MACHINE STATE)", "red");
    const rows = this.fs.list(target);
    if (!rows) return this.write(`ls: ${target} not found`, "red");
    this.write(target);
    if (!rows.length) return this.write("(empty)");
    rows.forEach(row => this.write(row.directory ? `${row.name}/` : `${row.name}  ${row.size} B`, row.directory ? "cyan" : "white"));
  }

  command_cat(parts) {
    if (!parts[1]) return this.write("Usage: cat <file>");
    const path = normalizePath(this.cwd, parts[1]);
    if (this.fs.isDirectory(path)) return this.write(`cat: ${path} is a directory`, "red");
    const content = this.fs.read(path);
    if (content === null) return this.write(`cat: ${path} not found`, "red");
    if (!content.length) return this.write("(empty)");
    content.replaceAll("\r\n", "\n").split("\n").forEach(line => this.write(line));
  }

  command_mkdir(parts) {
    if (!parts[1]) return this.write("Usage: mkdir <dir>");
    const path = normalizePath(this.cwd, parts[1]);
    const created = this.fs.mkdir(path);
    this.write(created ? `mkdir: created ${path}` : `mkdir: could not create ${path}`, created ? "green" : "red");
  }

  command_rm(parts) { this.removeCommand("rm", parts); }
  command_del(parts) { this.removeCommand("del", parts); }
  removeCommand(name, parts) {
    const recursive = parts[1] === "-r" || parts[1] === "-R";
    const target = parts[recursive ? 2 : 1];
    if (!target) return this.write(`Usage: ${name} [-r] <path>`);
    const path = normalizePath(this.cwd, target);
    const removed = this.fs.remove(path, recursive);
    this.write(removed ? `${name}: removed ${path}` : `${name}: could not remove ${path}`, removed ? "green" : "red");
  }

  command_cp(parts) {
    if (!parts[1] || !parts[2]) return this.write("Usage: cp <source> <dest>");
    const source = normalizePath(this.cwd, parts[1]);
    const copied = this.fs.copy(source, normalizePath(this.cwd, parts[2]));
    this.write(copied ? `cp: ${source} -> ${copied}` : `cp: could not copy ${source}`, copied ? "green" : "red");
  }

  command_mv(parts) {
    if (!parts[1] || !parts[2]) return this.write("Usage: mv <source> <dest>");
    const source = normalizePath(this.cwd, parts[1]);
    const moved = this.fs.move(source, normalizePath(this.cwd, parts[2]));
    this.write(moved ? `mv: ${source} -> ${moved}` : `mv: could not move ${source}`, moved ? "green" : "red");
  }

  command_alias(parts) {
    const aliases = this.aliases();
    if (parts.length === 1) {
      this.write("Aliases", "cyan");
      this.write("-------");
      if (!aliases.size) this.write("(none)");
      aliases.forEach((expansion, name) => this.write(`${name}=${expansion}`));
      this.write("File: /system/conf/alias.dsys", "cyan");
      return;
    }
    if (["rm", "del", "remove"].includes(parts[1])) return this.removeAlias(parts[2]);
    const name = parts[1];
    if (!/^[^\s='"#]{1,24}$/.test(name) || ["alias", "unalias", "clear"].includes(name)) return this.write(`alias: invalid or reserved name: ${name}`, "red");
    if (parts.length === 2) return this.write(aliases.has(name) ? `${name}=${aliases.get(name)}` : `alias: not found: ${name}`, aliases.has(name) ? "white" : "red");
    const expansion = parts.slice(2).join(" ");
    if (splitCommand(expansion, 1)[0] === name) return this.write("alias: refusing self-referential alias", "red");
    aliases.set(name, expansion.slice(0, 160));
    this.saveAliases(aliases);
    this.write(`alias: ${name}=${aliases.get(name)}`, "green");
  }

  command_unalias(parts) { this.removeAlias(parts[1]); }
  removeAlias(name) {
    if (!name) return this.write("Usage: unalias <name>", "red");
    const aliases = this.aliases();
    if (!aliases.delete(name)) return this.write(`alias: not found: ${name}`, "red");
    this.saveAliases(aliases);
    this.write(`alias: removed ${name}`, "green");
  }

  command_apps() {
    const ids = new Set();
    for (const root of ["/sd/apps", "/apps", "/system/apps"]) {
      for (const row of this.fs.list(root) || []) if (!row.directory && row.name.endsWith(".dapp")) ids.add(row.name.slice(0, -5));
    }
    this.write("Installed apps", "cyan");
    [...ids].sort().forEach(id => this.write(id));
    this.write(`${ids.size} app(s)`);
  }

  findApp(name) {
    const requested = String(name || "").endsWith(".dapp") ? String(name) : `${name}.dapp`;
    if (requested.includes("/")) return this.fs.exists(normalizePath(this.cwd, requested)) ? normalizePath(this.cwd, requested) : null;
    for (const root of ["/sd/apps", "/apps", "/system/apps"]) {
      const path = `${root}/${requested}`;
      if (this.fs.exists(path) && (this.machine.sdMounted || !path.startsWith("/sd"))) return path;
    }
    return null;
  }

  async command_run(parts) {
    if (!parts[1]) return this.write("Usage: run <app>");
    const path = this.findApp(parts[1]);
    if (!path) return this.write(`run: app not found: ${parts[1]}`, "red");
    await this.hooks.runApp?.(path, this.fs.read(path));
  }

  command_edit(parts) {
    if (!parts[1]) return this.write("Usage: edit <file>");
    const path = normalizePath(this.cwd, parts[1]);
    this.hooks.edit?.(path, this.fs.read(path) || "");
  }

  async command_dapper(parts) {
    const action = (parts[1] || "help").toLowerCase();
    const query = action === "search" ? parts.slice(2).join(" ") : (parts[2] || "");
    const dapper = this.hooks.dapper;
    if (action === "runtime") {
      this.write("Board: fnk0104-web");
      this.write("AppRunner: 1.7.0");
      this.write("Package format: 1");
    } else if (action === "remove") {
      const id = query.replace(/@.+$/, "");
      const removed = this.fs.delete(`/apps/${id}.dapp`) || this.fs.delete(`/sd/apps/${id}.dapp`);
      this.write(removed ? `dapper: removed ${id}` : `dapper: ${id} is not installed`, removed ? "green" : "red");
      return;
    }
    if (["help", ""].includes(action)) return this.write("dapper search [text] | info <id> | install <id>[@version] [--internal|--sd] | remove <id> | refresh | runtime");
    if (!dapper) return this.write("dapper: repository client is unavailable", "red");
    try {
      if (action === "refresh") {
        const records = await dapper.refresh(true);
        this.write(`Dapper: catalog ready (${records.length} compatible artifacts)`, "green");
      } else if (action === "search") {
        this.write("Dapper: refreshing catalog...", "cyan");
        const found = await dapper.search(query);
        found.forEach(app => this.write(`${app.id} ${app.version} - ${app.name}`, "cyan"));
        this.write(`${found.length} package(s)`);
      } else if (action === "info") {
        const app = await dapper.select(query);
        this.write(`${app.name} (${app.id})`, "cyan");
        this.write(`Version: ${app.version}`);
        this.write(app.summary || "");
        this.write(`Size: ${app.size} bytes`);
      } else if (action === "install") {
        if (!query) return this.write("Usage: dapper install <id>[@version] [--internal|--sd]", "red");
        const root = parts.includes("--sd") ? "/sd/apps" : "/apps";
        if (root.startsWith("/sd") && !this.machine.sdMounted) return this.write("dapper: SD not mounted", "red");
        this.write(`Dapper: downloading ${query}...`, "cyan");
        const installed = await dapper.install(query, this.fs, root);
        this.write(`Dapper: installed ${installed.record.id} ${installed.record.version} to ${installed.path}`, "green");
      } else if (action === "doctor") {
        this.write("Dapper: browser installs use verified HTTPS + SHA-256 artifacts", "green");
      } else if (action === "update") {
        this.write("dapper update: reinstall the desired package to fetch its newest compatible version", "yellow");
      } else this.write("dapper: unknown subcommand", "red");
    } catch (error) {
      this.write(`dapper: ${error.message}`, "red");
    }
  }

  command_calc(parts) {
    if (!parts[1]) return this.write("Syntax: calc (expression)", "pink");
    if (parts[1] === "help") {
      this.write("Supported Functions", "pink");
      this.write("BASIC: + - * / ^ %");
      this.write("abs acos asin atan atan2 ceil cos cosh exp floor ln log log10 pow sin sinh sqrt tan tanh");
      return;
    }
    try {
      const result = calculate(parts[1]);
      this.write(parts[1], "pink");
      this.write(result.toFixed(2), "cyan");
    } catch {
      this.write("calc: invalid expression", "red");
    }
  }

  command_dice(parts) {
    if (!parts[1]) return this.write("Syntax: Dice [numSides] [numRolls]", "cyan");
    const sides = Math.max(1, Math.min(1000000, Number.parseInt(parts[1], 10) || 6));
    const rolls = Math.max(1, Math.min(100, Number.parseInt(parts[2], 10) || 1));
    const values = Array.from({ length: rolls }, () => 1 + Math.floor(Math.random() * sides));
    this.write(`Your roll: ${values.join(", ")}`, ["cyan", "pink", "green"][Math.floor(Math.random() * 3)]);
  }

  command_battery() { this.write(`Battery: ${this.machine.battery}% (simulated browser device)`, "cyan"); }
  command_free(parts) {
    const used = [...this.fs.files.values()].reduce((sum, value) => sum + value.length, 0);
    this.write(`TOTAL FREE: ${Math.max(0, 8 * 1024 * 1024 - used)}`, "red");
    this.write(`VIRTUAL STORAGE USED: ${used}`);
    if (parts[1] === "details") this.write("Browser memory is managed by the JavaScript engine; hardware heap counters are unavailable.", "cyan");
  }

  command_uptime() {
    const total = this.machine.uptimeSeconds();
    const days = Math.floor(total / 86400);
    const hours = Math.floor(total % 86400 / 3600);
    const minutes = Math.floor(total % 3600 / 60);
    const seconds = total % 60;
    this.write(`Uptime: ${days} days, ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`);
  }

  command_status() {
    this.write("");
    this.write("Wi-Fi status", "cyan");
    this.write("-----------");
    this.write(`Router: ${this.machine.wifiConnected ? "connected" : "disconnected"}`);
    if (this.machine.wifiConnected) {
      this.write(`Router SSID: ${this.machine.ssid}`);
      this.write(`Station IP: ${this.machine.ip}`);
      this.write("Signal: -42 dBm (simulated)");
    }
    this.write("");
  }

  command_wifi(parts) {
    const action = (parts[1] || "status").toLowerCase();
    if (action === "scan") {
      this.write("Networks found: 3", "cyan");
      this.write("BROWSER-NET  -42 dBm  WPA2");
      this.write("sadgirlsclub  -61 dBm  WPA2");
      this.write("ESP32-LAB     -75 dBm  OPEN");
    } else if (action === "connect") {
      this.machine.wifiConnected = true;
      this.machine.ssid = parts[2] || "BROWSER-NET";
      this.write(`Connected to ${this.machine.ssid} (simulated)`, "green");
      this.hooks.stateChanged?.();
    } else if (action === "disconnect") {
      this.machine.wifiConnected = false;
      this.write("WiFi disconnected", "yellow");
      this.hooks.stateChanged?.();
    } else this.command_status();
  }

  command_ip(parts) {
    if (!this.machine.wifiConnected) return this.write("ip: WiFi not connected. Run 'wifi connect' first.", "red");
    if (parts[1] === "scan" || parts[1] === "arp") return this.write(`ip ${parts[1]}: raw network discovery is unavailable in browsers`, "yellow");
    this.write(`IP: ${this.machine.ip}`);
    this.write("Gateway: 192.168.4.1");
    this.write("Subnet: 255.255.255.0");
    this.write("MAC: 02:44:4F:4C:4C:53");
    this.write("DNS: 192.168.4.1");
  }

  command_radio(parts) {
    const action = (parts[1] || "status").toLowerCase();
    if (action === "vol") this.machine.volume = Math.max(0, Math.min(21, Number.parseInt(parts[2], 10) || 0));
    else if (action === "stop") this.machine.radioPlaying = false;
    else if (action === "play") this.machine.radioPlaying = true;
    this.write(`Radio: ${this.machine.radioPlaying ? "playing" : "stopped"}, volume ${this.machine.volume}${action === "play" ? " (browser audio requires a compatible stream URL)" : ""}`, this.machine.radioPlaying ? "green" : "cyan");
    this.hooks.stateChanged?.();
  }

  command_reboot() {
    this.write("Restarting...");
    this.machine.reboot();
    this.cwd = "/";
    this.hooks.reboot?.();
  }

  unsupported(name, detail) { this.write(`${name}: ${detail}`, "yellow"); }
  command_asuka() { this.unsupported("asuka", "requires an OpenAI-compatible proxy; browser secrets are not enabled"); }
  command_ftp() { this.unsupported("ftp", "browsers cannot expose an FTP server"); }
  command_gb() { this.unsupported("gb", "Game Boy WASM support is planned but not included yet"); }
  command_motoko() { this.unsupported("motoko", "MQTT requires a WebSocket-capable broker adapter"); }
  command_ping() { this.unsupported("ping", "raw ICMP is unavailable in browsers"); }
  command_slave() { this.unsupported("slave", "DS-Slave UART hardware is simulated by your keyboard"); }
  command_ssh() { this.unsupported("ssh", "raw SSH needs a WebSocket gateway"); }
  command_telnet() { this.unsupported("telnet", "raw TCP needs a WebSocket gateway"); }
  command_usb() { this.unsupported("usb", "use EXPORT DISK to download the virtual filesystem"); }
}
