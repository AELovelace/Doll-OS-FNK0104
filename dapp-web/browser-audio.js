const WAVE_TYPES = Object.freeze({ sin: "sine", tri: "triangle", sq: "square" });
const HARDWARE_PEAK_GAIN = 9000 / 32767;

export class BrowserAudioController {
  constructor({
    AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext,
    AudioCtor = globalThis.Audio,
    waveGain = HARDWARE_PEAK_GAIN
  } = {}) {
    this.AudioContextCtor = AudioContextCtor;
    this.AudioCtor = AudioCtor;
    this.waveGain = waveGain;
    this.context = null;
    this.channels = new Map();
    this.radio = null;
    this.radioUrl = "";
    this.radioVolume = 12;
    this.lastError = "";
  }

  get isReady() {
    return this.context?.state === "running";
  }

  async unlock() {
    if (!this.AudioContextCtor) {
      this.lastError = "Web Audio is unavailable in this browser";
      return false;
    }
    try {
      this.context ||= new this.AudioContextCtor();
      if (this.context.state !== "running") await this.context.resume();
      this.lastError = this.context.state === "running" ? "" : `audio context is ${this.context.state}`;
      return this.isReady;
    } catch (error) {
      this.lastError = error?.message || "audio could not be started";
      return false;
    }
  }

  stopWave(channel) {
    const voice = this.channels.get(Number(channel));
    if (!voice) return;
    try { voice.source.stop(); } catch {}
    try { voice.source.disconnect(); } catch {}
    try { voice.filter?.disconnect(); } catch {}
    try { voice.gain.disconnect(); } catch {}
    this.channels.delete(Number(channel));
  }

  async wave({ channel, waveform, frequency, level }) {
    this.stopWave(channel);
    if (waveform === "off" || Number(level) <= 0) return true;
    if (!await this.unlock()) throw new Error(this.lastError || "browser audio is locked");

    const gain = this.context.createGain();
    gain.gain.value = Math.max(0, Math.min(100, Number(level))) / 100 * this.waveGain;
    gain.connect(this.context.destination);
    let source;
    let filter;
    if (waveform === "noise") {
      const buffer = this.context.createBuffer(1, this.context.sampleRate, this.context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1;
      source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      filter = this.context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = Number(frequency);
      source.connect(filter);
      filter.connect(gain);
    } else {
      source = this.context.createOscillator();
      source.type = WAVE_TYPES[waveform] || waveform;
      source.frequency.value = Number(frequency);
      source.connect(gain);
    }
    source.start();
    this.channels.set(Number(channel), { source, gain, filter });
    return true;
  }

  stopAllWaves() {
    for (const channel of [...this.channels.keys()]) this.stopWave(channel);
  }

  ensureRadio() {
    if (!this.AudioCtor) throw new Error("HTML audio playback is unavailable in this browser");
    if (!this.radio) {
      this.radio = new this.AudioCtor();
      this.radio.preload = "none";
      this.radio.volume = this.radioVolume / 21;
    }
    return this.radio;
  }

  setRadioVolume(level) {
    this.radioVolume = Math.max(0, Math.min(21, Number.parseInt(level, 10) || 0));
    if (this.radio) this.radio.volume = this.radioVolume / 21;
    return this.radioVolume;
  }

  async playRadio(url = "") {
    const player = this.ensureRadio();
    if (url) {
      const parsed = new URL(url, globalThis.location?.href || "https://browser.invalid/");
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("radio URL must use HTTP or HTTPS");
      this.radioUrl = parsed.href;
      player.src = this.radioUrl;
    }
    if (!player.src) throw new Error("radio play needs a stream URL the first time");
    try {
      await player.play();
      this.lastError = "";
      return this.radioStatus();
    } catch (error) {
      this.lastError = error?.message || "stream playback failed";
      throw new Error(`stream playback failed: ${this.lastError}`);
    }
  }

  pauseRadio() {
    if (this.radio) this.radio.pause();
    return this.radioStatus();
  }

  stopRadio() {
    if (this.radio) {
      this.radio.pause();
      try { this.radio.currentTime = 0; } catch {}
    }
    return this.radioStatus();
  }

  radioStatus() {
    return {
      playing: Boolean(this.radio?.src && !this.radio.paused),
      url: this.radioUrl,
      volume: this.radioVolume,
      error: this.lastError
    };
  }
}
