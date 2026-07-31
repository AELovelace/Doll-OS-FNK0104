import { DappRuntime } from "./dapp-runtime.js";
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
const STORAGE_KEY = "dapp-playground-source-v1";
const FILES_KEY = "dapp-playground-files-v1";

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

function paintEditor() {
  const source = editor.value;
  const lines = source.split("\n");
  highlight.innerHTML = `${lines.map(highlightLine).join("\n")}\n`;
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

function showInput(prompt, resolve) {
  inputPrompt.textContent = prompt;
  inputForm.hidden = false;
  programInput.value = "";
  programInput.focus();

  inputForm.onsubmit = event => {
    event.preventDefault();
    const value = programInput.value;
    appendOutput(`${prompt}${value}`, "white");
    inputForm.hidden = true;
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

const io = {
  output: appendOutput,
  clear: clearOutput,
  status: setStatus,
  input: showInput,
  canvas: renderCanvas,
  endCanvas
};

const runtime = new DappRuntime(io, new BrowserFileSystem());

async function runSource() {
  if (runtime.running) return;
  clearOutput();
  endCanvas();
  appendOutput("Running /apps/untitled.dapp", "green");
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
  anchor.download = "untitled.dapp";
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
$("#new-button").addEventListener("click", () => {
  exampleSelect.value = "";
  setSource(`# untitled.dapp\nCOLOR pink\nPRINT "hello, tiny world"\nEND`);
  editor.focus();
});
exampleSelect.addEventListener("change", () => {
  const example = examples[exampleSelect.value];
  if (example) setSource(example.source);
});
$("#help-button").addEventListener("click", () => openHelp(true));
$("#help-close").addEventListener("click", () => openHelp(false));
$("#drawer-scrim").addEventListener("click", () => openHelp(false));

buildExamples();
buildHelp();
setSource(localStorage.getItem(STORAGE_KEY) || examples.hello.source, false);
