const CPU_TICKS_PER_SECOND = 4_194_304;
const AUDIO_FRAMES = 4_096;
const EVENT_NEW_FRAME = 1;
const EVENT_AUDIO_BUFFER_FULL = 2;
const EVENT_UNTIL_TICKS = 4;
const ROM_LIMIT = 8 * 1024 * 1024;
const KEY_METHODS = Object.freeze({
  ArrowUp: "_set_joyp_up", ArrowDown: "_set_joyp_down", ArrowLeft: "_set_joyp_left", ArrowRight: "_set_joyp_right",
  z: "_set_joyp_B", x: "_set_joyp_A", Enter: "_set_joyp_start", Tab: "_set_joyp_select"
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

export class GameBoyPlayer {
  constructor({ dialog, canvas, fileInput, status, audio, storage = globalThis.localStorage } = {}) {
    this.dialog = dialog;
    this.canvas = canvas;
    this.context2d = canvas.getContext("2d", { alpha: false });
    this.fileInput = fileInput;
    this.status = status;
    this.audio = audio;
    this.storage = storage;
    this.module = null;
    this.emulator = 0;
    this.romAllocation = 0;
    this.romKey = "";
    this.animation = 0;
    this.paused = false;
    this.audioCursor = 0;
    this.audioSources = new Set();
    this.boundKeyDown = event => this.setKey(event, true);
    this.boundKeyUp = event => this.setKey(event, false);
    this.bindUi();
  }

  bindUi() {
    this.dialog.querySelector("[data-gb-close]").addEventListener("click", () => this.dialog.close());
    this.dialog.querySelector("[data-gb-open]").addEventListener("click", () => this.fileInput.click());
    this.fileInput.addEventListener("change", async event => {
      const [file] = event.target.files;
      if (!file) return;
      try { await this.load(file); }
      catch (error) { this.setStatus(error.message, true); }
      event.target.value = "";
    });
    this.dialog.addEventListener("close", () => this.stop());
    this.dialog.querySelector("[data-gb-pause]").addEventListener("click", () => this.togglePause());
    this.dialog.querySelector("[data-gb-save]").addEventListener("click", () => this.saveState());
    this.dialog.querySelector("[data-gb-load]").addEventListener("click", () => this.loadState());
    for (const button of this.dialog.querySelectorAll("[data-gb-key]")) {
      const set = pressed => {
        if (!this.emulator) return;
        this.module[KEY_METHODS[button.dataset.gbKey]]?.(this.emulator, Number(pressed));
      };
      button.addEventListener("pointerdown", event => { event.preventDefault(); button.setPointerCapture(event.pointerId); set(true); });
      button.addEventListener("pointerup", () => set(false));
      button.addEventListener("pointercancel", () => set(false));
    }
  }

  open() {
    if (!this.dialog.open) this.dialog.showModal();
    void this.audio.unlock();
    this.fileInput.click();
  }

  setStatus(message, error = false) {
    this.status.textContent = message;
    this.status.dataset.state = error ? "error" : "ready";
  }

  async load(file) {
    if (!/\.(gb|gbc)$/i.test(file.name)) throw new Error("Choose a .gb or .gbc ROM file");
    if (file.size < 0x150 || file.size > ROM_LIMIT) throw new Error("ROM size is outside the supported 336 B to 8 MiB range");
    this.stop();
    this.setStatus("LOADING CORE...");
    const factory = await loadCoreScript();
    this.module ||= await factory({ locateFile: name => new URL(`./vendor/binjgb/${name}`, import.meta.url).href });
    const rom = new Uint8Array(await file.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rom));
    this.romKey = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
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
    this.restoreRam();
    this.audioCursor = this.audio.context?.currentTime || 0;
    this.paused = false;
    document.addEventListener("keydown", this.boundKeyDown);
    document.addEventListener("keyup", this.boundKeyUp);
    this.setStatus(`${file.name} // RUNNING`);
    this.frame();
  }

  frame() {
    if (!this.emulator || this.paused) return;
    const target = this.module._emulator_get_ticks_f64(this.emulator) + CPU_TICKS_PER_SECOND / 60;
    let events = 0;
    for (let guard = 0; guard < 16; guard += 1) {
      events = this.module._emulator_run_until_f64(this.emulator, target);
      if (events & EVENT_AUDIO_BUFFER_FULL) this.queueAudio();
      if (events & EVENT_UNTIL_TICKS) break;
    }
    this.render();
    if (this.module._emulator_was_ext_ram_updated(this.emulator)) this.saveRam();
    this.animation = requestAnimationFrame(() => this.frame());
  }

  render() {
    const pointer = this.module._get_frame_buffer_ptr(this.emulator);
    const size = this.module._get_frame_buffer_size(this.emulator);
    if (size < 160 * 144 * 4) return;
    const pixels = new Uint8ClampedArray(this.module.HEAPU8.buffer, pointer, 160 * 144 * 4);
    this.context2d.putImageData(new ImageData(pixels.slice(), 160, 144), 0, 0);
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

  setKey(event, pressed) {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const method = KEY_METHODS[key];
    if (!this.emulator || !method) return;
    event.preventDefault();
    this.module[method](this.emulator, Number(pressed));
  }

  togglePause() {
    if (!this.emulator) return;
    this.paused = !this.paused;
    this.dialog.querySelector("[data-gb-pause]").textContent = this.paused ? "RESUME" : "PAUSE";
    this.setStatus(this.paused ? "PAUSED" : "RUNNING");
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
  }

  stop() {
    cancelAnimationFrame(this.animation);
    this.animation = 0;
    document.removeEventListener("keydown", this.boundKeyDown);
    document.removeEventListener("keyup", this.boundKeyUp);
    for (const source of this.audioSources) try { source.stop(); } catch {}
    this.audioSources.clear();
    if (this.emulator && this.module) {
      this.saveRam();
      this.module._emulator_delete(this.emulator);
      this.module._free(this.romAllocation);
    }
    this.emulator = 0;
    this.romAllocation = 0;
  }
}
