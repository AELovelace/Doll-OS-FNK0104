const CPU_TICKS_PER_SECOND = 4_194_304;
const AUDIO_FRAMES = 4_096;
const EVENT_AUDIO_BUFFER_FULL = 2;
const EVENT_UNTIL_TICKS = 4;
const ROM_LIMIT = 8 * 1024 * 1024;

export const GAMEBOY_CONTROL_STORAGE_KEY = "doll-os-gb-controls-v1";
export const GAMEBOY_ACTIONS = Object.freeze(["up", "down", "left", "right", "b", "a", "select", "start"]);
export const GAMEBOY_DEFAULT_CONTROLS = Object.freeze({
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  b: "KeyZ",
  a: "KeyX",
  select: "Tab",
  start: "Enter"
});

const ACTION_METHODS = Object.freeze({
  up: "_set_joyp_up",
  down: "_set_joyp_down",
  left: "_set_joyp_left",
  right: "_set_joyp_right",
  b: "_set_joyp_B",
  a: "_set_joyp_A",
  select: "_set_joyp_select",
  start: "_set_joyp_start"
});

let loaderPromise;

function loadCoreScript() {
  if (globalThis.Binjgb) return Promise.resolve(globalThis.Binjgb);
  loaderPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./vendor/binjgb/binjgb.js", import.meta.url).href;
    script.onload = () => globalThis.Binjgb ? resolve(globalThis.Binjgb) : reject(new Error("binjgb did not initialize"));
    script.onerror = () => reject(new Error("could not load the bundled Game Boy core"));
    document.head.append(script);
  });
  return loaderPromise;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function gameBoyControlLabel(code) {
  const labels = {
    ArrowUp: "ARROW UP", ArrowDown: "ARROW DOWN", ArrowLeft: "ARROW LEFT", ArrowRight: "ARROW RIGHT",
    Enter: "ENTER", Tab: "TAB", Space: "SPACE", Backspace: "BACKSPACE",
    ShiftLeft: "LEFT SHIFT", ShiftRight: "RIGHT SHIFT", ControlLeft: "LEFT CTRL", ControlRight: "RIGHT CTRL"
  };
  if (labels[code]) return labels[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return String(code || "UNBOUND").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
}

export class GameBoyControlMap {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.bindings = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(this.storage?.getItem(GAMEBOY_CONTROL_STORAGE_KEY) || "null");
      const values = GAMEBOY_ACTIONS.map(action => parsed?.[action]);
      if (values.every(code => typeof code === "string" && code && code !== "Escape")
          && new Set(values).size === GAMEBOY_ACTIONS.length) return { ...parsed };
    } catch {}
    return { ...GAMEBOY_DEFAULT_CONTROLS };
  }

  persist() {
    try { this.storage?.setItem(GAMEBOY_CONTROL_STORAGE_KEY, JSON.stringify(this.bindings)); }
    catch {}
  }

  reset() {
    this.bindings = { ...GAMEBOY_DEFAULT_CONTROLS };
    this.persist();
    return this.bindings;
  }

  assign(action, code) {
    if (!GAMEBOY_ACTIONS.includes(action) || typeof code !== "string" || !code || code === "Escape") return false;
    const previous = this.bindings[action];
    const conflict = GAMEBOY_ACTIONS.find(candidate => candidate !== action && this.bindings[candidate] === code);
    this.bindings[action] = code;
    if (conflict) this.bindings[conflict] = previous;
    this.persist();
    return true;
  }

  actionFor(event) {
    return GAMEBOY_ACTIONS.find(action => this.bindings[action] === event.code) || "";
  }
}

export class GameBoyPlayer {
  constructor({
    canvas,
    fileInput,
    status,
    controlsRoot,
    controlsDialog,
    audio,
    storage = globalThis.localStorage,
    onActiveChange = () => {}
  } = {}) {
    this.canvas = canvas;
    this.context2d = canvas.getContext("2d", { alpha: false });
    this.frameCanvas = document.createElement("canvas");
    this.frameCanvas.width = 160;
    this.frameCanvas.height = 144;
    this.frameContext = this.frameCanvas.getContext("2d", { alpha: false });
    this.fileInput = fileInput;
    this.status = status;
    this.controlsRoot = controlsRoot;
    this.controlsDialog = controlsDialog;
    this.audio = audio;
    this.storage = storage;
    this.onActiveChange = onActiveChange;
    this.controls = new GameBoyControlMap(storage);
    this.module = null;
    this.emulator = 0;
    this.joypad = 0;
    this.romAllocation = 0;
    this.romKey = "";
    this.romName = "";
    this.animation = 0;
    this.paused = false;
    this.active = false;
    this.audioCursor = 0;
    this.audioSources = new Set();
    this.pressedActions = new Set();
    this.awaitingAction = "";
    this.boundKeyDown = event => this.handleKey(event, true);
    this.boundKeyUp = event => this.handleKey(event, false);
    this.boundBlur = () => this.releaseAll();
    this.bindUi();
    this.updateControlLabels();
  }

  bindUi() {
    this.controlsRoot.querySelector("[data-gb-open]").addEventListener("click", () => this.fileInput.click());
    this.controlsRoot.querySelector("[data-gb-exit]").addEventListener("click", () => this.exit());
    this.controlsRoot.querySelector("[data-gb-pause]").addEventListener("click", () => this.togglePause());
    this.controlsRoot.querySelector("[data-gb-save]").addEventListener("click", () => this.saveState());
    this.controlsRoot.querySelector("[data-gb-load]").addEventListener("click", () => this.loadState());
    this.controlsRoot.querySelector("[data-gb-controls]").addEventListener("click", () => this.openControls());
    this.fileInput.addEventListener("change", async event => {
      const [file] = event.target.files;
      if (!file) return;
      try { await this.load(file); }
      catch (error) {
        this.setStatus(error.message, true);
        this.drawStandby("ROM ERROR", error.message);
      }
      event.target.value = "";
    });
    for (const button of this.controlsRoot.querySelectorAll("[data-gb-action]")) {
      const action = button.dataset.gbAction;
      const set = pressed => {
        if (!this.active) return;
        button.classList.toggle("pressed", pressed);
        this.setAction(action, pressed);
      };
      button.addEventListener("pointerdown", event => {
        event.preventDefault();
        button.setPointerCapture(event.pointerId);
        set(true);
      });
      button.addEventListener("pointerup", () => set(false));
      button.addEventListener("pointercancel", () => set(false));
      button.addEventListener("lostpointercapture", () => set(false));
    }
    for (const button of this.controlsDialog.querySelectorAll("[data-gb-bind]")) {
      button.addEventListener("click", event => {
        event.preventDefault();
        this.awaitingAction = button.dataset.gbBind;
        this.updateControlLabels();
        button.textContent = "PRESS A KEY";
        this.controlsDialog.querySelector("[data-gb-config-status]").textContent = "Press a key. Escape cancels.";
      });
    }
    this.controlsDialog.querySelector("[data-gb-reset]").addEventListener("click", () => {
      this.controls.reset();
      this.awaitingAction = "";
      this.updateControlLabels();
      this.controlsDialog.querySelector("[data-gb-config-status]").textContent = "Default controls restored.";
    });
    this.controlsDialog.addEventListener("close", () => {
      this.awaitingAction = "";
      this.updateControlLabels();
      if (this.active) this.canvas.focus?.();
    });
  }

  enter() {
    if (this.active) return;
    this.active = true;
    document.addEventListener("keydown", this.boundKeyDown, true);
    document.addEventListener("keyup", this.boundKeyUp, true);
    window.addEventListener("blur", this.boundBlur);
    this.controlsRoot.hidden = false;
    this.onActiveChange(true);
    this.setStatus("CHOOSE A ROM FROM THIS DEVICE");
    this.drawStandby("GAME BOY", "CHOOSE A .GB OR .GBC ROM");
  }

  open() {
    this.enter();
    void this.audio.unlock();
    this.fileInput.click();
  }

  openControls() {
    this.enter();
    this.updateControlLabels();
    this.controlsDialog.querySelector("[data-gb-config-status]").textContent = "Choose a control, then press its new key.";
    if (!this.controlsDialog.open) this.controlsDialog.showModal();
  }

  updateControlLabels() {
    for (const button of this.controlsDialog.querySelectorAll("[data-gb-bind]")) {
      if (button.dataset.gbBind === this.awaitingAction) continue;
      button.textContent = gameBoyControlLabel(this.controls.bindings[button.dataset.gbBind]);
    }
    const summary = GAMEBOY_ACTIONS
      .map(action => `${action.toUpperCase()}:${gameBoyControlLabel(this.controls.bindings[action])}`)
      .join(" · ");
    const help = this.controlsRoot.querySelector("[data-gb-control-summary]");
    if (help) help.textContent = `${summary} · ESC:EXIT`;
  }

  handleKey(event, pressed) {
    if (this.awaitingAction && pressed) {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") {
        this.awaitingAction = "";
        this.updateControlLabels();
        this.controlsDialog.querySelector("[data-gb-config-status]").textContent = "Remapping cancelled.";
        return true;
      }
      this.controls.assign(this.awaitingAction, event.code);
      this.awaitingAction = "";
      this.updateControlLabels();
      this.controlsDialog.querySelector("[data-gb-config-status]").textContent = "Control saved in this browser.";
      return true;
    }
    if (!this.active || this.controlsDialog.open) return false;
    if (event.code === "Escape") {
      if (pressed) this.exit();
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    const action = this.controls.actionFor(event);
    if (!action) return false;
    event.preventDefault();
    event.stopPropagation();
    this.controlsRoot.querySelector(`[data-gb-action="${action}"]`)?.classList.toggle("pressed", pressed);
    this.setAction(action, pressed);
    return true;
  }

  setAction(action, pressed) {
    const method = ACTION_METHODS[action];
    if (!method) return;
    if (pressed) {
      if (this.pressedActions.has(action)) return;
      this.pressedActions.add(action);
    } else {
      if (!this.pressedActions.delete(action)) return;
    }
    if (this.emulator && !this.paused) this.module[method]?.(this.emulator, Number(pressed));
  }

  connectJoypad() {
    this.joypad = this.module._joypad_new();
    if (!this.joypad) throw new Error("The Game Boy core could not initialize its controls");
    this.module._emulator_set_default_joypad_callback(this.emulator, this.joypad);
  }

  releaseAll() {
    for (const action of [...this.pressedActions]) {
      const method = ACTION_METHODS[action];
      if (this.emulator) this.module[method]?.(this.emulator, 0);
    }
    this.pressedActions.clear();
    for (const button of this.controlsRoot.querySelectorAll("[data-gb-action]")) button.classList.remove("pressed");
  }

  setStatus(message, error = false) {
    this.status.textContent = message;
    this.status.dataset.state = error ? "error" : "ready";
  }

  drawStandby(title, detail = "") {
    const { width, height } = this.canvas;
    this.context2d.imageSmoothingEnabled = false;
    this.context2d.fillStyle = "#000";
    this.context2d.fillRect(0, 0, width, height);
    this.context2d.textAlign = "center";
    this.context2d.textBaseline = "middle";
    this.context2d.font = `${Math.max(12, Math.floor(height / 14))}px "VCR OSD Mono", monospace`;
    this.context2d.fillStyle = "#ff0f7f";
    this.context2d.fillText(title, width / 2, height / 2 - 15);
    this.context2d.font = `${Math.max(7, Math.floor(height / 32))}px "VCR OSD Mono", monospace`;
    this.context2d.fillStyle = "#eee4ea";
    this.context2d.fillText(String(detail).slice(0, 46), width / 2, height / 2 + 18);
    this.context2d.textAlign = "left";
    this.context2d.textBaseline = "top";
  }

  async load(file) {
    if (!/\.(gb|gbc)$/i.test(file.name)) throw new Error("Choose a .gb or .gbc ROM file");
    if (file.size < 0x150 || file.size > ROM_LIMIT) throw new Error("ROM size is outside the supported 336 B to 8 MiB range");
    this.enter();
    this.destroyEmulator();
    this.setStatus("LOADING CORE...");
    this.drawStandby("GAME BOY", "LOADING CORE...");
    const factory = await loadCoreScript();
    this.module ||= await factory({ locateFile: name => new URL(`./vendor/binjgb/${name}`, import.meta.url).href });
    const rom = new Uint8Array(await file.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rom));
    this.romKey = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
    this.romName = file.name;
    const romSize = (rom.length + 0x7fff) & ~0x7fff;
    this.romAllocation = this.module._malloc(romSize);
    this.module.HEAPU8.fill(0, this.romAllocation, this.romAllocation + romSize);
    this.module.HEAPU8.set(rom, this.romAllocation);
    const sampleRate = this.audio.context?.sampleRate || 48_000;
    this.emulator = this.module._emulator_new_simple(this.romAllocation, romSize, sampleRate, AUDIO_FRAMES, 0);
    if (!this.emulator) {
      this.module._free(this.romAllocation);
      this.romAllocation = 0;
      throw new Error("The Game Boy core rejected this ROM");
    }
    try {
      this.connectJoypad();
    } catch (error) {
      this.module._emulator_delete(this.emulator);
      this.module._free(this.romAllocation);
      this.emulator = 0;
      this.romAllocation = 0;
      throw error;
    }
    this.restoreRam();
    this.audioCursor = this.audio.context?.currentTime || 0;
    this.paused = false;
    this.updatePauseButton();
    this.setStatus(`${file.name} // RUNNING`);
    this.frame();
  }

  frame() {
    if (!this.emulator || this.paused || !this.active) return;
    const target = this.module._emulator_get_ticks_f64(this.emulator) + CPU_TICKS_PER_SECOND / 60;
    for (let guard = 0; guard < 16; guard += 1) {
      const events = this.module._emulator_run_until_f64(this.emulator, target);
      if (events & EVENT_AUDIO_BUFFER_FULL) this.queueAudio();
      if (events & EVENT_UNTIL_TICKS) break;
    }
    this.render();
    if (this.module._emulator_was_ext_ram_updated(this.emulator)) this.saveRam();
    this.animation = requestAnimationFrame(() => this.frame());
  }

  render() {
    if (!this.emulator) {
      if (this.active) this.drawStandby("GAME BOY", "CHOOSE A .GB OR .GBC ROM");
      return;
    }
    const pointer = this.module._get_frame_buffer_ptr(this.emulator);
    const size = this.module._get_frame_buffer_size(this.emulator);
    if (size < 160 * 144 * 4) return;
    const pixels = new Uint8ClampedArray(this.module.HEAPU8.buffer, pointer, 160 * 144 * 4);
    this.frameContext.putImageData(new ImageData(pixels.slice(), 160, 144), 0, 0);
    const { width, height } = this.canvas;
    const scale = Math.min(width / 160, height / 144);
    const drawWidth = Math.max(1, Math.floor(160 * scale));
    const drawHeight = Math.max(1, Math.floor(144 * scale));
    const x = Math.floor((width - drawWidth) / 2);
    const y = Math.floor((height - drawHeight) / 2);
    this.context2d.imageSmoothingEnabled = false;
    this.context2d.fillStyle = "#000";
    this.context2d.fillRect(0, 0, width, height);
    this.context2d.drawImage(this.frameCanvas, 0, 0, 160, 144, x, y, drawWidth, drawHeight);
  }

  queueAudio() {
    const context = this.audio.context;
    if (!context || context.state !== "running") return;
    const capacity = this.module._get_audio_buffer_capacity(this.emulator);
    const pointer = this.module._get_audio_buffer_ptr(this.emulator);
    const samples = new Uint8Array(this.module.HEAPU8.buffer, pointer, capacity);
    const frames = Math.min(AUDIO_FRAMES, Math.floor(capacity / 2));
    const buffer = context.createBuffer(2, frames, context.sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let index = 0; index < frames; index += 1) {
      left[index] = samples[index * 2] / 510;
      right[index] = samples[index * 2 + 1] / 510;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.audioCursor = Math.max(context.currentTime + 0.01, this.audioCursor);
    source.start(this.audioCursor);
    this.audioCursor += buffer.duration;
    source.onended = () => this.audioSources.delete(source);
    this.audioSources.add(source);
  }

  updatePauseButton() {
    this.controlsRoot.querySelector("[data-gb-pause]").textContent = this.paused ? "RESUME" : "PAUSE";
  }

  togglePause() {
    if (!this.emulator) return this.setStatus("LOAD A ROM FIRST", true);
    this.releaseAll();
    this.paused = !this.paused;
    this.updatePauseButton();
    this.setStatus(this.paused ? `${this.romName} // PAUSED` : `${this.romName} // RUNNING`);
    if (!this.paused) this.frame();
  }

  withFileData(method, callback) {
    const data = this.module[method](this.emulator);
    if (!data) return null;
    const pointer = this.module._get_file_data_ptr(data);
    const size = this.module._get_file_data_size(data);
    const result = callback(data, new Uint8Array(this.module.HEAPU8.buffer, pointer, size));
    this.module._file_data_delete(data);
    return result;
  }

  saveRam() {
    if (!this.emulator || !this.romKey) return;
    const bytes = this.withFileData("_ext_ram_file_data_new", (data, buffer) => {
      this.module._emulator_write_ext_ram(this.emulator, data);
      return buffer.slice();
    });
    if (bytes?.length) this.storage?.setItem(`doll-os-gb-ram-${this.romKey}`, bytesToBase64(bytes));
  }

  restoreRam() {
    const encoded = this.storage?.getItem(`doll-os-gb-ram-${this.romKey}`);
    if (!encoded) return;
    const bytes = base64ToBytes(encoded);
    this.withFileData("_ext_ram_file_data_new", (data, buffer) => {
      if (buffer.length !== bytes.length) return;
      buffer.set(bytes);
      this.module._emulator_read_ext_ram(this.emulator, data);
    });
  }

  saveState() {
    if (!this.emulator) return this.setStatus("LOAD A ROM FIRST", true);
    const bytes = this.withFileData("_state_file_data_new", (data, buffer) => {
      this.module._emulator_write_state(this.emulator, data);
      return buffer.slice();
    });
    if (!bytes?.length) return this.setStatus("STATE SAVE FAILED", true);
    this.storage?.setItem(`doll-os-gb-state-${this.romKey}`, bytesToBase64(bytes));
    this.setStatus("STATE SAVED IN THIS BROWSER");
  }

  loadState() {
    if (!this.emulator) return this.setStatus("LOAD A ROM FIRST", true);
    const encoded = this.storage?.getItem(`doll-os-gb-state-${this.romKey}`);
    if (!encoded) return this.setStatus("NO SAVED STATE FOR THIS ROM", true);
    const bytes = base64ToBytes(encoded);
    let ok = false;
    this.withFileData("_state_file_data_new", (data, buffer) => {
      if (buffer.length !== bytes.length) return;
      buffer.set(bytes);
      this.module._emulator_read_state(this.emulator, data);
      ok = true;
    });
    this.setStatus(ok ? "STATE LOADED" : "STATE LOAD FAILED", !ok);
    if (ok) this.render();
  }

  destroyEmulator() {
    cancelAnimationFrame(this.animation);
    this.animation = 0;
    this.releaseAll();
    for (const source of this.audioSources) try { source.stop(); } catch {}
    this.audioSources.clear();
    if (this.joypad && this.module) this.module._joypad_delete(this.joypad);
    if (this.emulator && this.module) {
      this.saveRam();
      this.module._emulator_delete(this.emulator);
      this.module._free(this.romAllocation);
    }
    this.joypad = 0;
    this.emulator = 0;
    this.romAllocation = 0;
  }

  exit() {
    if (!this.active) return;
    this.destroyEmulator();
    this.active = false;
    document.removeEventListener("keydown", this.boundKeyDown, true);
    document.removeEventListener("keyup", this.boundKeyUp, true);
    window.removeEventListener("blur", this.boundBlur);
    if (this.controlsDialog.open) this.controlsDialog.close();
    this.controlsRoot.hidden = true;
    this.setStatus("GAME BOY STOPPED");
    this.onActiveChange(false);
  }

  stop() { this.exit(); }
}
