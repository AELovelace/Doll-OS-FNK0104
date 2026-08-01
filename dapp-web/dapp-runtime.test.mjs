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

test("@echo off tells the input UI not to echo submitted lines", async () => {
  const echoFlags = [];
  const io = {
    output() {}, clear() {}, status() {}, canvas() {}, endCanvas() {}, waveStop() {},
    input(_prompt, resolve, _masked, echoInput) {
      echoFlags.push(echoInput);
      resolve("quiet");
    }
  };
  const runtime = new DappRuntime(io, new MemoryFiles());
  const result = await runtime.run("# @echo off\nINPUT line\nEND");

  assert.equal(result.ok, true);
  assert.deepEqual(echoFlags, [false]);
  assert.equal(runtime.strings.get("line"), "quiet");
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
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.referrerPolicy, "no-referrer");
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

test("host policy can block HTTP before fetch", async (t) => {
  const previousFetch = globalThis.fetch;
  let fetched = false;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("should not fetch");
  };
  const outputs = [];
  const io = {
    output: text => outputs.push(text), clear() {}, status() {}, input() {}, canvas() {}, endCanvas() {}, waveStop() {},
    authorizeHttp: () => false
  };
  const runtime = new DappRuntime(io, new MemoryFiles());
  const result = await runtime.run(`HTTPGET body "https://example.test/" 32\nEND`);
  assert.equal(result.ok, true);
  assert.equal(fetched, false);
  assert.equal(runtime.httpcode, -2);
  assert.ok(outputs.includes("HTTP request blocked by browser policy"));
});

test("LIFE advances a Conway grid in native runtime code", async () => {
  const runtime = runtimeFor(new MemoryFiles());
  const result = await runtime.run(`
DIM cur 25
DIM nxt 25
SET cur[7] 1
SET cur[12] 1
SET cur[17] 1
LIFE cur nxt 5 5
SET a $cur[11]
SET b $cur[12]
SET c $cur[13]
SET d $cur[7]
END`);

  assert.equal(result.ok, true);
  assert.equal(runtime.numbers.get("a"), 1);
  assert.equal(runtime.numbers.get("b"), 1);
  assert.equal(runtime.numbers.get("c"), 1);
  assert.equal(runtime.numbers.get("d"), 0);
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

test("the shipped DappChat signs in, joins a room, polls, and exits", async (t) => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    const response = url.endsWith("/auth")
      ? { ok: true, created: false, token: "chat-token" }
      : { ok: true, last_id: 7, messages: [{ id: 7, user: "Asuka", text: "hello Doll" }] };
    return {
      status: 200,
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(response)).buffer
    };
  };

  const answers = ["Doll", "secret", "", "/quit"];
  const outputs = [];
  const io = {
    output(text) { outputs.push(text); }, clear() {}, status() {}, canvas() {}, endCanvas() {}, waveStop() {},
    input(_prompt, resolve) { resolve(answers.shift()); }
  };
  const runtime = new DappRuntime(io, new MemoryFiles());
  const source = await readFile(new URL("../apps/dappchat.dapp", import.meta.url), "utf8");
  const result = await runtime.run(source);

  assert.equal(result.ok, true);
  assert.equal(requests[0].url, "https://sadgirlsclub.wtf/dappchat/auth");
  assert.equal(requests[1].url, "https://sadgirlsclub.wtf/dappchat/poll?room=lobby&since=0");
  assert.equal(requests[1].options.headers.Authorization, "Bearer chat-token");
  assert.ok(outputs.includes("Asuka: hello Doll"));
  assert.ok(outputs.includes("bye"));
});

test("DappChat keeps polling while the room answers a full batch", async (t) => {
  // The server caps a poll at 10 messages. Joining a room with a backlog used
  // to show only the first ten and then creep forward one poll per line typed,
  // so the recent conversation never appeared until you had sent a few
  // messages yourself. One poll now drains what is waiting.
  const previousFetch = globalThis.fetch;
  const polls = [];
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url) => {
    let response;
    if (url.endsWith("/auth")) {
      response = { ok: true, created: false, token: "chat-token" };
    } else {
      polls.push(url);
      // 14 messages waiting: a full batch of 10, then the remaining 4.
      const start = polls.length === 1 ? 1 : 11;
      const count = polls.length === 1 ? 10 : 4;
      const messages = Array.from({ length: count }, (_, i) => (
        { id: start + i, user: "Asuka", text: `line ${start + i}` }
      ));
      response = { ok: true, last_id: start + count - 1, messages };
    }
    return {
      status: 200,
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(response)).buffer
    };
  };

  const answers = ["Doll", "secret", "", "/quit"];
  const outputs = [];
  const io = {
    output(text) { outputs.push(text); }, clear() {}, status() {}, canvas() {}, endCanvas() {}, waveStop() {},
    input(_prompt, resolve) { resolve(answers.shift()); }
  };
  const runtime = new DappRuntime(io, new MemoryFiles());
  const source = await readFile(new URL("../apps/dappchat.dapp", import.meta.url), "utf8");
  const result = await runtime.run(source);

  assert.equal(result.ok, true);
  // Two polls before the first prompt: the full batch, then the rest.
  assert.equal(polls.length, 2);
  assert.equal(polls[0], "https://sadgirlsclub.wtf/dappchat/poll?room=lobby&since=0");
  assert.equal(polls[1], "https://sadgirlsclub.wtf/dappchat/poll?room=lobby&since=10");
  assert.ok(outputs.includes("Asuka: line 14"));
});

test("URLABS resolves relative, root, scheme-relative and dot-segment hrefs", async () => {
  const runtime = runtimeFor(new MemoryFiles());
  const result = await runtime.run([
    'SETSTR base "https://example.test/docs/guide/page.html?x=1"',
    'URLABS rel $base "next.html"',
    'URLABS root $base "/about"',
    'URLABS up $base "../images/logo.png"',
    'URLABS scheme $base "//cdn.example.test/a.js"',
    'URLABS abs $base "http://other.test/z"',
    'URLABS query $base "?page=2"',
    'URLABS frag $base "#section"',
    'URLABS mail $base "mailto:a@b.test"',
    'URLABS keep $base "search?q=a/b"',
    "END"
  ].join("\n"));

  assert.equal(result.ok, true);
  assert.equal(runtime.strings.get("rel"), "https://example.test/docs/guide/next.html");
  assert.equal(runtime.strings.get("root"), "https://example.test/about");
  assert.equal(runtime.strings.get("up"), "https://example.test/docs/images/logo.png");
  assert.equal(runtime.strings.get("scheme"), "https://cdn.example.test/a.js");
  assert.equal(runtime.strings.get("abs"), "http://other.test/z");
  assert.equal(runtime.strings.get("query"), "https://example.test/docs/guide/page.html?page=2");
  // fragments and non-http schemes are not followable and come back empty
  assert.equal(runtime.strings.get("frag"), "");
  assert.equal(runtime.strings.get("mail"), "");
  // a "/" inside a query is not a path segment
  assert.equal(runtime.strings.get("keep"), "https://example.test/docs/guide/search?q=a/b");
});

test("URLPART splits a url into the pieces a networked app actually needs", async () => {
  const runtime = runtimeFor(new MemoryFiles());
  const result = await runtime.run([
    'SETSTR u "https://example.test:8443/a/b/c.html?q=1"',
    'URLPART scheme $u "scheme"',
    'URLPART origin $u "origin"',
    'URLPART host $u "host"',
    'URLPART path $u "path"',
    'URLPART dir $u "dir"',
    "END"
  ].join("\n"));

  assert.equal(result.ok, true);
  assert.equal(runtime.strings.get("scheme"), "https");
  assert.equal(runtime.strings.get("origin"), "https://example.test:8443");
  assert.equal(runtime.strings.get("host"), "example.test:8443");
  assert.equal(runtime.strings.get("path"), "/a/b/c.html?q=1");
  assert.equal(runtime.strings.get("dir"), "https://example.test:8443/a/b/");
});

test("HTMLSTR renders tags, entities and non-ASCII text to wrapped ASCII", async () => {
  const runtime = runtimeFor(new MemoryFiles());
  const page = "<h1>Caf&eacute;</h1><p>one &amp; two&nbsp;three</p>"
    + "<p>naïve — déjà vu…</p>";
  const result = await runtime.run(`SETSTR page "${page}"\nHTMLSTR out text $page\nEND`);

  assert.equal(result.ok, true);
  // the panel font cannot draw above 126, so the renderer folds rather than dropping
  assert.equal(runtime.strings.get("out"), "Cafe\none & two three\nnaive - deja vu...");
});

test("the renderer ignores a bare < inside a script body", async () => {
  const runtime = runtimeFor(new MemoryFiles());
  const page = "<p>before</p><script>if (a<b) { x(); }</script><p>after</p>";
  const result = await runtime.run(`SETSTR page "${page}"\nHTMLSTR out text $page\nEND`);

  assert.equal(result.ok, true);
  // version 1 of browse.dapp swallowed everything to the next '>' here and lost "after"
  assert.equal(runtime.strings.get("out"), "before\nafter");
});

test("HTMLTEXT streams a page into rendered text plus a numbered link file", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const body = "<html><head><title>Home</title></head><body>"
    + "<p>Welcome to the <a href=\"/docs\">docs</a> and the <a href=\"faq.html\">faq</a>.</p>"
    + "<!-- <a href=\"/hidden\">hidden</a> -->"
    + "<style>a { color: red; }</style>"
    + "</body></html>";
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer
  });

  const files = new MemoryFiles();
  const runtime = runtimeFor(files);
  const result = await runtime.run(
    'HTMLTEXT "https://example.test/start/index.html" "/browse.txt" "/browse.lnk" 40 200\nEND'
  );

  assert.equal(result.ok, true);
  assert.equal(runtime.httpcode, 200);
  assert.equal(runtime.htmllinks, 2);
  // link N is line N of the link file, which is what browse.dapp's pager relies on
  assert.deepEqual(files.read("/browse.lnk").trimEnd().split("\n"), [
    "1 https://example.test/docs",
    "2 https://example.test/start/faq.html"
  ]);
  const text = files.read("/browse.txt");
  assert.match(text, /Home/);
  assert.match(text, /\[1\]/);
  assert.match(text, /\[2\]/);
  // commented-out and styled markup contribute neither text nor links
  assert.doesNotMatch(text, /hidden/);
  assert.doesNotMatch(text, /color/);
  for (const line of text.trimEnd().split("\n")) assert.ok(line.length <= 40);
});

test("HTMLTEXT stops collecting links at maxlinks", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const body = '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>';
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer
  });

  const files = new MemoryFiles();
  const runtime = runtimeFor(files);
  const result = await runtime.run('HTMLTEXT "https://example.test/" "/t.txt" "/l.txt" 76 2\nEND');

  assert.equal(result.ok, true);
  assert.equal(runtime.htmllinks, 2);
  assert.equal(files.read("/l.txt").trimEnd().split("\n").length, 2);
});

test("HTMLOPEN refuses to run while the script holds a file handle", async () => {
  const files = new MemoryFiles({ "/x.txt": "hi" });
  const runtime = runtimeFor(files);
  const result = await runtime.run([
    'FOPEN "/x.txt" read',
    'HTMLOPEN "/t.txt" "-" "https://example.test/"',
    "END"
  ].join("\n"));

  assert.equal(result.ok, false);
  assert.match(String(result.error), /file handle closed/);
});

test("HTTPGETBUF fills the byte buffer and BUFSCAN/BUFTAKE walk it a token at a time", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode("alpha beta gamma").buffer
  });

  const runtime = runtimeFor(new MemoryFiles());
  const result = await runtime.run([
    "BUFNEW 1024",
    'HTTPGETBUF "https://example.test/words"',
    "BUFAT first 0",
    "BUFSUB head 0 5",
    "BUFTAKE word pos 0",
    "BUFTAKE second pos2 6",
    "SET filled $buflen",
    "END"
  ].join("\n"));

  assert.equal(result.ok, true);
  // the buffer is released when the app exits, so its length is captured while running
  assert.equal(runtime.numbers.get("filled"), 16);
  assert.equal(runtime.numbers.get("first"), "a".charCodeAt(0));
  assert.equal(runtime.strings.get("head"), "alpha");
  assert.equal(runtime.strings.get("word"), "alpha");
  assert.equal(runtime.numbers.get("pos"), 5);
  assert.equal(runtime.strings.get("second"), "beta");
  assert.equal(runtime.numbers.get("pos2"), 10);
});

test("BUFWRITE, BUFSAVE and BUFLOAD round-trip through the filesystem", async () => {
  const files = new MemoryFiles();
  const runtime = runtimeFor(files);
  const result = await runtime.run([
    "BUFNEW 64",
    'BUFWRITE 0 "hello"',
    'BUFSAVE "/b.bin"',
    "BUFCLEAR",
    'BUFLOAD "/b.bin"',
    "BUFSUB back 0 5",
    "SET reloaded $buflen",
    "END"
  ].join("\n"));

  assert.equal(result.ok, true);
  assert.equal(files.read("/b.bin"), "hello");
  assert.equal(runtime.strings.get("back"), "hello");
  assert.equal(runtime.numbers.get("reloaded"), 5);
});

test("the rewritten browser fetches a page, pages it, follows a link, and quits", async (t) => {
  const previousFetch = globalThis.fetch;
  const requested = [];
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async url => {
    requested.push(url);
    const body = requested.length === 1
      ? '<h1>Index</h1><p>Go to the <a href="page2.html">second page</a>.</p>'
      : "<h1>Second</h1><p>The end.</p>";
    return { status: 200, ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };

  const answers = ["example.test/start/", "1", "q"];
  const outputs = [];
  const io = {
    output(text) { outputs.push(text); }, clear() {}, status() {}, canvas() {}, endCanvas() {}, waveStop() {},
    input(_prompt, resolve) { resolve(answers.shift()); }
  };
  const runtime = new DappRuntime(io, new MemoryFiles());
  const source = await readFile(new URL("../apps/browse.dapp", import.meta.url), "utf8");
  const result = await runtime.run(source);

  assert.equal(result.ok, true);
  // a bare host typed at the prompt gets a scheme; the link is resolved by the renderer
  assert.equal(requested[0], "http://example.test/start/");
  assert.equal(requested[1], "http://example.test/start/page2.html");
  assert.ok(outputs.some(line => line.includes("Index")));
  assert.ok(outputs.some(line => line.includes("Second")));
  assert.ok(outputs.includes("browse: done"));
});

test("the shipped Reader saves an article, resumes it, and preserves it when refresh fails", async (t) => {
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => {
    fetches += 1;
    if (fetches > 1) {
      return {
        status: 503,
        ok: false,
        arrayBuffer: async () => new TextEncoder().encode("temporarily unavailable").buffer
      };
    }
    const paragraphs = Array.from({ length: 25 }, (_, index) => `<p>Article line ${index + 1}</p>`).join("");
    const body = `<h1>Saved Article</h1>${paragraphs}<a href="/next">Next</a>`;
    return {
      status: 200,
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer
    };
  };

  // Add, attempt a failed refresh, open the intact article, then leave the library.
  const answers = ["a", "https://example.test/article", "Saved Article", "r", "1", "", "1", "q"];
  const outputs = [];
  const files = new MemoryFiles();
  let runtime;
  let articleFrames = 0;
  const io = {
    output(text) { outputs.push(text); }, clear() {}, status() {}, endCanvas() {}, waveStop() {},
    input(_prompt, resolve) { resolve(answers.shift()); },
    canvas(canvas) {
      const heading = canvas.cells[0].map(cell => cell.char).join("");
      if (!heading.includes("Saved Article")) return;
      articleFrames += 1;
      runtime.pushKey({ key: articleFrames === 1 ? "ArrowDown" : "Escape", ctrlKey: false });
    }
  };
  runtime = new DappRuntime(io, files);
  const source = await readFile(new URL("../apps/reader.dapp", import.meta.url), "utf8");
  const result = await runtime.run(source);

  assert.equal(result.ok, true);
  assert.equal(fetches, 2);
  assert.match(files.read("/apps/reader-1-0.txt"), /Article line 25/);
  assert.match(files.read("/apps/reader-1-0.lnk"), /https:\/\/example\.test\/next/);
  assert.equal(files.exists("/apps/reader-1-1.txt"), false);
  assert.equal(files.read("/apps/reader-1.meta"), [
    "Saved Article",
    "https://example.test/article",
    "20",
    "0",
    ""
  ].join("\n"));
  assert.ok(outputs.some(line => line.includes("fetch failed (HTTP 503)")));
  assert.ok(outputs.includes("reader: library closed"));
});
