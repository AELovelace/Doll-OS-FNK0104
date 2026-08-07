import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";

import { DAPPER_INSTALLED_PATH, DAPPER_REPOSITORY_BASE_URL, DAPPER_REPOSITORY_URL, DapperClient } from "./dapper-client.js";
import { VirtualFileSystem } from "./emulator-core.js";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function repositoryFixture({ hashOverride } = {}) {
  const source = [
    "# @dapp-format 1",
    "# @id download",
    "# @name Download",
    "# @version 1.2.0",
    "# @boards fnk0104",
    "# @runtime >=1.4.0 <2.0.0",
    "# @summary fetched, not burned in",
    "PRINT downloaded",
    "END"
  ].join("\n");
  const bytes = new TextEncoder().encode(source);
  const record = {
    package_format: 1,
    id: "download",
    name: "Download",
    summary: "fetched, not burned in",
    version: "1.2.0",
    boards: ["fnk0104"],
    runtime_min: "1.4.0",
    runtime_max_exclusive: "2.0.0",
    size: bytes.byteLength,
    sha256: hashOverride || createHash("sha256").update(bytes).digest("hex"),
    url: "packages/download/1.2.0/fnk0104.dapp"
  };
  const repo = JSON.stringify({
    repository_format: 1,
    id: "sadgirlsclub",
    name: "Sad Girls Club DAPP Repository",
    canonical_url: DAPPER_REPOSITORY_BASE_URL,
    catalog: "catalog-v1.ndjson"
  });
  const catalog = `${JSON.stringify(record)}\n`;
  return { source, bytes, record, repo, catalog };
}

function clientFor(fixture, requests = []) {
  const bodies = new Map([
    [DAPPER_REPOSITORY_URL, fixture.repo],
    [`${DAPPER_REPOSITORY_BASE_URL}catalog-v1.ndjson`, fixture.catalog],
    [`${DAPPER_REPOSITORY_BASE_URL}${fixture.record.url}`, fixture.bytes]
  ]);
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (!bodies.has(url)) return new Response("missing", { status: 404 });
    return new Response(bodies.get(url), { status: 200 });
  };
  return new DapperClient({ fetchImpl, cryptoImpl: webcrypto });
}

test("Dapper downloads and verifies a compatible FNK0104 package", async () => {
  const fixture = repositoryFixture();
  const requests = [];
  const client = clientFor(fixture, requests);
  const fileSystem = new VirtualFileSystem({ storage: new MemoryStorage() });
  const found = await client.search("down");
  assert.equal(found.length, 1);
  const installed = await client.install("download", fileSystem);
  assert.equal(installed.path, "/apps/download.dapp");
  assert.equal(fileSystem.read(installed.path), fixture.source);
  assert.match(fileSystem.read(DAPPER_INSTALLED_PATH), /"download"/);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.options.credentials === "omit"));
  assert.ok(requests.every(request => request.options.referrerPolicy === "no-referrer"));
});

test("Dapper keeps the full catalog count while exposing only compatible packages", async () => {
  const fixture = repositoryFixture();
  const cardputer = {
    ...fixture.record,
    id: "cardputer-only",
    name: "Cardputer Only",
    boards: ["m5cardputer"],
    url: "packages/cardputer-only/1.2.0/m5cardputer.dapp"
  };
  const future = {
    ...fixture.record,
    id: "future-app",
    name: "Future App",
    runtime_min: "9.9.0",   //deliberately past any real release, so this stays "future"
    url: "packages/future-app/1.2.0/fnk0104.dapp"
  };
  fixture.catalog = `${[fixture.record, cardputer, future].map(record => JSON.stringify(record)).join("\n")}\n`;
  const client = clientFor(fixture);

  assert.equal((await client.refresh()).length, 3);
  assert.deepEqual((await client.available()).map(record => record.id), ["download"]);
  await assert.rejects(() => client.select("cardputer-only"), /not published for fnk0104/);
  await assert.rejects(() => client.select("future-app"), /requires AppRunner >=9\.9\.0 <2\.0\.0/);
});

test("Dapper owns, diagnoses, and removes only registry-managed packages", async () => {
  const fixture = repositoryFixture();
  const client = clientFor(fixture);
  const fileSystem = new VirtualFileSystem({ storage: new MemoryStorage() });
  fileSystem.write("/apps/download.dapp", "unmanaged");
  await assert.rejects(() => client.install("download", fileSystem), /unmanaged/);
  await client.install("download", fileSystem, "/apps", { force: true });
  assert.equal((await client.doctor(fileSystem)).ok, true);
  fileSystem.write("/apps/download.dapp", "tampered");
  assert.match((await client.doctor(fileSystem)).issues[0], /hash/);
  const removed = client.remove("download", fileSystem);
  assert.equal(removed.id, "download");
  assert.equal(fileSystem.exists("/apps/download.dapp"), false);
  assert.equal(client.installed(fileSystem).length, 0);

  fileSystem.write("/apps/victim.dapp", "keep me");
  fileSystem.write(DAPPER_INSTALLED_PATH, JSON.stringify({
    registry_format: 1,
    repository: "sadgirlsclub",
    packages: { download: { repository: "sadgirlsclub", id: "download", version: "1.2.0", sha256: fixture.record.sha256, path: "/apps/victim.dapp" } }
  }));
  assert.throws(() => client.remove("download", fileSystem), /registry is corrupt/);
  assert.equal(fileSystem.read("/apps/victim.dapp"), "keep me");
});

test("Dapper refuses an artifact that does not match the catalog hash", async () => {
  const fixture = repositoryFixture({ hashOverride: "0".repeat(64) });
  const client = clientFor(fixture);
  const fileSystem = new VirtualFileSystem({ storage: new MemoryStorage() });
  await assert.rejects(() => client.install("download", fileSystem), /SHA-256/);
  assert.equal(fileSystem.exists("/apps/download.dapp"), false);
});

test("Dapper preserves the browser receiver when using window.fetch", async () => {
  const originalFetch = globalThis.fetch;
  let receiver;
  globalThis.fetch = function () {
    receiver = this;
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  try {
    const client = new DapperClient({ cryptoImpl: webcrypto });
    const bytes = await client.fetchBytes(DAPPER_REPOSITORY_URL, 32);
    assert.equal(new TextDecoder().decode(bytes), "ok");
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
