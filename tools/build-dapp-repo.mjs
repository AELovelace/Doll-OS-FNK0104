#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PACKAGE_HEADER_BYTES = 2048;
const PACKAGE_HEADER_LINES = 32;
const REQUIRED_FIELDS = [
  "dapp-format",
  "id",
  "name",
  "version",
  "boards",
  "runtime",
];
const OPTIONAL_FIELDS = ["author", "summary", "license", "homepage", "source"];
const KNOWN_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const APP_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const RUNTIME_PATTERN = /^>=(\d+\.\d+\.\d+)\s+<(\d+\.\d+\.\d+)$/;

export class RepositoryValidationError extends Error {
  constructor(errors) {
    super(`Repository validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "RepositoryValidationError";
    this.errors = errors;
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error.message}`);
  }
}

function parseStableVersion(value, label = "version") {
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${label}: expected MAJOR.MINOR.PATCH, got ${JSON.stringify(value)}`);
  }
  return match.slice(1, 4).map(Number);
}

function parseAppVersion(value) {
  const match = APP_VERSION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`version: expected Semantic Versioning, got ${JSON.stringify(value)}`);
  }
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ?? "",
  };
}

export function compareVersions(left, right) {
  const a = Array.isArray(left) ? left : parseStableVersion(left);
  const b = Array.isArray(right) ? right : parseStableVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

function compareAppVersions(left, right) {
  const a = parseAppVersion(left);
  const b = parseAppVersion(right);
  const numeric = compareVersions(a.numbers, b.numbers);
  if (numeric !== 0) return numeric;
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const aParts = a.prerelease.split(".");
  const bParts = b.prerelease.split(".");
  const count = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < count; index += 1) {
    if (aParts[index] === undefined) return -1;
    if (bParts[index] === undefined) return 1;
    if (aParts[index] === bParts[index]) continue;
    const aNumeric = /^\d+$/.test(aParts[index]);
    const bNumeric = /^\d+$/.test(bParts[index]);
    if (aNumeric && bNumeric) return Number(aParts[index]) < Number(bParts[index]) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aParts[index].localeCompare(bParts[index], "en");
  }
  return 0;
}

export function parseRuntimeConstraint(value) {
  const match = RUNTIME_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `runtime: expected \">=MIN_VERSION <MAX_EXCLUSIVE_VERSION\", got ${JSON.stringify(value)}`,
    );
  }
  const minimum = parseStableVersion(match[1], "runtime minimum");
  const maximumExclusive = parseStableVersion(match[2], "runtime maximum");
  if (compareVersions(minimum, maximumExclusive) >= 0) {
    throw new Error("runtime: maximum must be greater than minimum");
  }
  return {
    minimum,
    minimumText: match[1],
    maximumExclusive,
    maximumExclusiveText: match[2],
  };
}

function runtimeContains(constraint, version) {
  const parsed = parseStableVersion(version, "board runtime");
  return (
    compareVersions(parsed, constraint.minimum) >= 0 &&
    compareVersions(parsed, constraint.maximumExclusive) < 0
  );
}

function physicalLines(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

export function parsePackageHeader(buffer, sourceLabel = "package") {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    throw new Error(`${sourceLabel}: UTF-8 byte-order marks are not supported`);
  }

  const headerText = buffer.subarray(0, PACKAGE_HEADER_BYTES).toString("utf8");
  const lines = physicalLines(headerText).slice(0, PACKAGE_HEADER_LINES);
  const metadata = {};
  let reachedExecutable = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) {
      const match = /^#\s*@([a-z][a-z0-9-]*)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const [, field, value] = match;
      if (reachedExecutable) {
        throw new Error(`${sourceLabel}: metadata field @${field} appears after executable code`);
      }
      if (Object.hasOwn(metadata, field)) {
        throw new Error(`${sourceLabel}: duplicate metadata field @${field}`);
      }
      if (!KNOWN_FIELDS.has(field)) {
        // Format 1 readers deliberately preserve forward compatibility.
        metadata[field] = value;
        continue;
      }
      metadata[field] = value;
      continue;
    }
    reachedExecutable = true;
    break;
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(metadata, field)) {
      throw new Error(
        `${sourceLabel}: missing @${field} within the first ${PACKAGE_HEADER_LINES} lines and ${PACKAGE_HEADER_BYTES} bytes`,
      );
    }
  }

  for (const [field, value] of Object.entries(metadata)) {
    if (/[\t\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`${sourceLabel}: @${field} contains a control character`);
    }
  }

  if (metadata["dapp-format"] !== "1") {
    throw new Error(`${sourceLabel}: unsupported @dapp-format ${metadata["dapp-format"]}`);
  }
  if (!ID_PATTERN.test(metadata.id)) {
    throw new Error(`${sourceLabel}: invalid @id ${JSON.stringify(metadata.id)}`);
  }
  const nameBytes = Buffer.byteLength(metadata.name, "utf8");
  if (nameBytes < 1 || nameBytes > 48) {
    throw new Error(`${sourceLabel}: @name must contain 1 through 48 UTF-8 bytes`);
  }
  parseAppVersion(metadata.version);

  const boards = metadata.boards.split(",").map((board) => board.trim());
  if (boards.some((board) => !board)) {
    throw new Error(`${sourceLabel}: @boards contains an empty board ID`);
  }
  if (new Set(boards).size !== boards.length) {
    throw new Error(`${sourceLabel}: @boards contains a duplicate board ID`);
  }

  const runtime = parseRuntimeConstraint(metadata.runtime);
  return { metadata, boards: boards.sort(), runtime };
}

function resolveRuntime(compatibility, version, resolving = new Set()) {
  const runtime = compatibility.runtimes?.[version];
  if (!runtime) throw new Error(`compatibility: runtime ${version} is not defined`);
  if (resolving.has(version)) {
    throw new Error(`compatibility: runtime inheritance cycle at ${version}`);
  }
  resolving.add(version);

  let opcodes = new Set();
  let builtins = new Set();
  let syntaxFeatures = new Set();
  if (runtime.extends) {
    const parent = resolveRuntime(compatibility, runtime.extends, resolving);
    opcodes = new Set(parent.opcodes);
    builtins = new Set(parent.builtins);
    syntaxFeatures = new Set(parent.syntaxFeatures);
  }
  for (const opcode of runtime.opcodes ?? []) opcodes.add(opcode);
  for (const builtin of runtime.builtins ?? []) builtins.add(builtin);
  for (const feature of runtime.syntax_features ?? []) syntaxFeatures.add(feature);
  resolving.delete(version);
  return { opcodes, builtins, syntaxFeatures };
}

function buildIntroductions(compatibility) {
  const versions = Object.keys(compatibility.runtimes ?? {}).sort(compareVersions);
  const opcodeVersions = new Map();
  const builtinVersions = new Map();
  const syntaxVersions = new Map();
  for (const version of versions) {
    const runtime = compatibility.runtimes[version];
    for (const opcode of runtime.opcodes ?? []) {
      if (!opcodeVersions.has(opcode)) opcodeVersions.set(opcode, version);
    }
    for (const builtin of runtime.builtins ?? []) {
      if (!builtinVersions.has(builtin)) builtinVersions.set(builtin, version);
    }
    for (const feature of runtime.syntax_features ?? []) {
      if (!syntaxVersions.has(feature)) syntaxVersions.set(feature, version);
    }
  }
  return { opcodeVersions, builtinVersions, syntaxVersions };
}

function analyzeSource(text, knownBuiltins) {
  const lines = physicalLines(text);
  const opcodes = new Set();
  const builtins = new Set();
  const syntaxFeatures = new Set();
  let labels = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (line.startsWith(":")) {
      labels += 1;
      continue;
    }
    const [opcodeToken] = line.split(/\s+/, 1);
    const opcode = opcodeToken.toUpperCase();
    opcodes.add(opcode);
    if (opcode === "LABEL") labels += 1;
    if (/^(IF|IFEQ|IFNE)\b.*\bGOSUB\b/i.test(line)) {
      syntaxFeatures.add("conditional-gosub");
    }
    for (const match of line.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1].toLowerCase();
      if (knownBuiltins.has(name)) builtins.add(name);
    }
  }
  return { lines: lines.length, labels, opcodes, builtins, syntaxFeatures };
}

function highestRequiredRuntime(analysis, introductions) {
  let required = "0.0.0";
  const consider = (version) => {
    if (version && compareVersions(version, required) > 0) required = version;
  };
  for (const opcode of analysis.opcodes) consider(introductions.opcodeVersions.get(opcode));
  for (const builtin of analysis.builtins) consider(introductions.builtinVersions.get(builtin));
  for (const feature of analysis.syntaxFeatures) consider(introductions.syntaxVersions.get(feature));
  return required;
}

function validateCompatibilityShape(compatibility) {
  if (compatibility.package_format !== 1) {
    throw new Error("compatibility: package_format must be 1");
  }
  const runtimeVersions = Object.keys(compatibility.runtimes ?? {});
  const boardEntries = Object.entries(compatibility.boards ?? {});
  if (runtimeVersions.length === 0) throw new Error("compatibility: no runtimes are defined");
  if (boardEntries.length === 0) throw new Error("compatibility: no boards are defined");
  for (const version of runtimeVersions) {
    parseStableVersion(version, "compatibility runtime");
    resolveRuntime(compatibility, version);
  }
  for (const [boardId, board] of boardEntries) {
    if (!ID_PATTERN.test(boardId)) throw new Error(`compatibility: invalid board ID ${boardId}`);
    parseStableVersion(board.runtime, `${boardId} runtime`);
    resolveRuntime(compatibility, board.runtime);
    if (!Number.isInteger(board.limits?.lines) || board.limits.lines <= 0) {
      throw new Error(`compatibility: ${boardId} needs a positive lines limit`);
    }
    if (!Number.isInteger(board.limits?.labels) || board.limits.labels <= 0) {
      throw new Error(`compatibility: ${boardId} needs a positive labels limit`);
    }
  }
}

function validateConfig(config) {
  if (config.repository_format !== 1) throw new Error("config: repository_format must be 1");
  if (!ID_PATTERN.test(config.id ?? "")) throw new Error("config: invalid repository id");
  if (!config.name || typeof config.name !== "string") throw new Error("config: name is required");
  if (!config.catalog || path.basename(config.catalog) !== config.catalog) {
    throw new Error("config: catalog must be a filename");
  }
  if (!Array.isArray(config.package_roots) || config.package_roots.length === 0) {
    throw new Error("config: package_roots must contain at least one directory");
  }
  const canonical = new URL(config.canonical_url);
  if (canonical.protocol !== "https:" || !canonical.pathname.endsWith("/")) {
    throw new Error("config: canonical_url must be an HTTPS URL ending in /");
  }
}

async function findDappFiles(root) {
  const found = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".dapp")) found.push(fullPath);
    }
  }
  await walk(root);
  return found;
}

function artifactFilename(boards, allBoardIds) {
  if (boards.length === 1) return `${boards[0]}.dapp`;
  if (boards.length === allBoardIds.length && boards.every((board) => allBoardIds.includes(board))) {
    return "universal.dapp";
  }
  return `${boards.join("+")}.dapp`;
}

async function validatePackage(filePath, compatibility, introductions, knownBuiltins) {
  const buffer = await readFile(filePath);
  const sourceLabel = path.basename(filePath);
  const parsed = parsePackageHeader(buffer, sourceLabel);
  const { metadata, boards, runtime } = parsed;
  if (`${metadata.id}.dapp` !== path.basename(filePath).toLowerCase()) {
    throw new Error(
      `${sourceLabel}: filename must be ${metadata.id}.dapp to match @id ${metadata.id}`,
    );
  }

  const text = buffer.toString("utf8");
  const analysis = analyzeSource(text, knownBuiltins);
  const unknownOpcodes = [...analysis.opcodes].filter(
    (opcode) => !introductions.opcodeVersions.has(opcode),
  );
  if (unknownOpcodes.length > 0) {
    throw new Error(`${sourceLabel}: unknown opcode(s): ${unknownOpcodes.sort().join(", ")}`);
  }

  const requiredRuntime = highestRequiredRuntime(analysis, introductions);
  if (compareVersions(runtime.minimum, requiredRuntime) < 0) {
    throw new Error(
      `${sourceLabel}: declares runtime ${metadata.runtime}, but source requires >=${requiredRuntime}`,
    );
  }

  for (const boardId of boards) {
    const board = compatibility.boards[boardId];
    if (!board) throw new Error(`${sourceLabel}: unknown board ID ${boardId}`);
    if (!runtimeContains(runtime, board.runtime)) {
      throw new Error(
        `${sourceLabel}: ${boardId} runs AppRunner ${board.runtime}, outside ${metadata.runtime}`,
      );
    }
    const supported = resolveRuntime(compatibility, board.runtime);
    const unsupported = [...analysis.opcodes].filter((opcode) => !supported.opcodes.has(opcode));
    if (unsupported.length > 0) {
      throw new Error(
        `${sourceLabel}: ${boardId} does not support opcode(s): ${unsupported.sort().join(", ")}`,
      );
    }
    if (analysis.lines > board.limits.lines) {
      throw new Error(
        `${sourceLabel}: ${analysis.lines} physical lines exceed ${boardId} limit ${board.limits.lines}`,
      );
    }
    if (analysis.labels > board.limits.labels) {
      throw new Error(
        `${sourceLabel}: ${analysis.labels} labels exceed ${boardId} limit ${board.limits.labels}`,
      );
    }
  }

  return {
    filePath,
    buffer,
    metadata,
    boards,
    runtime,
    analysis,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function makeCatalogRecord(pkg, artifactUrl) {
  const record = {
    package_format: Number(pkg.metadata["dapp-format"]),
    id: pkg.metadata.id,
    name: pkg.metadata.name,
    summary: pkg.metadata.summary ?? "",
    version: pkg.metadata.version,
    boards: pkg.boards,
    runtime_min: pkg.runtime.minimumText,
    runtime_max_exclusive: pkg.runtime.maximumExclusiveText,
    size: pkg.buffer.length,
    sha256: pkg.sha256,
    url: artifactUrl,
  };
  for (const field of ["author", "license", "homepage", "source"]) {
    if (pkg.metadata[field]) record[field] = pkg.metadata[field];
  }
  return record;
}

function compareCatalogRecords(left, right) {
  const id = left.id.localeCompare(right.id, "en");
  if (id !== 0) return id;
  const version = compareAppVersions(left.version, right.version);
  if (version !== 0) return version;
  return left.boards.join(",").localeCompare(right.boards.join(","), "en");
}

function assertSafeOutput(outputPath, configPath) {
  const resolved = path.resolve(outputPath);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || resolved === path.dirname(path.resolve(configPath))) {
    throw new Error(`refusing unsafe output directory ${resolved}`);
  }
}

export async function buildRepository({
  configPath = path.resolve("dapper/repository.config.json"),
  outputPath,
  checkOnly = false,
} = {}) {
  const resolvedConfig = path.resolve(configPath);
  const configDirectory = path.dirname(resolvedConfig);
  const config = parseJson(await readFile(resolvedConfig, "utf8"), resolvedConfig);
  validateConfig(config);

  const compatibilityPath = path.resolve(configDirectory, config.compatibility);
  const compatibility = parseJson(
    await readFile(compatibilityPath, "utf8"),
    compatibilityPath,
  );
  validateCompatibilityShape(compatibility);
  const introductions = buildIntroductions(compatibility);
  const knownBuiltins = new Set(introductions.builtinVersions.keys());
  const allBoardIds = Object.keys(compatibility.boards).sort();

  const files = [];
  for (const configuredRoot of config.package_roots) {
    const packageRoot = path.resolve(configDirectory, configuredRoot);
    files.push(...(await findDappFiles(packageRoot)));
  }
  files.sort((a, b) => a.localeCompare(b, "en"));
  if (files.length === 0) throw new Error("repository contains no .dapp source files");

  const packages = [];
  const errors = [];
  for (const filePath of files) {
    try {
      packages.push(await validatePackage(filePath, compatibility, introductions, knownBuiltins));
    } catch (error) {
      errors.push(error.message);
    }
  }

  const occupiedBoards = new Map();
  const occupiedUrls = new Map();
  const artifacts = [];
  for (const pkg of packages) {
    for (const boardId of pkg.boards) {
      const key = `${pkg.metadata.id}@${pkg.metadata.version}:${boardId}`;
      if (occupiedBoards.has(key)) {
        errors.push(
          `${path.basename(pkg.filePath)} overlaps ${path.basename(occupiedBoards.get(key))} for ${key}`,
        );
      } else {
        occupiedBoards.set(key, pkg.filePath);
      }
    }
    const filename = artifactFilename(pkg.boards, allBoardIds);
    const artifactUrl = ["packages", pkg.metadata.id, pkg.metadata.version, filename].join("/");
    if (occupiedUrls.has(artifactUrl)) {
      errors.push(
        `${path.basename(pkg.filePath)} and ${path.basename(occupiedUrls.get(artifactUrl))} produce ${artifactUrl}`,
      );
    } else {
      occupiedUrls.set(artifactUrl, pkg.filePath);
    }
    artifacts.push({ pkg, artifactUrl, record: makeCatalogRecord(pkg, artifactUrl) });
  }

  if (errors.length > 0) throw new RepositoryValidationError(errors);
  artifacts.sort((a, b) => compareCatalogRecords(a.record, b.record));

  const repo = {
    repository_format: config.repository_format,
    id: config.id,
    name: config.name,
    canonical_url: config.canonical_url,
    catalog: config.catalog,
  };
  const catalogText = `${artifacts.map(({ record }) => JSON.stringify(record)).join("\n")}\n`;
  const resolvedOutput = path.resolve(outputPath ?? path.join(configDirectory, "dist"));

  if (!checkOnly) {
    assertSafeOutput(resolvedOutput, resolvedConfig);
    const staging = `${resolvedOutput}.tmp-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "repo.json"), `${JSON.stringify(repo, null, 2)}\n`, "utf8");
    await writeFile(path.join(staging, config.catalog), catalogText, "utf8");
    for (const artifact of artifacts) {
      const destination = path.join(staging, ...artifact.artifactUrl.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(artifact.pkg.filePath, destination);
    }
    await rm(resolvedOutput, { recursive: true, force: true });
    await rename(staging, resolvedOutput);
  }

  return {
    repo,
    records: artifacts.map(({ record }) => record),
    packages,
    outputPath: resolvedOutput,
    checkOnly,
  };
}

function usage() {
  return [
    "Usage: node tools/build-dapp-repo.mjs [options]",
    "",
    "Options:",
    "  --check          validate without writing dapper/dist",
    "  --config <path>  repository config (default dapper/repository.config.json)",
    "  --output <path>  generated output directory",
    "  --help            show this help",
  ].join("\n");
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") options.checkOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--config" || arg === "--output") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      index += 1;
      if (arg === "--config") options.configPath = value;
      else options.outputPath = value;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const result = await buildRepository(options);
    const action = result.checkOnly ? "Validated" : "Built";
    process.stdout.write(
      `${action} ${result.records.length} package artifact(s) for ${result.repo.canonical_url}\n`,
    );
    if (!result.checkOnly) process.stdout.write(`Output: ${result.outputPath}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
