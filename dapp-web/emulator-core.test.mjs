import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DappRuntime } from "./dapp-runtime.js";
import { bundledApps, firmwareAppIds } from "./bundled-apps.js";
import { COMMAND_COMPATIBILITY, FILE_SYSTEM_LIMITS, DollMachine, DollShell, VirtualFileSystem, normalizePath, sanitizeDappFilename, splitCommand } from "./emulator-core.js";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function rig(extraHooks = {}) {
  const bundledApps = {
    hello: { source: "# @id hello\n# @name Hello\n# @version 1.0.0\nPRINT hello\nEND" }
  };
  const fileSystem = new VirtualFileSystem({ storage: new MemoryStorage(), bundledApps });
  let now = 1000;
  const machine = new DollMachine({ fileSystem, bundledApps, now: () => now });
  const output = [];
  const events = {};
  const shell = new DollShell(machine, {
    output: (text, color) => output.push({ text, color }),
    clear: () => { events.cleared = true; },
    runApp: async (path, source) => { events.run = { path, source }; },
    reboot: () => { events.rebooted = true; },
    ...extraHooks
  });
  return { bundledApps, fileSystem, machine, shell, output, events, tick: value => { now += value; } };
}

test("paths normalize against cwd and command parsing preserves quoted arguments", () => {
  assert.equal(normalizePath("/sd/apps", "../notes.txt"), "/sd/notes.txt");
  assert.equal(normalizePath("/", "../../apps"), "/apps");
  assert.deepEqual(splitCommand(`alias greet "run hello world"`), ["alias", "greet", "run hello world"]);
});

test("studio filenames stay inside /apps and always use the .dapp extension", () => {
  assert.equal(sanitizeDappFilename("../../my tiny app"), "my-tiny-app.dapp");
  assert.equal(sanitizeDappFilename("snake.dapp"), "snake.dapp");
  assert.equal(sanitizeDappFilename("..."), "untitled.dapp");
});

test("the emulator page wires its editor to the shared device runtime", async () => {
  const [html, source, css, mode] = await Promise.all([
    readFile(new URL("./emulator.html", import.meta.url), "utf8"),
    readFile(new URL("./emulator.js", import.meta.url), "utf8"),
    readFile(new URL("./emulator.css", import.meta.url), "utf8"),
    readFile(new URL("./emulator-mode.js", import.meta.url), "utf8")
  ]);
  for (const id of ["studio-editor", "studio-highlight", "studio-line-numbers", "studio-filename", "studio-save", "studio-run", "display"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(source, /const runtime = new DappRuntime\(io, fileSystem/);
  assert.match(source, /submitShellCommand\(`run \$\{path\}`\)/);
  assert.match(source, /const path = `\/apps\/\$\{filename\}`/);
  assert.match(html, /emulator-mode\.js/);
  assert.match(mode, /terminal-embed/);
  assert.match(css, /\.terminal-embed canvas/);
  assert.match(source, /new ResizeObserver\(resizeTerminalDisplay\)/);
});

test("every firmware shell command has an explicit web compatibility classification", async () => {
  const source = await readFile(new URL("../CommandProcessor.ino", import.meta.url), "utf8");
  const firmwareCommands = [...source.matchAll(/\{\s*"([a-z]+)"\s*,\s*[a-zA-Z]+\s*\}/g)].map(match => match[1]);
  firmwareCommands.push("clear");
  const webCommands = Object.values(COMMAND_COMPATIBILITY).flat();
  assert.deepEqual([...new Set(webCommands)].sort(), [...new Set(firmwareCommands)].sort());
});

test("the static bundle contains exactly the firmware-burned app set", async () => {
  const source = await readFile(new URL("../BundledApps.ino", import.meta.url), "utf8");
  const firmware = [...source.matchAll(/"\/system\/apps\/([a-z0-9-]+)\.dapp"/g)].map(match => match[1]);
  assert.deepEqual([...firmwareAppIds].sort(), [...new Set(firmware)].sort());
  assert.deepEqual(Object.keys(bundledApps).sort(), [...new Set(firmware)].sort());
});

test("virtual filesystem seeds system apps, preserves binary strings, and round-trips snapshots", () => {
  const { fileSystem, bundledApps } = rig();
  assert.equal(fileSystem.read("/system/apps/hello.dapp"), bundledApps.hello.source);
  const binary = String.fromCharCode(0, 10, 255, 65);
  assert.equal(fileSystem.write("/apps/data.bin", binary), true);
  assert.equal(fileSystem.read("/apps/data.bin"), binary);
  const snapshot = fileSystem.snapshot();
  fileSystem.delete("/apps/data.bin");
  fileSystem.restore(snapshot);
  assert.equal(fileSystem.read("/apps/data.bin"), binary);
});

test("only firmware-selected apps are burned in while the full catalog remains installable", async () => {
  const bundledApps = {
    burned: { source: "# @id burned\n# @version 1.0.0\nEND" },
    download: { source: "# @id download\n# @version 1.0.0\nEND" }
  };
  const fileSystem = new VirtualFileSystem({ storage: new MemoryStorage(), bundledApps, systemAppIds: ["burned"] });
  const machine = new DollMachine({ fileSystem, bundledApps });
  const output = [];
  const shell = new DollShell(machine, {
    output: text => output.push(text),
    dapper: {
      async install(_spec, fs) {
        fs.write("/apps/download.dapp", bundledApps.download.source);
        return { record: { id: "download", version: "1.0.0" }, path: "/apps/download.dapp" };
      }
    }
  });
  assert.equal(fileSystem.exists("/system/apps/burned.dapp"), true);
  assert.equal(fileSystem.exists("/system/apps/download.dapp"), false);
  await shell.execute("dapper install download");
  assert.equal(fileSystem.exists("/apps/download.dapp"), true);
});

test("system apps are immutable and imported disks are size bounded", () => {
  const { fileSystem } = rig();
  assert.equal(fileSystem.write("/system/apps/hello.dapp", "changed"), false);
  assert.equal(fileSystem.delete("/system/apps/hello.dapp"), false);
  assert.throws(() => fileSystem.restore({
    directories: ["/", "/apps"],
    files: { "/apps/huge.bin": "x".repeat(FILE_SYSTEM_LIMITS.fileBytes + 1) }
  }), /invalid file entry/);
  fileSystem.restore({
    directories: ["/", "/apps", "/system/apps"],
    files: { "/system/apps/hello.dapp": "malicious", "/apps/note.txt": "safe" }
  });
  assert.notEqual(fileSystem.read("/system/apps/hello.dapp"), "malicious");
  assert.equal(fileSystem.read("/apps/note.txt"), "safe");
  assert.equal(fileSystem.snapshot().includes("/system/apps/hello.dapp"), false);
});

test("shell supports filesystem navigation and mutation", async () => {
  const { shell, fileSystem, output } = rig();
  await shell.execute("mkdir docs");
  await shell.execute("cd docs");
  fileSystem.write("/docs/note.txt", "one\ntwo");
  await shell.execute("cat note.txt");
  await shell.execute("cp note.txt copy.txt");
  await shell.execute("mv copy.txt moved.txt");
  await shell.execute("rm moved.txt");
  assert.equal(shell.cwd, "/docs");
  assert.equal(fileSystem.exists("/docs/moved.txt"), false);
  assert.ok(output.some(line => line.text === "one"));
  assert.ok(output.some(line => line.text === "rm: removed /docs/moved.txt" && line.color === "green"));
});

test("aliases persist and expand before dispatch", async () => {
  const { shell, output } = rig();
  await shell.execute("alias where pwd");
  await shell.execute("cd /apps");
  await shell.execute("where");
  assert.ok(output.some(line => line.text === "alias: where=pwd"));
  assert.equal(output.at(-1).text, "/apps");
});

test("run resolves installed apps before system fallbacks", async () => {
  const { shell, fileSystem, events } = rig();
  fileSystem.write("/apps/hello.dapp", "PRINT local\nEND");
  await shell.execute("run hello");
  assert.deepEqual(events.run, { path: "/apps/hello.dapp", source: "PRINT local\nEND" });
});

test("Dapper delegates downloads to the verified repository client", async () => {
  let called = false;
  const { shell, fileSystem, output } = rig({
    dapper: {
      async install(spec, fs, root) {
        called = true;
        assert.equal(spec, "hello");
        assert.equal(root, "/apps");
        fs.write("/apps/hello.dapp", "PRINT downloaded\nEND");
        return { record: { id: "hello", version: "2.0.0" }, path: "/apps/hello.dapp" };
      }
    }
  });
  await shell.execute("dapper install hello");
  assert.equal(called, true);
  assert.equal(fileSystem.exists("/apps/hello.dapp"), true);
  assert.ok(output.some(line => line.text.includes("installed hello")));
});

test("reboot resets uptime and shell cwd without erasing files", async () => {
  const { shell, fileSystem, machine, events, tick } = rig();
  fileSystem.write("/apps/save.txt", "still here");
  shell.cwd = "/apps";
  tick(9000);
  assert.equal(machine.uptimeSeconds(), 9);
  await shell.execute("reboot");
  assert.equal(machine.uptimeSeconds(), 0);
  assert.equal(shell.cwd, "/");
  assert.equal(fileSystem.read("/apps/save.txt"), "still here");
  assert.equal(events.rebooted, true);
});

test("DappRuntime accepts live emulator built-ins", async () => {
  const { fileSystem, machine, shell } = rig();
  machine.battery = 37;
  machine.wifiConnected = false;
  shell.cwd = "/sd/apps";
  const runtime = new DappRuntime({
    output() {}, clear() {}, status() {}, input() {}, canvas() {}, endCanvas() {}, waveStop() {}
  }, fileSystem, {
    battery: () => machine.battery,
    wifi: () => Number(machine.wifiConnected),
    cwd: () => shell.cwd
  });
  const result = await runtime.run("SET b $battery\nSET w $wifi\nSETSTR here $cwd\nEND");
  assert.equal(result.ok, true);
  assert.equal(runtime.numbers.get("b"), 37);
  assert.equal(runtime.numbers.get("w"), 0);
  assert.equal(runtime.strings.get("here"), "/sd/apps");
});
