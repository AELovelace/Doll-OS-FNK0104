import assert from "node:assert/strict";
import test from "node:test";

import { BrowserAudioController } from "./browser-audio.js";

class FakeNode {
  connect() {}
  disconnect() {}
  start() { this.started = true; }
  stop() { this.stopped = true; }
}

class FakeAudioContext {
  constructor() { this.state = "suspended"; this.sampleRate = 48_000; this.destination = {}; }
  async resume() { this.state = "running"; }
  createGain() { return Object.assign(new FakeNode(), { gain: { value: 0 } }); }
  createOscillator() { return Object.assign(new FakeNode(), { frequency: { value: 0 }, type: "" }); }
  createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  createBufferSource() { return Object.assign(new FakeNode(), { loop: false }); }
  createBiquadFilter() { return Object.assign(new FakeNode(), { frequency: { value: 0 }, type: "" }); }
}

class FakeAudio {
  constructor() { this.src = ""; this.paused = true; this.volume = 1; }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
}

test("audio readiness reflects an actually running AudioContext and tracker gain is audible", async () => {
  const audio = new BrowserAudioController({ AudioContextCtor: FakeAudioContext, AudioCtor: FakeAudio });
  assert.equal(audio.isReady, false);
  await audio.wave({ channel: 1, waveform: "square", frequency: 440, level: 100 });
  assert.equal(audio.isReady, true);
  assert.ok(audio.channels.get(1).gain.gain.value > 0.27);
  audio.stopAllWaves();
  assert.equal(audio.channels.size, 0);
});

test("radio plays a supplied HTTPS stream and preserves volume across pause", async () => {
  const audio = new BrowserAudioController({ AudioContextCtor: FakeAudioContext, AudioCtor: FakeAudio });
  audio.setRadioVolume(7);
  const playing = await audio.playRadio("https://radio.example/live.mp3");
  assert.equal(playing.playing, true);
  assert.equal(playing.volume, 7);
  assert.equal(audio.pauseRadio().playing, false);
  await assert.rejects(() => audio.playRadio("file:///secret"), /HTTP or HTTPS/);
});
