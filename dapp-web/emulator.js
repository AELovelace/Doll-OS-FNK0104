import { bundledApps, firmwareAppIds } from "./bundled-apps.js";
import { BrowserAudioController } from "./browser-audio.js";
import { highlightDappSource } from "./dapp-highlight.js";
import { DapperClient } from "./dapper-client.js";
import { DappRuntime } from "./dapp-runtime.js";
import { DollMachine, DollShell, VirtualFileSystem, sanitizeDappFilename, settingsGet, settingsSet } from "./emulator-core.js";
import { GameBoyPlayer } from "./gameboy.js?v=20260803e";
import { WEB_RUNTIME } from "./runtime-config.js";

const $ = selector => document.querySelector(selector);
const display = $("#display");
const context = display.getContext("2d");
const commandInput = $("#command-input");
const runtimeState = $("#runtime-state");
const inputMode = $("#input-mode");
const stopButton = $("#stop-app");
const screenReaderLog = $("#screen-reader-log");
const deviceLed = $("#device-led");
const terminalEmbed = document.documentElement.classList.contains("terminal-embed");
const studioEditor = $("#studio-editor");
const studioHighlight = $("#studio-highlight");
const studioLineNumbers = $("#studio-line-numbers");
const studioFilename = $("#studio-filename");
const studioSelect = $("#studio-app-select");
const studioRunButton = $("#studio-run");
const studioSaveButton = $("#studio-save");
const STUDIO_DRAFT_KEY = "doll-os-emulator-studio-draft-v1";
const STUDIO_FILENAME_KEY = "doll-os-emulator-studio-filename-v1";

const palette = {
  black: "#000000",
  red: "#ff4b3e",
  green: "#7cff8c",
  yellow: "#ffe45c",
  blue: "#6d8dff",
  magenta: "#d45cff",
  cyan: "#55f4f0",
  pink: "#ff4fa3",
  white: "#eee4ea"
};

const fileSystem = new VirtualFileSystem({ bundledApps, systemAppIds: firmwareAppIds });
const machine = new DollMachine({ fileSystem, bundledApps });
const dapper = new DapperClient();
const audio = new BrowserAudioController();
audio.setRadioVolume(machine.volume);
$("#studio-runtime-label").textContent = `Apps execute inside the bounded AppRunner ${WEB_RUNTIME.appRunnerVersion} environment. Saving here writes to the emulated device, never to the hosting server.`;
const gameBoy = new GameBoyPlayer({
  canvas: display,
  fileInput: $("#gameboy-rom"),
  status: $("#gameboy-status"),
  controlsRoot: $("#gameboy-console"),
  controlsDialog: $("#gameboy-controls-dialog"),
  onActiveChange: setGameBoyMode,
  audio
});
const displayState = {
  history: [],
  canvas: null,
  powered: true,
  splash: true,
  prompt: "/ > ",
  input: "",
  masked: false,
  cursor: 0
};

let appRunning = false;
let appInputResolve = null;
let appInputEcho = true;
let shellBusy = false;
let editorTarget = "";
const approvedNetworkOrigins = new Set();

// ASUKA local chat -- core streamed chat is faithful to Asuka.ino's request shape
// (see asukaBuildRequestBody there); tool calling (fetch_url/openweather/brave
// search) is deliberately not reimplemented here, since it exists mainly to work
// around the ESP32's heap constraints and adds a classifier round-trip on every
// turn that isn't worth the complexity for a browser demo. See asuka-proxy/ for
// bridging a private-network LLM server to this.
const ASUKA_DEFAULT_SYSTEM_PROMPT = "You are ASUKA, a concise local assistant running through DOLL-OS.";
const ASUKA_SYSTEM_PROMPT_FILE = "/system/conf/asuka-system.dsys";
const ASUKA_HISTORY_MAX = 6;
let asukaEndpoint = "";
let asukaToken = ""; // session-only, never persisted -- same rule llm-chat.dapp follows
let asukaSystemPrompt = ASUKA_DEFAULT_SYSTEM_PROMPT;
let asukaHistory = [];
let asukaBusy = false;
let asukaAbort = null;

function appendOutput(text, color = "white") {
  displayState.history.push({ text: String(text), color });
  if (displayState.history.length > 200) displayState.history.splice(0, displayState.history.length - 200);
  const accessible = document.createElement("div");
  accessible.textContent = text;
  screenReaderLog.append(accessible);
  while (screenReaderLog.childElementCount > 100) screenReaderLog.firstElementChild.remove();
  renderDisplay();
}

function clearOutput() {
  displayState.history.length = 0;
  screenReaderLog.replaceChildren();
  renderDisplay();
}

function formatStorage() {
  const roots = ["/apps", "/system/apps", "/sd/apps"];
  const lines = [];
  let bytes = 0;
  for (const root of roots) {
    const rows = fileSystem.list(root) || [];
    const files = rows.filter(row => !row.directory);
    bytes += files.reduce((sum, row) => sum + row.size, 0);
    lines.push(`${root}  ${files.length} file${files.length === 1 ? "" : "s"}`);
  }
  lines.push(`\n${bytes.toLocaleString()} bytes used`);
  $("#storage-summary").textContent = lines.join("\n");
  refreshStudioApps();
}

function wrapText(text, maxWidth) {
  if (!text) return [""];
  const rows = [];
  let row = "";
  for (const char of String(text)) {
    if (context.measureText(row + char).width > maxWidth && row) {
      rows.push(row);
      row = char;
    } else row += char;
  }
  rows.push(row);
  return rows;
}

function drawStatusBar(width) {
  context.fillStyle = palette.black;
  context.fillRect(0, 0, width, 16);
  context.fillStyle = palette.pink;
  context.textAlign = "left";
  context.fillText("DOLL-OS", 4, 3);
  const used = [...fileSystem.files.values()].reduce((sum, value) => sum + value.length, 0);
  const freeKb = Math.max(0, Math.floor((8 * 1024 * 1024 - used) / 1000));
  context.fillStyle = palette.white;
  context.textAlign = "right";
  context.fillText(`MEM:${freeKb}KB VOL:${String(machine.volume).padStart(2, "0")} BAT:${machine.battery}%`, width - 4, 3);
  context.fillStyle = palette.pink;
  context.fillRect(0, 15, width, 1);
  context.textAlign = "left";
}

function drawHistory(width, height) {
  const top = 16;
  const commandTop = height - 20;
  context.fillStyle = palette.black;
  context.fillRect(0, top, width, commandTop - top);
  const rows = displayState.history.flatMap(line => wrapText(line.text, width - 8).map(text => ({ text, color: line.color })));
  const visible = Math.max(1, Math.floor((commandTop - top - 4) / 12));
  const shown = rows.slice(-visible);
  let y = top + 4;
  for (const row of shown) {
    context.fillStyle = palette[row.color] || palette.white;
    context.fillText(row.text, 4, y);
    y += 12;
  }
}

function drawAppCanvas(width, height) {
  const canvas = displayState.canvas;
  const top = 16;
  const availableHeight = height - 36;
  context.fillStyle = palette.black;
  context.fillRect(0, top, width, availableHeight);
  if (!canvas?.cells?.length) return;
  const cellWidth = Math.max(1, Math.floor((width - 8) / canvas.cols));
  const cellHeight = Math.max(1, Math.floor((availableHeight - 8) / canvas.rows));
  const textSize = Math.max(5, Math.min(24, Math.min(cellWidth, cellHeight)));
  const originX = Math.floor((width - cellWidth * canvas.cols) / 2);
  const originY = top + Math.floor((availableHeight - cellHeight * canvas.rows) / 2);
  context.font = `${textSize}px "VCR OSD Mono", monospace`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let row = 0; row < canvas.rows; row += 1) {
    for (let col = 0; col < canvas.cols; col += 1) {
      const cell = canvas.cells[row][col];
      if (!cell || cell.char === " ") continue;
      context.fillStyle = palette[cell.color] || palette.white;
      context.fillText(cell.char, originX + col * cellWidth + cellWidth / 2, originY + row * cellHeight + cellHeight / 2);
    }
  }
  context.textAlign = "left";
  context.textBaseline = "top";
  context.font = `10px "VCR OSD Mono", monospace`;
}

function drawCommandBar(width, height) {
  const y = height - 20;
  context.fillStyle = palette.black;
  context.fillRect(0, y, width, 20);
  context.fillStyle = palette.white;
  context.fillRect(0, y, width, 1);
  const prompt = displayState.prompt;
  const shownValue = displayState.masked ? "*".repeat(displayState.input.length) : displayState.input;
  context.fillText(prompt, 4, y + 4);
  const textX = 4 + context.measureText(prompt).width;
  const maxWidth = Math.max(0, width - textX - 4);
  let shown = shownValue;
  let dropped = 0;
  while (shown && context.measureText(shown).width > maxWidth) {
    shown = shown.slice(1);
    dropped += 1;
  }
  context.fillText(shown, textX, y + 4);
  if (Math.floor(performance.now() / 500) % 2 === 0 && !commandInput.disabled) {
    const caret = Math.max(0, Math.min(shown.length, displayState.cursor - dropped));
    const caretX = textX + context.measureText(shown.slice(0, caret)).width;
    context.fillRect(Math.min(width - 4, caretX), y + 3, 1, 10);
  }
}

function renderDisplay() {
  if (gameBoy.active) return;
  const { width, height } = display;
  context.imageSmoothingEnabled = false;
  context.textAlign = "left";
  context.textBaseline = "top";
  context.font = `10px "VCR OSD Mono", monospace`;
  context.fillStyle = palette.black;
  context.fillRect(0, 0, width, height);

  if (!displayState.powered) return;
  if (displayState.splash) {
    context.textAlign = "center";
    context.fillStyle = palette.pink;
    context.font = `18px "VCR OSD Mono", monospace`;
    context.fillText("DOLL-OS", width / 2, height / 2 - 18);
    context.fillStyle = palette.white;
    context.font = `10px "VCR OSD Mono", monospace`;
    context.fillText("booting...", width / 2, height / 2 + 8);
    return;
  }

  drawStatusBar(width);
  if (displayState.canvas) drawAppCanvas(width, height);
  else drawHistory(width, height);
  drawCommandBar(width, height);
}

function resizeTerminalDisplay() {
  if (!terminalEmbed) return;
  const bounds = $("#screen-button").getBoundingClientRect();
  if (bounds.width < 2 || bounds.height < 2) return;
  const virtualHeight = 320;
  const virtualWidth = Math.max(160, Math.min(960, Math.round(virtualHeight * bounds.width / bounds.height)));
  if (display.width === virtualWidth && display.height === virtualHeight) return;
  display.width = virtualWidth;
  display.height = virtualHeight;
  if (gameBoy.active) gameBoy.render();
  else renderDisplay();
}

function syncInputDisplay() {
  displayState.input = commandInput.value;
  displayState.cursor = commandInput.selectionStart || 0;
  renderDisplay();
}

function configureInputAutofill(masked) {
  commandInput.setAttribute("autocomplete", masked ? "new-password" : "off");
  commandInput.name = masked ? "doll-os-secret-input" : "doll-os-command-input";
  commandInput.setAttribute("data-lpignore", "true");
  commandInput.setAttribute("data-1p-ignore", "true");
  commandInput.setAttribute("data-form-type", "other");
}

function setInputMode(mode, prompt, { masked = false, enabled = true } = {}) {
  inputMode.textContent = mode;
  displayState.prompt = prompt;
  displayState.masked = masked;
  commandInput.type = masked ? "password" : "text";
  configureInputAutofill(masked);
  commandInput.disabled = !enabled || !displayState.powered;
  commandInput.value = "";
  syncInputDisplay();
  if (!commandInput.disabled) commandInput.focus({ preventScroll: true });
}

function setGameBoyMode(active) {
  stopButton.textContent = active ? "EXIT GB" : "STOP APP";
  stopButton.disabled = active ? false : !appRunning;
  if (active) {
    displayState.canvas = null;
    runtimeState.textContent = "GAME BOY";
    setInputMode("GAME BOY", "GB > ");
  } else if (displayState.powered && !displayState.splash) {
    runtimeState.textContent = "READY";
    setInputMode("SHELL INPUT", shell.prompt());
    renderDisplay();
  }
  updateStudioControls();
}

function beginShellSession() {
  clearOutput();
  appendOutput("===============================", "pink");
  appendOutput("          Doll-Screen", "pink");
  appendOutput("===============================", "pink");
  appendOutput("");
  appendOutput("Type help for available commands.");
  appendOutput("");
  appendOutput(`DOLL-OS ready. ${machine.wifiConnected ? `Station IP: ${machine.ip}` : "WiFi not connected."}`);
  appendOutput("");
  setInputMode("SHELL INPUT", shell.prompt());
  runtimeState.textContent = "READY";
  formatStorage();
  updateStudioControls();
}

function bootSequence() {
  gameBoy.exit();
  displayState.powered = true;
  displayState.splash = true;
  displayState.canvas = null;
  $("#power-label").textContent = "POWERED";
  runtimeState.textContent = "BOOTING";
  commandInput.disabled = true;
  updateStudioControls();
  renderDisplay();
  window.setTimeout(() => {
    if (!displayState.powered) return;
    displayState.splash = false;
    beginShellSession();
  }, 650);
}

const stopAllWaves = () => audio.stopAllWaves();

const io = {
  output: appendOutput,
  clear: clearOutput,
  status(state, label) {
    runtimeState.textContent = label;
    if (state === "error") deviceLed.classList.add("active");
  },
  input(prompt, resolve, masked = false, echoInput = true) {
    appInputResolve = resolve;
    appInputEcho = echoInput;
    setInputMode("APP INPUT", prompt || "> ", { masked });
  },
  canvas(canvas) {
    displayState.canvas = canvas;
    renderDisplay();
  },
  endCanvas() {
    displayState.canvas = null;
    renderDisplay();
  },
  led({ red, green, blue }) {
    deviceLed.style.background = `rgb(${red} ${green} ${blue})`;
    deviceLed.style.color = `rgb(${red} ${green} ${blue})`;
    deviceLed.classList.toggle("active", red + green + blue > 0);
  },
  wave: value => audio.wave(value),
  waveStop: stopAllWaves,
  authorizeHttp({ url, method }) {
    if (!$("#network-toggle").checked) {
      appendOutput("network: blocked; enable APP NETWORK ACCESS to allow requests", "yellow");
      return false;
    }
    const target = new URL(url);
    if (approvedNetworkOrigins.has(target.origin)) return true;
    const hostname = target.hostname.toLowerCase();
    const sensitiveDestination = target.origin === window.location.origin
      || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
      || hostname.startsWith("10.") || hostname.startsWith("192.168.")
      || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
    const warning = sensitiveDestination
      ? "\n\nWARNING: this is the hosting origin or a private-network destination."
      : "";
    const approved = window.confirm(
      `Allow the running .dapp to send credentialless ${method} requests to:\n${target.origin}?${warning}\n\nApproval lasts until this page is reloaded.`
    );
    if (approved) approvedNetworkOrigins.add(target.origin);
    return approved;
  }
};

const runtime = new DappRuntime(io, fileSystem, {
  battery: () => machine.battery,
  cwd: () => shell.cwd,
  heap: () => Math.max(0, 8 * 1024 * 1024 - [...fileSystem.files.values()].reduce((sum, value) => sum + value.length, 0)),
  ip: () => machine.wifiConnected ? machine.ip : "0.0.0.0",
  wifi: () => Number(machine.wifiConnected),
  millis: () => machine.uptimeSeconds() * 1000,
  seconds: () => machine.uptimeSeconds(),
  audiook: () => Number(audio.isReady),
  dapper: parts => shell.command_dapper(["dapper", ...parts])
});

async function runApp(path, source) {
  appendOutput(`Running ${path}`, "green");
  appRunning = true;
  stopButton.disabled = false;
  updateStudioControls();
  setInputMode("APP KEYS", "app > ");
  const result = await runtime.run(source);
  appRunning = false;
  appInputResolve = null;
  stopButton.disabled = true;
  stopAllWaves();
  deviceLed.classList.remove("active");
  deviceLed.removeAttribute("style");
  updateStudioControls();
  if (!displayState.powered) {
    runtimeState.textContent = "OFF";
    return;
  }
  setInputMode("SHELL INPUT", shell.prompt());
  runtimeState.textContent = result.ok ? "READY" : result.stopped ? "STOPPED" : "ERROR";
  formatStorage();
}

function studioStorageRead(key, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function studioStorageWrite(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function setStudioState(label) {
  $("#studio-state").textContent = label;
}

function updateStudioStats() {
  const lines = studioEditor.value.split("\n").length;
  studioHighlight.innerHTML = highlightDappSource(studioEditor.value);
  studioLineNumbers.textContent = Array.from({ length: lines }, (_, index) => index + 1).join("\n");
  $("#studio-stats").textContent = `${lines} LINE${lines === 1 ? "" : "S"} / ${studioEditor.value.length} CHARS`;
}

function syncStudioScroll() {
  studioHighlight.scrollTop = studioEditor.scrollTop;
  studioHighlight.scrollLeft = studioEditor.scrollLeft;
  studioLineNumbers.scrollTop = studioEditor.scrollTop;
}

function updateStudioControls() {
  const unavailable = appRunning || shellBusy || !displayState.powered;
  studioRunButton.disabled = unavailable;
  studioSaveButton.disabled = appRunning;
}

function refreshStudioApps() {
  const selected = studioSelect.value;
  studioSelect.replaceChildren(new Option("Select an installed app…", ""));
  for (const [root, label] of [["/apps", "DOWNLOADED / SAVED"], ["/system/apps", "BURNED IN"], ["/sd/apps", "SD CARD"]]) {
    const apps = (fileSystem.list(root) || []).filter(row => !row.directory && row.name.toLowerCase().endsWith(".dapp"));
    if (!apps.length) continue;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const app of apps) group.append(new Option(app.name, `${root}/${app.name}`));
    studioSelect.append(group);
  }
  if ([...studioSelect.options].some(option => option.value === selected)) studioSelect.value = selected;
}

let studioDraftTimer;
function queueStudioDraft() {
  setStudioState("UNSAVED DRAFT");
  clearTimeout(studioDraftTimer);
  studioDraftTimer = setTimeout(() => {
    studioStorageWrite(STUDIO_DRAFT_KEY, studioEditor.value);
    studioStorageWrite(STUDIO_FILENAME_KEY, sanitizeDappFilename(studioFilename.value));
    setStudioState("LOCAL DRAFT");
  }, 200);
}

function saveStudioApp({ announce = true } = {}) {
  const filename = sanitizeDappFilename(studioFilename.value);
  const path = `/apps/${filename}`;
  studioFilename.value = filename;
  if (!fileSystem.write(path, studioEditor.value)) {
    setStudioState("SAVE FAILED");
    if (announce) appendOutput(`studio: could not save ${path}`, "red");
    return null;
  }
  studioStorageWrite(STUDIO_DRAFT_KEY, studioEditor.value);
  studioStorageWrite(STUDIO_FILENAME_KEY, filename);
  setStudioState("SAVED TO DEVICE");
  refreshStudioApps();
  studioSelect.value = path;
  formatStorage();
  if (announce) appendOutput(`studio: saved ${path}`, "green");
  return path;
}

async function runStudioApp() {
  if (studioRunButton.disabled) return;
  const path = saveStudioApp({ announce: false });
  if (!path) return;
  if (displayState.splash) {
    setStudioState("WAITING FOR BOOT");
    for (let attempt = 0; attempt < 30 && displayState.splash && displayState.powered; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (!displayState.powered || displayState.splash) {
    setStudioState("DEVICE NOT READY");
    return;
  }
  setStudioState("RUNNING ON DEVICE");
  commandInput.focus();
  await submitShellCommand(`run ${path}`);
  setStudioState(runtimeState.textContent === "ERROR" ? "APP ERROR" : "RUN FINISHED");
}

function newStudioApp() {
  studioSelect.value = "";
  studioFilename.value = "untitled.dapp";
  studioEditor.value = `# untitled.dapp\nCOLOR pink\nPRINT "hello from DOLL-OS"\nEND`;
  updateStudioStats();
  queueStudioDraft();
  studioEditor.focus();
}

function openEditor(path, content) {
  editorTarget = path;
  $("#editor-path").textContent = `EDIT://${path}`;
  $("#file-editor").value = content;
  $("#editor-dialog").showModal();
}

function asukaScrollToBottom() {
  const log = $("#asuka-log");
  log.scrollTop = log.scrollHeight;
}

// kind: "user" | "asuka" | "system". Returns the element chunks get appended to
// (asukaSendMessage streams tokens into it as they arrive).
function asukaLog(text, kind = "system") {
  const row = document.createElement("div");
  row.className = `asuka-message ${kind}`;
  if (kind === "user" || kind === "asuka") {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = kind === "user" ? "you" : "ASUKA";
    row.append(who);
  }
  const body = document.createElement("span");
  body.textContent = text;
  row.append(body);
  $("#asuka-log").append(row);
  asukaScrollToBottom();
  return body;
}

function asukaSetBusy(busy) {
  asukaBusy = busy;
  $("#asuka-input").disabled = busy;
  $("#asuka-send").disabled = busy;
  if (!busy && $("#asuka-dialog").open) $("#asuka-input").focus();
}

function asukaAddHistory(sender, message) {
  asukaHistory.push(`${sender}: ${message}`);
  if (asukaHistory.length > ASUKA_HISTORY_MAX) asukaHistory.shift();
}

// "> User: ...\n> ASUKA: ...\n..." -- matches asukaBuildTranscript() in Asuka.ino,
// folded into one user turn rather than real multi-turn `messages`, since that's
// the shape the firmware (and so asuka-proxy's upstream) actually expects
function asukaBuildTranscript() {
  return asukaHistory.map(line => `> ${line}\n`).join("");
}

function asukaBuildRequestBody(prompt) {
  const messages = [];
  if (asukaSystemPrompt.trim()) messages.push({ role: "system", content: asukaSystemPrompt });
  messages.push({ role: "user", content: prompt });
  return JSON.stringify({ model: "model", stream: true, temperature: 0.7, max_tokens: 2048, messages });
}

async function asukaSendMessage(userText) {
  asukaAddHistory("User", userText);
  const body = asukaBuildRequestBody(asukaBuildTranscript());
  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (asukaToken) headers.Authorization = `Bearer ${asukaToken}`;

  if (io.authorizeHttp && !(await io.authorizeHttp({ url: asukaEndpoint, method: "POST" }))) {
    asukaLog("Request blocked. Enable APP NETWORK ACCESS to allow it.", "system");
    return;
  }

  asukaAbort = new AbortController();
  let response;
  try {
    response = await fetch(asukaEndpoint, {
      method: "POST",
      headers,
      body,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: asukaAbort.signal
    });
  } catch (err) {
    asukaLog(err.name === "AbortError" ? "Request cancelled." : `Connection failed: ${err.message}`, "system");
    return;
  }

  if (!response.ok || !response.body) {
    asukaLog(`LLM HTTP error: ${response.status} ${response.statusText || ""}`.trim(), "system");
    return;
  }

  const bubble = asukaLog("", "asuka");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let streamDone = false;

  const consumeLine = line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      streamDone = true;
      return;
    }
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed.content === "string" && parsed.content) {
        full += parsed.content;
        bubble.textContent += parsed.content;
        asukaScrollToBottom();
      }
    } catch {
      // a malformed SSE chunk is dropped, same tolerance asukaJsonFieldString gives it
    }
  };

  try {
    while (!streamDone) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while (!streamDone && (newlineIndex = buffer.indexOf("\n")) >= 0) {
        consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
      }
    }
    if (!streamDone && buffer.trim()) consumeLine(buffer); // server didn't send a trailing newline
  } catch (err) {
    if (err.name !== "AbortError") asukaLog(`Stream error: ${err.message}`, "system");
  }

  if (full) {
    asukaAddHistory("ASUKA", full);
  } else if (!bubble.textContent) {
    bubble.closest(".asuka-message")?.remove();
    asukaLog("(no response)", "system");
  }
}

function asukaHandleSlashCommand(text) {
  const [rawCmd, ...rest] = text.slice(1).split(" ");
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(" ").trim();
  if (cmd === "help") {
    asukaLog([
      "/help", "/status", "/endpoint <url>", "/token <bearer, blank clears it>",
      "/system", "/system <prompt>", "/system reset", "/clear", "/quit"
    ].join("\n"), "system");
    return;
  }
  if (cmd === "status") {
    asukaLog([
      `Endpoint: ${asukaEndpoint || "(not set -- use /endpoint <url>)"}`,
      `Token: ${asukaToken ? "set (session only)" : "(none)"}`,
      `History: ${asukaHistory.length} line(s) of ${ASUKA_HISTORY_MAX}`
    ].join("\n"), "system");
    return;
  }
  if (cmd === "endpoint") {
    if (!arg) { asukaLog(`Endpoint: ${asukaEndpoint || "(not set)"}`, "system"); return; }
    asukaEndpoint = arg;
    settingsSet(fileSystem, "asuka.endpoint", asukaEndpoint);
    asukaLog(`Endpoint set to ${asukaEndpoint}`, "system");
    return;
  }
  if (cmd === "token") {
    asukaToken = arg;
    asukaLog(arg ? "Token set (kept in memory only, not saved)." : "Token cleared.", "system");
    return;
  }
  if (cmd === "system") {
    if (arg === "reset") {
      asukaSystemPrompt = ASUKA_DEFAULT_SYSTEM_PROMPT;
      fileSystem.write(ASUKA_SYSTEM_PROMPT_FILE, asukaSystemPrompt);
      asukaLog("System prompt reset to default.", "system");
      return;
    }
    if (!arg) { asukaLog(`System prompt: ${asukaSystemPrompt}`, "system"); return; }
    asukaSystemPrompt = arg;
    fileSystem.write(ASUKA_SYSTEM_PROMPT_FILE, asukaSystemPrompt);
    asukaLog("System prompt updated.", "system");
    return;
  }
  if (cmd === "clear") {
    asukaHistory = [];
    asukaLog("History cleared.", "system");
    return;
  }
  if (cmd === "quit") {
    $("#asuka-dialog").close();
    return;
  }
  asukaLog(`Unknown command: /${cmd}. Try /help.`, "system");
}

async function handleAsukaInput(text) {
  if (asukaBusy) return;
  if (text.startsWith("/")) {
    asukaHandleSlashCommand(text);
    return;
  }
  if (!asukaEndpoint) {
    asukaLog("No endpoint set yet. Use /endpoint <url> first.", "system");
    return;
  }
  asukaLog(text, "user");
  asukaSetBusy(true);
  try {
    await asukaSendMessage(text);
  } finally {
    asukaSetBusy(false);
  }
}

function openAsuka() {
  asukaEndpoint = settingsGet(fileSystem, "asuka.endpoint", "");
  const storedPrompt = (fileSystem.read(ASUKA_SYSTEM_PROMPT_FILE) || "").trim();
  asukaSystemPrompt = storedPrompt || ASUKA_DEFAULT_SYSTEM_PROMPT;
  if (!storedPrompt) fileSystem.write(ASUKA_SYSTEM_PROMPT_FILE, asukaSystemPrompt);
  asukaToken = "";
  asukaHistory = [];
  $("#asuka-log").replaceChildren();
  asukaLog("ASUKA local chat -- browser build, no tool calling (see /help).", "system");
  asukaLog(asukaEndpoint
    ? `Endpoint: ${asukaEndpoint}`
    : "No endpoint set -- use /endpoint <url> to point this at an OpenAI-compatible " +
      "chat-completions server (e.g. an asuka-proxy deployment). The target must send " +
      "CORS headers, since this is a direct browser request.", "system");
  asukaLog("/quit to exit, /help for commands", "system");
  $("#asuka-input").value = "";
  $("#asuka-dialog").showModal();
  $("#asuka-input").focus();
}

const shell = new DollShell(machine, {
  output: appendOutput,
  clear: clearOutput,
  runApp,
  edit: openEditor,
  asuka: openAsuka,
  dapper,
  radioDefaults: volume => audio.setRadioVolume(volume),
  radio: async ({ action, url, defaultUrl, volume }) => {
    if (action === "play") {
      const selectedUrl = url || (!audio.radioStatus().url ? defaultUrl : "");
      return audio.playRadio(selectedUrl);
    }
    if (action === "pause") return audio.pauseRadio();
    if (action === "stop") return audio.stopRadio();
    if (action === "vol") audio.setRadioVolume(volume);
    return audio.radioStatus();
  },
  gameBoy: ({ action } = {}) => action === "controls" ? gameBoy.openControls() : gameBoy.open(),
  stateChanged: renderDisplay,
  reboot: () => {
    audio.stopRadio();
    audio.setRadioVolume(machine.volume);
    bootSequence();
  }
});

document.addEventListener("pointerdown", () => { void audio.unlock(); }, { capture: true });
document.addEventListener("keydown", () => { void audio.unlock(); }, { capture: true });

async function submitShellCommand(value) {
  if (!displayState.powered || shellBusy || appRunning || gameBoy.active) return;
  shellBusy = true;
  commandInput.disabled = true;
  updateStudioControls();
  await shell.execute(value);
  shellBusy = false;
  if (!appRunning && !gameBoy.active && displayState.powered && !displayState.splash) setInputMode("SHELL INPUT", shell.prompt());
  formatStorage();
  updateStudioControls();
}

studioEditor.addEventListener("input", () => {
  updateStudioStats();
  queueStudioDraft();
});
studioEditor.addEventListener("scroll", syncStudioScroll);
studioEditor.addEventListener("keydown", event => {
  if (event.key === "Tab") {
    event.preventDefault();
    studioEditor.setRangeText("  ", studioEditor.selectionStart, studioEditor.selectionEnd, "end");
    updateStudioStats();
    queueStudioDraft();
  } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runStudioApp();
  }
});
studioFilename.addEventListener("input", queueStudioDraft);
studioFilename.addEventListener("blur", () => {
  studioFilename.value = sanitizeDappFilename(studioFilename.value);
});
studioSelect.addEventListener("change", () => {
  const path = studioSelect.value;
  if (!path) return;
  const source = fileSystem.read(path);
  if (source === null) return;
  studioEditor.value = source;
  studioFilename.value = path.split("/").pop();
  updateStudioStats();
  studioStorageWrite(STUDIO_DRAFT_KEY, source);
  studioStorageWrite(STUDIO_FILENAME_KEY, studioFilename.value);
  setStudioState(path.startsWith("/system/apps/") ? "BURNED-IN COPY" : "LOADED FROM DEVICE");
});
studioRunButton.addEventListener("click", runStudioApp);
studioSaveButton.addEventListener("click", () => saveStudioApp());
$("#studio-new").addEventListener("click", newStudioApp);

commandInput.addEventListener("input", syncInputDisplay);
commandInput.addEventListener("click", syncInputDisplay);
commandInput.addEventListener("keyup", syncInputDisplay);
commandInput.addEventListener("keydown", async event => {
  void audio.unlock();
  if (gameBoy.active) {
    event.preventDefault();
    return;
  }
  if (appRunning) {
    if (appInputResolve) {
      if (event.key === "Enter") {
        event.preventDefault();
        const value = commandInput.value;
        const resolve = appInputResolve;
        appInputResolve = null;
        if (appInputEcho) appendOutput(`${displayState.prompt}${displayState.masked ? "[hidden]" : value}`);
        setInputMode("APP KEYS", "app > ");
        resolve(value);
      }
      return;
    }
    if (runtime.pushKey(event)) {
      event.preventDefault();
      commandInput.value = "";
      syncInputDisplay();
    }
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    commandInput.value = shell.recall(-1, commandInput.value);
    commandInput.setSelectionRange(commandInput.value.length, commandInput.value.length);
    syncInputDisplay();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    commandInput.value = shell.recall(1, commandInput.value);
    commandInput.setSelectionRange(commandInput.value.length, commandInput.value.length);
    syncInputDisplay();
  } else if (event.ctrlKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    commandInput.value = "";
    syncInputDisplay();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const value = commandInput.value;
    commandInput.value = "";
    syncInputDisplay();
    await submitShellCommand(value);
  }
});

$("#screen-button").addEventListener("click", () => {
  void audio.unlock();
  commandInput.focus();
});
stopButton.addEventListener("click", () => gameBoy.active ? gameBoy.exit() : runtime.stop());

$("#power-button").addEventListener("click", () => {
  if (displayState.powered) {
    runtime.stop();
    gameBoy.exit();
    displayState.powered = false;
    displayState.splash = false;
    commandInput.disabled = true;
    runtimeState.textContent = "OFF";
    $("#power-label").textContent = "OFF";
    stopAllWaves();
    audio.stopRadio();
    updateStudioControls();
    renderDisplay();
  } else {
    machine.reboot();
    audio.setRadioVolume(machine.volume);
    bootSequence();
  }
});

$("#reboot-button").addEventListener("click", () => {
  if (!displayState.powered) return;
  runtime.stop();
  gameBoy.exit();
  audio.stopRadio();
  machine.reboot();
  audio.setRadioVolume(machine.volume);
  shell.cwd = "/";
  bootSequence();
});

$("#panel-select").addEventListener("change", event => {
  const [width, height] = event.target.value.split("x").map(Number);
  display.width = width;
  display.height = height;
  display.style.setProperty("--screen-ratio", `${width} / ${height}`);
  if (gameBoy.active) gameBoy.render();
  else renderDisplay();
});

$("#battery-range").addEventListener("input", event => {
  machine.battery = Number(event.target.value);
  $("#battery-output").textContent = `${machine.battery}%`;
  renderDisplay();
});

$("#wifi-toggle").addEventListener("change", event => {
  machine.wifiConnected = event.target.checked;
  renderDisplay();
});

$("#sd-toggle").addEventListener("change", event => {
  machine.sdMounted = event.target.checked;
  if (!machine.sdMounted && shell.cwd.startsWith("/sd")) shell.cwd = "/";
  setInputMode("SHELL INPUT", shell.prompt());
});

$("#network-toggle").addEventListener("change", event => {
  if (!event.target.checked) approvedNetworkOrigins.clear();
});

document.querySelectorAll("[data-command]").forEach(button => button.addEventListener("click", () => {
  if (!displayState.powered || appRunning || gameBoy.active) return;
  void audio.unlock();
  submitShellCommand(button.dataset.command);
}));

$("#save-file").addEventListener("click", event => {
  if (!fileSystem.write(editorTarget, $("#file-editor").value)) {
    event.preventDefault();
    appendOutput(`edit: could not save ${editorTarget}`, "red");
    return;
  }
  appendOutput(`edit: saved ${editorTarget}`, "green");
  formatStorage();
});

$("#refresh-files").addEventListener("click", formatStorage);

$("#asuka-form").addEventListener("submit", event => {
  if (event.submitter?.value === "cancel") return; // let method="dialog" close it
  event.preventDefault(); // sending a message must not close the dialog
  const input = $("#asuka-input");
  const text = input.value.trim();
  input.value = "";
  if (text) void handleAsukaInput(text);
});

$("#asuka-dialog").addEventListener("close", () => {
  asukaAbort?.abort();
  asukaAbort = null;
  asukaSetBusy(false);
});

$("#export-button").addEventListener("click", () => {
  const blob = new Blob([fileSystem.snapshot()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "doll-os-web-disk.json";
  anchor.click();
  URL.revokeObjectURL(url);
});

$("#import-button").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async event => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    if (file.size > 4.5 * 1024 * 1024) throw new Error("disk image is too large");
    fileSystem.restore(await file.text());
    appendOutput("disk: imported virtual filesystem", "green");
    formatStorage();
  } catch {
    appendOutput("disk: invalid disk image", "red");
  }
  event.target.value = "";
});

$("#factory-reset").addEventListener("click", () => {
  if (!window.confirm("Erase writable files, aliases, and app data from this browser?")) return;
  runtime.stop();
  gameBoy.exit();
  fileSystem.factoryReset();
  machine.reboot();
  shell.cwd = "/";
  bootSequence();
});

window.setInterval(renderDisplay, 250);
document.fonts?.ready.then(renderDisplay);
if (terminalEmbed) {
  new ResizeObserver(resizeTerminalDisplay).observe($("#screen-button"));
  window.addEventListener("resize", resizeTerminalDisplay);
  window.requestAnimationFrame(resizeTerminalDisplay);
}
studioEditor.value = studioStorageRead(STUDIO_DRAFT_KEY, studioEditor.value);
studioFilename.value = sanitizeDappFilename(studioStorageRead(STUDIO_FILENAME_KEY, studioFilename.value));
updateStudioStats();
refreshStudioApps();
formatStorage();
bootSequence();
