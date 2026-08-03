import assert from "node:assert/strict";
import test from "node:test";

import {
  GAMEBOY_CONTROL_STORAGE_KEY,
  GAMEBOY_DEFAULT_CONTROLS,
  GameBoyControlMap,
  GameBoyPlayer,
  gameBoyControlLabel
} from "./gameboy.js";

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

test("Game Boy controls use physical key codes and persist remaps", () => {
  const storage = new MemoryStorage();
  const controls = new GameBoyControlMap(storage);
  assert.deepEqual(controls.bindings, GAMEBOY_DEFAULT_CONTROLS);
  assert.equal(controls.actionFor({ code: "KeyX" }), "a");

  assert.equal(controls.assign("a", "KeyQ"), true);
  assert.equal(controls.actionFor({ code: "KeyQ" }), "a");
  assert.equal(new GameBoyControlMap(storage).bindings.a, "KeyQ");
});

test("assigning a used Game Boy key swaps bindings instead of creating a conflict", () => {
  const controls = new GameBoyControlMap(new MemoryStorage());
  assert.equal(controls.assign("a", "KeyZ"), true);
  assert.equal(controls.bindings.a, "KeyZ");
  assert.equal(controls.bindings.b, "KeyX");
  assert.equal(new Set(Object.values(controls.bindings)).size, Object.keys(controls.bindings).length);
  assert.equal(controls.assign("a", "Escape"), false);
});

test("invalid saved Game Boy controls fall back to defaults", () => {
  const storage = new MemoryStorage({
    [GAMEBOY_CONTROL_STORAGE_KEY]: JSON.stringify({ ...GAMEBOY_DEFAULT_CONTROLS, a: "KeyZ" })
  });
  const controls = new GameBoyControlMap(storage);
  assert.deepEqual(controls.bindings, GAMEBOY_DEFAULT_CONTROLS);
  assert.equal(gameBoyControlLabel("ArrowLeft"), "ARROW LEFT");
  assert.equal(gameBoyControlLabel("KeyM"), "M");
});

test("mapped keyboard events reach the active Game Boy core before shell input", () => {
  const calls = [];
  const player = Object.create(GameBoyPlayer.prototype);
  player.active = true;
  player.paused = false;
  player.emulator = 73;
  player.awaitingAction = "";
  player.pressedActions = new Set();
  player.controls = new GameBoyControlMap(new MemoryStorage());
  player.controlsDialog = { open: false };
  player.controlsRoot = { querySelector: () => null };
  player.module = { _set_joyp_A: (...args) => calls.push(args) };
  const event = {
    code: "KeyX",
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }
  };

  assert.equal(player.handleKey(event, true), true);
  assert.equal(player.handleKey(event, false), true);
  assert.deepEqual(calls, [[73, 1], [73, 0]]);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});
