import { WEB_RUNTIME } from "./runtime-config.js";

export const DAPPER_REPOSITORY_URL = "https://sadgirlsclub.wtf/dapper/repo.json";
export const DAPPER_REPOSITORY_BASE_URL = "https://sadgirlsclub.wtf/dapper/";
export const DAPPER_INSTALLED_PATH = "/.dapper/installed.json";

const LIMITS = Object.freeze({ repo: 4096, catalog: 128 * 1024, package: 256 * 1024, line: 4096, records: 512 });
const RUNTIME_VERSION = WEB_RUNTIME.appRunnerVersion;
const BOARD_ID = WEB_RUNTIME.boardId;
const MAX_INSTALLED = 32;

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

function blankRegistry() {
  return { registry_format: 1, repository: "sadgirlsclub", packages: {} };
}

function loadRegistry(fileSystem) {
  const source = fileSystem.read(DAPPER_INSTALLED_PATH);
  if (source === null) return blankRegistry();
  try {
    const registry = JSON.parse(source);
    if (registry?.registry_format !== 1 || registry.repository !== "sadgirlsclub"
        || !registry.packages || typeof registry.packages !== "object" || Array.isArray(registry.packages)) throw new Error();
    const entries = Object.entries(registry.packages);
    if (entries.length > MAX_INSTALLED) throw new Error();
    for (const [id, installed] of entries) {
      const ownedPaths = [`/apps/${id}.dapp`, `/sd/apps/${id}.dapp`];
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || installed?.id !== id
          || installed.repository !== "sadgirlsclub" || !ownedPaths.includes(installed.path)
          || !parseVersion(installed.version) || !/^[a-f0-9]{64}$/.test(installed.sha256)) throw new Error();
    }
    return registry;
  } catch {
    throw new Error("installed-package registry is corrupt; run dapper doctor");
  }
}

function saveRegistry(fileSystem, registry) {
  if (!fileSystem.exists("/.dapper") && !fileSystem.mkdir("/.dapper")) throw new Error("cannot create /.dapper");
  if (!fileSystem.write(DAPPER_INSTALLED_PATH, `${JSON.stringify(registry, null, 2)}\n`)) {
    throw new Error("cannot update installed-package registry");
  }
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

  installed(fileSystem) {
    return Object.values(loadRegistry(fileSystem).packages).sort((a, b) => a.id.localeCompare(b.id));
  }

  async verifiedPackage(spec) {
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
    return { record, source };
  }

  async install(spec, fileSystem, root = "/apps", { force = false } = {}) {
    if (root !== "/apps" && root !== "/sd/apps") throw new Error("unsupported install location");
    const { record, source } = await this.verifiedPackage(spec);
    const path = `${root}/${record.id}.dapp`;
    const registry = loadRegistry(fileSystem);
    const managed = Object.hasOwn(registry.packages, record.id) ? registry.packages[record.id] : null;
    if (fileSystem.exists(path) && (!managed || managed.path !== path) && !force) {
      throw new Error(`${path} is unmanaged; use --force to take ownership`);
    }
    if (!managed && Object.keys(registry.packages).length >= MAX_INSTALLED) throw new Error("installed-package registry is full");
    if (managed?.version === record.version && managed.sha256 === record.sha256
        && managed.path === path && fileSystem.read(path) === source) return { record, path, current: true };

    const snapshot = fileSystem.snapshot();
    try {
      if (!fileSystem.write(path, source)) throw new Error(`could not write ${path}`);
      registry.packages[record.id] = {
        repository: "sadgirlsclub", package_format: record.package_format,
        id: record.id, name: record.name, summary: record.summary || "", version: record.version,
        runtime_min: record.runtime_min, runtime_max_exclusive: record.runtime_max_exclusive,
        sha256: record.sha256, size: record.size, url: record.url, path
      };
      saveRegistry(fileSystem, registry);
      if (managed?.path && managed.path !== path) fileSystem.delete(managed.path);
    } catch (error) {
      fileSystem.restore(snapshot);
      throw error;
    }
    return { record, path };
  }

  async update(id, fileSystem) {
    await this.refresh(true);
    const registry = loadRegistry(fileSystem);
    const targets = id && Object.hasOwn(registry.packages, id) ? [registry.packages[id]] : id ? [] : Object.values(registry.packages);
    if (id && !targets.length) throw new Error(`not installed: ${id}`);
    const results = [];
    for (const installed of targets) {
      const available = await this.select(installed.id);
      if (compareVersions(available.version, installed.version) <= 0) {
        results.push({ id: installed.id, version: installed.version, current: true, path: installed.path });
      } else {
        const root = installed.path.startsWith("/sd/apps/") ? "/sd/apps" : "/apps";
        const result = await this.install(installed.id, fileSystem, root);
        results.push({ id: result.record.id, version: result.record.version, current: false, path: result.path });
      }
    }
    return results;
  }

  remove(id, fileSystem) {
    const registry = loadRegistry(fileSystem);
    const installed = Object.hasOwn(registry.packages, id) ? registry.packages[id] : null;
    if (!installed) return null;
    const snapshot = fileSystem.snapshot();
    try {
      if (fileSystem.exists(installed.path) && !fileSystem.delete(installed.path)) throw new Error(`could not remove ${installed.path}`);
      delete registry.packages[id];
      saveRegistry(fileSystem, registry);
      return installed;
    } catch (error) {
      fileSystem.restore(snapshot);
      throw error;
    }
  }

  async doctor(fileSystem) {
    const issues = [];
    let registry;
    try { registry = loadRegistry(fileSystem); }
    catch (error) { return { ok: false, count: 0, issues: [error.message] }; }
    const packages = Object.values(registry.packages);
    for (const installed of packages) {
      if (!installed?.id || !installed.path || !["/apps/", "/sd/apps/"].some(root => installed.path.startsWith(root))) {
        issues.push(`invalid registry entry: ${installed?.id || "unknown"}`);
        continue;
      }
      const source = fileSystem.read(installed.path);
      if (source === null) {
        issues.push(`${installed.id}: managed file is missing`);
        continue;
      }
      const digest = await sha256(new TextEncoder().encode(source), this.cryptoImpl);
      if (digest !== installed.sha256) issues.push(`${installed.id}: installed file hash does not match registry`);
    }
    return { ok: issues.length === 0, count: packages.length, issues };
  }
}
