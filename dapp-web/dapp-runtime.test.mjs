import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DappRuntime } from "./dapp-runtime.js";

class MemoryFiles {
  constructor(files = {}) { this.files = { ...files }; }
  exists(path) { return Object.hasOwn(this.files, path); }
  read(path) { return this.files[path] ?? null; }
  write(path, content) { this.files[path] = content; }
  delete(path) {
    if (!this.exists(path)) return false;
    delete this.files[path];
    return true;
  }
}

function runtimeFor(files, events = {}) {
  const io = {
    output() {},
    clear() {},
    status() {},
    input() {},
    canvas() {},
    endCanvas() {},
    wave: value => (events.waves ||= []).push(value),
    waveStop: () => { events.stops = (events.stops || 0) + 1; }
  };
  return new DappRuntime(io, files);
}

test("raw file opcodes preserve NUL, newline, and 0xff while update patches in place", async () => {
  const original = String.fromCharCode(0x00, 0x0a, 0xff, 0x41);
  const files = new MemoryFiles({ "/apps/test.bin": original });
  const runtime = runtimeFor(files);
  const result = await runtime.run(`
FOPEN "/apps/test.bin" update
FSIZE size
FREADB b0
FREADB b1
FREADB b2
FSEEK 2
FWRITEB 17
FTELL pos
FSEEK 0
FREADB again
HEX shown 255 2
FCLOSE
END`);

  assert.equal(result.ok, true);
  assert.equal(runtime.numbers.get("size"), 4);
  assert.equal(runtime.numbers.get("b0"), 0);
  assert.equal(runtime.numbers.get("b1"), 10);
  assert.equal(runtime.numbers.get("b2"), 255);
  assert.equal(runtime.numbers.get("pos"), 3);
  assert.equal(runtime.numbers.get("again"), 0);
  assert.equal(runtime.strings.get("shown"), "FF");
  assert.deepEqual([...files.read("/apps/test.bin")].map(ch => ch.charCodeAt(0)), [0, 10, 17, 65]);
});

test("HTTPGET bounds the decoded body and reports status", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode("abcdef").buffer
  });

  const runtime = runtimeFor(new MemoryFiles());
  const result = await runtime.run(`HTTPGET body "https://example.test/" 4\nEND`);
  assert.equal(result.ok, true);
  assert.equal(runtime.strings.get("body"), "abcd");
  assert.equal(runtime.httpcode, 200);
  assert.equal(runtime.httplen, 4);
  assert.equal(runtime.httptruncated, 1);
  assert.equal(runtime.httpok, 1);
});

test("HTTPPOST sends configured headers and JSON helpers round-trip chat content", async (t) => {
  const previousFetch = globalThis.fetch;
  let request;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    const response = JSON.stringify({ choices: [{ message: { content: "hello Doll" } }] });
    return {
      status: 200,
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(response).buffer
    };
  };

  const runtime = runtimeFor(new MemoryFiles());
  const result = await runtime.run(`
CHR q 34
SETSTR prompt "say "
APPEND prompt $q
APPEND prompt "hello$q"
JSONESC safe $prompt
SETSTR body "{"
APPEND body $q
APPEND body "model$q:"
APPEND body $q
APPEND body "demo$q,"
APPEND body $q
APPEND body "messages$q:[{"
APPEND body $q
APPEND body "role$q:"
APPEND body $q
APPEND body "user$q,"
APPEND body $q
APPEND body "content$q:"
APPEND body $q
APPEND body $safe
APPEND body $q
APPEND body "}]}"
HTTPHEADER "Authorization" "Bearer test-key"
HTTPHEADER "Content-Type" "application/json"
HTTPPOST raw "https://example.test/v1/chat/completions" $body 4096
JSONGET answer $raw "choices[0].message.content"
END`);

  assert.equal(result.ok, true);
  assert.equal(request.url, "https://example.test/v1/chat/completions");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(request.options.body).messages[0].content, 'say "hello"');
  assert.equal(runtime.strings.get("answer"), "hello Doll");
  assert.equal(runtime.jsonok, 1);
});

test("WAVE exposes three-channel settings and app exit always stops audio", async () => {
  const events = {};
  const runtime = runtimeFor(new MemoryFiles(), events);
  const result = await runtime.run(`WAVE 2 triangle 330 25\nEND`);
  assert.equal(result.ok, true);
  assert.deepEqual(events.waves, [{ channel: 2, waveform: "triangle", frequency: 330, level: 25 }]);
  assert.equal(events.stops, 1);
});

test("the shipped synth app renders and exits through its normal key loop", async () => {
  const events = {};
  const files = new MemoryFiles();
  let runtime;
  let sentExit = false;
  const io = {
    output() {}, clear() {}, status() {}, input() {}, endCanvas() {},
    canvas() {
      if (!sentExit) {
        sentExit = true;
        runtime.keyQueue.push(120);
      }
    },
    wave: value => (events.waves ||= []).push(value),
    waveStop: () => { events.stops = (events.stops || 0) + 1; }
  };
  runtime = new DappRuntime(io, files);
  const source = await readFile(new URL("../apps/synth.dapp", import.meta.url), "utf8");
  const result = await runtime.run(source);
  assert.equal(result.ok, true);
  assert.equal(events.waves.length, 3);
  assert.ok(events.stops >= 1);
});

test("the shipped hex editor reads a binary page and exits without changing it", async () => {
  const original = String.fromCharCode(0, 10, 255, 65);
  const files = new MemoryFiles({ "/apps/test.bin": original });
  let runtime;
  let sentExit = false;
  const io = {
    output() {}, clear() {}, status() {}, endCanvas() {}, waveStop() {},
    input(_prompt, resolve) { resolve("/apps/test.bin"); },
    canvas() {
      if (!sentExit) {
        sentExit = true;
        runtime.keyQueue.push(120);
      }
    }
  };
  runtime = new DappRuntime(io, files);
  const source = await readFile(new URL("../apps/hex.dapp", import.meta.url), "utf8");
  const result = await runtime.run(source);
  assert.equal(result.ok, true);
  assert.equal(files.read("/apps/test.bin"), original);
});

test("the shipped LLM chat app masks its key and parses a Chat Completions reply", async (t) => {
  const previousFetch = globalThis.fetch;
  let request;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    const response = JSON.stringify({ choices: [{ message: { content: "Hi from the model" } }] });
    return { status: 200, ok: true, arrayBuffer: async () => new TextEncoder().encode(response).buffer };
  };

  const answers = ["test-key", 'hello "Doll"', "/quit"];
  const outputs = [];
  const masked = [];
  const io = {
    output(text) { outputs.push(text); }, clear() {}, status() {}, canvas() {}, endCanvas() {}, waveStop() {},
    input(_prompt, resolve, isMasked) {
      masked.push(isMasked);
      resolve(answers.shift());
    }
  };
  const runtime = new DappRuntime(io, new MemoryFiles());
  const source = await readFile(new URL("../apps/llm-chat.dapp", import.meta.url), "utf8");
  const result = await runtime.run(source);

  assert.equal(result.ok, true);
  assert.deepEqual(masked, [true, false, false]);
  assert.equal(request.url, "http://192.168.1.50:8000/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(JSON.parse(request.options.body).messages[0].content, 'hello "Doll"');
  assert.ok(outputs.includes("llm> Hi from the model"));
});
