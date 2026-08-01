export const DAPPER_REPOSITORY_URL = "https://sadgirlsclub.wtf/dapper/repo.json";
export const DAPPER_REPOSITORY_BASE_URL = "https://sadgirlsclub.wtf/dapper/";

const LIMITS = Object.freeze({ repo: 4096, catalog: 128 * 1024, package: 256 * 1024, line: 4096, records: 512 });
const RUNTIME_VERSION = "1.5.0";
const BOARD_ID = "fnk0104";

function parseVersion(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error("invalid package version");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function runtimeCompatible(record) {
  return parseVersion(record.runtime_min) && parseVersion(record.runtime_max_exclusive)
    && compareVersions(RUNTIME_VERSION, record.runtime_min) >= 0
    && compareVersions(RUNTIME_VERSION, record.runtime_max_exclusive) < 0;
}

function safeArtifactUrl(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.split("/").includes("..")) return null;
  const resolved = new URL(value, DAPPER_REPOSITORY_BASE_URL);
  const base = new URL(DAPPER_REPOSITORY_BASE_URL);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) return null;
  return resolved;
}

function validateRecord(record) {
  if (!record || record.package_format !== 1 || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(record.id)
      || typeof record.name !== "string" || !parseVersion(record.version)
      || !Array.isArray(record.boards) || !record.boards.includes(BOARD_ID)
      || !runtimeCompatible(record) || !Number.isInteger(record.size) || record.size < 1 || record.size > LIMITS.package
      || !/^[a-f0-9]{64}$/.test(record.sha256) || !safeArtifactUrl(record.url)) return false;
  return true;
}

function packageMetadata(source) {
  const fields = {};
  for (const line of String(source).split(/\r?\n/).slice(0, 32)) {
    const match = line.match(/^#\s+@([a-z-]+)\s+(.+)$/i);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  return fields;
}

async function sha256(bytes, cryptoImpl) {
  if (!cryptoImpl?.subtle) throw new Error("SHA-256 is unavailable in this browser");
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export class DapperClient {
  constructor({ fetchImpl, cryptoImpl = globalThis.crypto } = {}) {
    // Firefox's Window.fetch checks its receiver. Keeping `fetch` directly on
    // this client and invoking it as a method binds `this` to DapperClient,
    // which Firefox rejects as an illegal invocation.
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.cryptoImpl = cryptoImpl;
    this.records = null;
  }

  async fetchBytes(url, maximum) {
    const requested = new URL(url);
    const response = await this.fetchImpl(requested.href, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.1" }
    });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    const finalUrl = new URL(response.url || requested.href);
    if (finalUrl.origin !== requested.origin) throw new Error("cross-origin redirect refused");
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (declared > maximum) throw new Error("download exceeds size limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) throw new Error("download exceeds size limit");
    return bytes;
  }

  async refresh(force = false) {
    if (this.records && !force) return this.records;
    const decoder = new TextDecoder();
    const repoBytes = await this.fetchBytes(DAPPER_REPOSITORY_URL, LIMITS.repo);
    const repo = JSON.parse(decoder.decode(repoBytes));
    if (repo.repository_format !== 1 || repo.id !== "sadgirlsclub"
        || repo.canonical_url !== DAPPER_REPOSITORY_BASE_URL || repo.catalog !== "catalog-v1.ndjson") {
      throw new Error("repository identity check failed");
    }

    const catalogUrl = new URL(repo.catalog, repo.canonical_url);
    const catalogText = decoder.decode(await this.fetchBytes(catalogUrl, LIMITS.catalog));
    const lines = catalogText.split(/\r?\n/).filter(Boolean);
    if (lines.length > LIMITS.records || lines.some(line => line.length > LIMITS.line)) throw new Error("catalog exceeds limits");
    const records = [];
    for (const line of lines) {
      const record = JSON.parse(line);
      if (validateRecord(record)) records.push(record);
    }
    this.records = records;
    return records;
  }

  async available() {
    const records = await this.refresh();
    const newest = new Map();
    for (const record of records) {
      const current = newest.get(record.id);
      if (!current || compareVersions(record.version, current.version) > 0) newest.set(record.id, record);
    }
    return [...newest.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async search(query = "") {
    const needle = String(query).toLowerCase();
    return (await this.available()).filter(record => `${record.id} ${record.name} ${record.summary || ""}`.toLowerCase().includes(needle));
  }

  async select(spec) {
    const match = String(spec).match(/^([a-z0-9][a-z0-9-]{0,31})(?:@(\d+\.\d+\.\d+))?$/);
    if (!match) throw new Error(`invalid package: ${spec}`);
    const [, id, exactVersion] = match;
    const matches = (await this.refresh()).filter(record => record.id === id && (!exactVersion || record.version === exactVersion));
    if (!matches.length) throw new Error(`compatible package not found: ${spec}`);
    return matches.sort((a, b) => compareVersions(b.version, a.version))[0];
  }

  async install(spec, fileSystem, root = "/apps") {
    if (root !== "/apps" && root !== "/sd/apps") throw new Error("unsupported install location");
    const record = await this.select(spec);
    const artifactUrl = safeArtifactUrl(record.url);
    const bytes = await this.fetchBytes(artifactUrl, LIMITS.package);
    if (bytes.byteLength !== record.size) throw new Error("downloaded size does not match catalog");
    if (await sha256(bytes, this.cryptoImpl) !== record.sha256) throw new Error("downloaded SHA-256 does not match catalog");
    const source = new TextDecoder().decode(bytes);
    const metadata = packageMetadata(source);
    const boards = (metadata.boards || "").split(",").map(value => value.trim());
    if (metadata["dapp-format"] !== "1" || metadata.id !== record.id || metadata.version !== record.version
        || !boards.includes(BOARD_ID)
        || metadata.runtime !== `>=${record.runtime_min} <${record.runtime_max_exclusive}`) {
      throw new Error("downloaded package metadata does not match catalog");
    }
    const path = `${root}/${record.id}.dapp`;
    if (!fileSystem.write(path, source)) throw new Error(`could not write ${path}`);
    return { record, path };
  }
}
