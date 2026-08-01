import { DappRuntime } from "./dapp-runtime.js";
import { highlightDappSource } from "./dapp-highlight.js";
import { commandGroups, examples } from "./examples.js";

const $ = selector => document.querySelector(selector);
const editor = $("#code-editor");
const highlight = $("#highlight");
const lineNumbers = $("#line-numbers");
const terminal = $("#terminal");
const screen = $("#screen");
const canvasScreen = $("#canvas-screen");
const runButton = $("#run-button");
const stopButton = $("#stop-button");
const runStatus = $("#run-status");
const inputForm = $("#input-form");
const programInput = $("#program-input");
const inputPrompt = $("#input-prompt");
const saveState = $("#save-state");
const exampleSelect = $("#example-select");
const editorStats = $("#editor-stats");
const filenameInput = $("#filename-input");
const editorTitle = $("#editor-title");
const STORAGE_KEY = "dapp-playground-source-v1";
const FILES_KEY = "dapp-playground-files-v1";
const FILENAME_KEY = "dapp-playground-filename-v1";
const approvedNetworkOrigins = new Set();

class BrowserFileSystem {
  constructor() {
    try {
      this.files = JSON.parse(localStorage.getItem(FILES_KEY)) || {};
    } catch {
      this.files = {};
    }
  }

  persist() {
    localStorage.setItem(FILES_KEY, JSON.stringify(this.files));
  }

  exists(path) {
    return Object.hasOwn(this.files, path);
  }

  read(path) {
    return this.files[path] ?? null;
  }

  write(path, content) {
    this.files[path] = content;
    this.persist();
  }

  delete(path) {
    if (!this.exists(path)) return false;
    delete this.files[path];
    this.persist();
    return true;
  }
}

function paintEditor() {
  const source = editor.value;
  const lines = source.split("\n");
  highlight.innerHTML = highlightDappSource(source);
  lineNumbers.textContent = lines.map((_, index) => index + 1).join("\n");
  editorStats.textContent = `${lines.length} LINE${lines.length === 1 ? "" : "S"} / ${source.length} CHARS`;
}

function syncScroll() {
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
  lineNumbers.scrollTop = editor.scrollTop;
}

let saveTimer;
function saveDraft() {
  saveState.textContent = "SAVING...";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, editor.value);
    saveState.textContent = "SAVED LOCAL";
  }, 250);
}

function setSource(source, save = true) {
  editor.value = source;
  paintEditor();
  syncScroll();
  if (save) {
    localStorage.setItem(STORAGE_KEY, source);
    saveState.textContent = "SAVED LOCAL";
  }
}

function appendOutput(text, color = "white") {
  const line = document.createElement("p");
  line.className = `terminal-line color-${color}`;
  line.textContent = text;
  terminal.append(line);
  screen.scrollTop = screen.scrollHeight;
}

function clearOutput() {
  terminal.replaceChildren();
}

function setStatus(state, label) {
  runStatus.dataset.state = state;
  runStatus.textContent = label;
}

function configureProgramInputAutofill(masked) {
  programInput.setAttribute("autocomplete", masked ? "new-password" : "off");
  programInput.name = masked ? "dapp-runtime-secret-input" : "dapp-runtime-input";
  programInput.setAttribute("data-lpignore", "true");
  programInput.setAttribute("data-1p-ignore", "true");
  programInput.setAttribute("data-form-type", "other");
}

function showInput(prompt, resolve, masked = false, echoInput = true) {
  inputPrompt.textContent = prompt;
  inputForm.hidden = false;
  programInput.type = masked ? "password" : "text";
  configureProgramInputAutofill(masked);
  programInput.value = "";
  programInput.focus();

  inputForm.onsubmit = event => {
    event.preventDefault();
    const value = programInput.value;
    if (echoInput) appendOutput(`${prompt}${masked ? "[hidden]" : value}`, "white");
    inputForm.hidden = true;
    programInput.type = "text";
    inputForm.onsubmit = null;
    resolve(value);
  };
}

function renderCanvas(canvas) {
  terminal.hidden = true;
  canvasScreen.hidden = false;
  canvasScreen.replaceChildren();
  for (const row of canvas.cells) {
    const rowElement = document.createElement("span");
    rowElement.className = "canvas-row";
    let currentColor = null;
    let run = null;
    for (const cell of row) {
      if (cell.color !== currentColor) {
        currentColor = cell.color;
        run = document.createElement("span");
        run.className = `color-${currentColor}`;
        rowElement.append(run);
      }
      run.append(document.createTextNode(cell.char));
    }
    canvasScreen.append(rowElement);
  }
}

function endCanvas() {
  canvasScreen.hidden = true;
  canvasScreen.replaceChildren();
  terminal.hidden = false;
}

function downloadFilename() {
  const leaf = filenameInput.value.trim().replaceAll("\\", "/").split("/").pop() || "untitled";
  const base = leaf.replace(/\.dapp$/i, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^[.-]+|[.-]+$/g, "");
  return `${base || "untitled"}.dapp`;
}

function updateFilename(value, persist = true) {
  filenameInput.value = value;
  const filename = downloadFilename();
  editorTitle.textContent = `EDIT://${filename}`;
  if (persist) localStorage.setItem(FILENAME_KEY, filename);
}

let synthContext;
const synthChannels = new Map();

function stopWaveChannel(channel) {
  const voice = synthChannels.get(channel);
  if (!voice) return;
  try { voice.source.stop(); } catch {}
  voice.source.disconnect();
  voice.gain.disconnect();
  voice.filter?.disconnect();
  synthChannels.delete(channel);
}

function setWave({ channel, waveform, frequency, level }) {
  stopWaveChannel(channel);
  if (waveform === "off" || level === 0) return;

  synthContext ||= new AudioContext();
  synthContext.resume();
  const gain = synthContext.createGain();
  gain.gain.value = (level / 100) * 0.08;
  gain.connect(synthContext.destination);

  let source;
  let filter;
  if (waveform === "noise") {
    const length = synthContext.sampleRate;
    const buffer = synthContext.createBuffer(1, length, synthContext.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) samples[i] = Math.random() * 2 - 1;
    source = synthContext.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    filter = synthContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = frequency;
    source.connect(filter);
    filter.connect(gain);
  } else {
    source = synthContext.createOscillator();
    source.type = { sin: "sine", tri: "triangle", sq: "square" }[waveform] || waveform;
    source.frequency.value = frequency;
    source.connect(gain);
  }
  source.start();
  synthChannels.set(channel, { source, gain, filter });
}

function stopAllWaves() {
  for (const channel of [...synthChannels.keys()]) stopWaveChannel(channel);
}

const io = {
  output: appendOutput,
  clear: clearOutput,
  status: setStatus,
  input: showInput,
  canvas: renderCanvas,
  endCanvas,
  wave: setWave,
  waveStop: stopAllWaves,
  authorizeHttp({ url, method }) {
    const target = new URL(url);
    if (approvedNetworkOrigins.has(target.origin)) return true;
    const sameOriginWarning = target.origin === window.location.origin
      ? "\n\nThis is the same origin as the hosting website. Cookies will not be sent."
      : "";
    const approved = window.confirm(
      `Allow this .dapp to send credentialless ${method} requests to:\n${target.origin}?${sameOriginWarning}\n\nApproval lasts until this page is reloaded.`
    );
    if (approved) approvedNetworkOrigins.add(target.origin);
    return approved;
  }
};

const runtime = new DappRuntime(io, new BrowserFileSystem());

async function runSource() {
  if (runtime.running) return;
  clearOutput();
  endCanvas();
  appendOutput(`Running /apps/${downloadFilename()}`, "green");
  runButton.disabled = true;
  stopButton.disabled = false;
  screen.focus();
  await runtime.run(editor.value);
  runButton.disabled = false;
  stopButton.disabled = true;
  inputForm.hidden = true;
}

function downloadSource() {
  const blob = new Blob([editor.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = downloadFilename();
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildExamples() {
  for (const [key, example] of Object.entries(examples)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = example.name;
    exampleSelect.append(option);
  }
}

function buildHelp() {
  const body = $("#help-body");
  for (const group of commandGroups) {
    const section = document.createElement("section");
    section.className = "help-group";
    const heading = document.createElement("h3");
    heading.textContent = group.title;
    section.append(heading);
    for (const [command, description] of group.commands) {
      const row = document.createElement("div");
      row.className = "command-row";
      const code = document.createElement("code");
      code.textContent = command;
      const copy = document.createElement("span");
      copy.textContent = description;
      row.append(code, copy);
      section.append(row);
    }
    body.append(section);
  }
}

function openHelp(open) {
  const drawer = $("#help-drawer");
  const scrim = $("#drawer-scrim");
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  scrim.hidden = !open;
  if (open) $("#help-close").focus();
}

editor.addEventListener("input", () => {
  paintEditor();
  saveDraft();
});
editor.addEventListener("scroll", syncScroll);
editor.addEventListener("keydown", event => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = editor.selectionStart;
    editor.setRangeText("  ", start, editor.selectionEnd, "end");
    paintEditor();
    saveDraft();
  }
});

screen.addEventListener("keydown", event => {
  if (!runtime.running || !inputForm.hidden) return;
  if (runtime.pushKey(event)) {
    event.preventDefault();
    $("#key-hint").textContent = event.ctrlKey && event.key.toLowerCase() === "x"
      ? "ABORT REQUESTED"
      : `KEY QUEUED: ${event.key.toUpperCase()}`;
  }
});

document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runSource();
  }
  if (event.key === "Escape" && $("#help-drawer").classList.contains("open")) openHelp(false);
});

runButton.addEventListener("click", runSource);
stopButton.addEventListener("click", () => runtime.stop());
$("#clear-button").addEventListener("click", clearOutput);
$("#download-button").addEventListener("click", downloadSource);
filenameInput.addEventListener("input", () => updateFilename(filenameInput.value));
filenameInput.addEventListener("blur", () => updateFilename(downloadFilename()));
$("#new-button").addEventListener("click", () => {
  exampleSelect.value = "";
  updateFilename("untitled.dapp");
  setSource(`# untitled.dapp\nCOLOR pink\nPRINT "hello, tiny world"\nEND`);
  editor.focus();
});
exampleSelect.addEventListener("change", () => {
  const example = examples[exampleSelect.value];
  if (example) {
    setSource(example.source);
    updateFilename(`${exampleSelect.value}.dapp`);
  }
});
$("#help-button").addEventListener("click", () => openHelp(true));
$("#help-close").addEventListener("click", () => openHelp(false));
$("#drawer-scrim").addEventListener("click", () => openHelp(false));

buildExamples();
buildHelp();
updateFilename(localStorage.getItem(FILENAME_KEY) || "untitled.dapp", false);
setSource(localStorage.getItem(STORAGE_KEY) || examples.hello.source, false);
