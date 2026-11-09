// The Builds side of the package format: path rules, payload inventory, file
// digests and manifest checks for the packages Builds writes. The app reads the
// same documented format with its own reader. Builds lifts every size guard.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LIMITS = Object.freeze({ manifestBytes: Infinity, files: Infinity, fileBytes: Infinity, bytes: Infinity });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const SHA = /^[a-f0-9]{64}$/;

function relativeFile(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f]/.test(value) ||
      path.posix.isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe bundled runtime file path.");
  return value;
}

function realDirectory(directory, { create = false, verifiedDirectories } = {}) {
  const absolute = path.resolve(directory);
  if (verifiedDirectories?.has(absolute)) return true;
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (verifiedDirectories?.has(current)) continue;
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return false;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    // macOS presents its system temporary directories through these aliases.
    if (process.platform === "darwin" && ["/tmp", "/var"].includes(current) && stat.isSymbolicLink()) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Bundled runtime directories cannot use symlinks.");
    verifiedDirectories?.add(current);
  }
  return true;
}

/** A regular file's bytes, size, SHA-256 and mode, read without following links. */
function readRegular(file, maximum, { digestOnly = false, directories } = {}) {
  if (!realDirectory(path.dirname(file), { verifiedDirectories: directories })) throw new Error("Bundled runtime directory is missing.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Bundled runtime file is not regular or exceeds its limit.");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error("Bundled runtime changed while being read.");
    const result = { size: bytes.length, sha256: digest(bytes), mode: stat.mode & 0o777 };
    return digestOnly ? result : { bytes, ...result };
  } finally { fs.closeSync(fd); }
}

const hashFile = file => digest(fs.readFileSync(file));

function fileInventory(root, { allowedAliases = new Set(), directories } = {}) {
  const files = [];
  function walk(relative, depth) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relativeFile(path.posix.join(relative, entry.name));
      if (entry.isSymbolicLink()) {
        if (!allowedAliases.has(name)) throw new Error("Bundled runtime packages cannot contain symlinks.");
        files.push(name);
      } else if (entry.isDirectory()) walk(name, depth + 1);
      else if (entry.isFile()) files.push(name);
      else throw new Error("Bundled runtimes may contain only regular files and directories.");
      if (files.length > LIMITS.files) throw new Error("Bundled runtime has too many files.");
    }
  }
  if (!realDirectory(root, { verifiedDirectories: directories })) throw new Error("Bundled runtime payload is missing.");
  walk("", 0);
  return files.sort();
}

function localMachO(file){return Boolean(file?.architectures?.length && file.format!=='pe');}

function versionAtLeast(actual, minimum) {
  const parts = value => String(value ?? "").split(".").map(part => Number(/^\d+/.exec(part)?.[0] ?? NaN));
  const a = parts(actual), b = parts(minimum);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return difference > 0;
  }
  return true;
}

function validateManifest(manifest, { managerId, version, upstreamRevision, arch, checkSourceIdentity = true } = {}) {
  if (manifest?.schemaVersion !== 1 || !/^[a-z0-9-]+$/.test(manifest.managerId || "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.version || "") || checkSourceIdentity && !/^[a-f0-9]{40}$/.test(manifest.upstreamRevision || "") ||
      manifest.platform !== "darwin" || !["arm64", "x64", "universal"].includes(manifest.arch) ||
      !/^\d+\.\d+(?:\.\d+)?$/.test(manifest.minimumMacOS || "") ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > LIMITS.files ||
      checkSourceIdentity && manifest.provenance?.sourceRevision !== manifest.upstreamRevision || !Array.isArray(manifest.dependencies)) throw new Error("Invalid bundled runtime manifest.");
  if (managerId && manifest.managerId !== managerId || version && manifest.version !== version ||
      checkSourceIdentity && upstreamRevision && manifest.upstreamRevision !== upstreamRevision || arch && manifest.arch !== arch) throw new Error("Bundled runtime version, source pin or architecture differs from the selected catalog entry.");
  relativeFile(manifest.executableRelative);
  const names = new Set(), filesByPath = new Map(), directories = new Set();
  let total = 0;
  for (const file of manifest.files) {
    relativeFile(file.path);
    const key = file.path.normalize("NFC").toLowerCase();
    if (names.has(key) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes ||
        !SHA.test(file.sha256 || "") || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 ||
        file.format !== undefined && (!["mach-o", "pe"].includes(file.format) || !file.architectures) ||
        file.architectures && (!Array.isArray(file.architectures) || !file.architectures.length || file.architectures.some(value => !(file.format === "pe" ? ["arm64", "x86_64", "x86"] : ["arm64", "x86_64"]).includes(value)))) throw new Error("Invalid bundled runtime file record.");
    names.add(key);
    filesByPath.set(file.path, file);
    for (let directory = path.posix.dirname(file.path); directory !== "."; directory = path.posix.dirname(directory)) directories.add(directory);
    total += file.size;
    if (total > LIMITS.bytes) throw new Error("Bundled runtime exceeds its size limit.");
  }
  const executable = filesByPath.get(manifest.executableRelative);
  const requiredArchitectures = manifest.arch === "universal" ? ["arm64", "x86_64"] : [manifest.arch === "x64" ? "x86_64" : "arm64"];
  if (!executable || !(executable.mode & 0o111) || !requiredArchitectures.every(architecture => executable.architectures?.includes(architecture))) throw new Error("Bundled runtime has no matching executable.");
  for (const dependency of manifest.dependencies) {
    if (!dependency || !filesByPath.has(relativeFile(dependency.file)) ||
        !Array.isArray(dependency.links) || dependency.links.some(link => typeof link !== "string" || !(
          link.startsWith("/usr/lib/") || link.startsWith("/System/Library/") || link.startsWith("@loader_path/")))) throw new Error("Bundled runtime dependency closure is invalid.");
    for (const link of dependency.links.filter(link => link.startsWith("@loader_path/"))) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(dependency.file), link.slice("@loader_path/".length)));
      relativeFile(resolved);
      if (!filesByPath.has(resolved)) throw new Error("Bundled runtime dependency is missing from its package.");
    }
  }
  for (const [key, value] of Object.entries(manifest.environmentRelative || {})) {
    if (!["PYTHONHOME", "PYTHONPATH"].includes(key) || !directories.has(relativeFile(value))) throw new Error("Bundled runtime environment directory is invalid.");
  }
  for (const [key, value] of Object.entries(manifest.runtimeFiles || {})) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,50}$/.test(key) || !filesByPath.has(relativeFile(value))) throw new Error("Bundled runtime asset file is invalid.");
  }
  return manifest;
}

// Runtime use records source bookkeeping; publication keeps validateManifest's
// exact source checks. Executable layout and payload integrity remain shared.

const CPU_NAMES = new Map([[0x01000007, "x86_64"], [0x0100000c, "arm64"]]);

function readAt(fd, size, offset) {
  const data = Buffer.alloc(size);
  if (fs.readSync(fd, data, 0, size, offset) !== size) throw new Error("Truncated Mach-O runtime.");
  return data;
}

function readExecutableHeader(fd, offset, size, allowLibrary) {
  if (size < 32) throw new Error("Truncated Mach-O runtime.");
  const data = readAt(fd, 32, offset);
  const magic = data.readUInt32BE(0);
  const little = magic === 0xcffaedfe;
  if (!little && magic !== 0xfeedfacf) throw new Error("Runtime must be a 64-bit macOS Mach-O executable.");
  const read = position => little ? data.readUInt32LE(position) : data.readUInt32BE(position);
  if (read(12) !== 2 && !(allowLibrary && [6, 8].includes(read(12)))) throw new Error("Mach-O runtime is not an executable.");
  const architecture = CPU_NAMES.get(read(4));
  if (!architecture) throw new Error("Runtime uses an unsupported macOS CPU architecture.");
  if (read(20) > size - 32) throw new Error("Truncated Mach-O load commands.");
  return { cpu: read(4), architecture };
}

// Parse bounded headers without invoking file/lipo or executing the selected file.
function readMachOArchitectures(executablePath, { allowLibrary = false } = {}) {
  const stat = fs.statSync(executablePath);
  if (!stat.isFile() || stat.size < 32) throw new Error("Runtime must be a macOS Mach-O executable.");
  const fd = fs.openSync(executablePath, "r");
  try {
    const header = readAt(fd, 8, 0);
    const magic = header.readUInt32BE(0);
    const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
    const fat32 = magic === 0xcafebabe || magic === 0xbebafeca;
    if (!fat64 && !fat32) return [readExecutableHeader(fd, 0, stat.size, allowLibrary).architecture];
    const little = magic === 0xbfbafeca || magic === 0xbebafeca;
    const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
    const stride = fat64 ? 32 : 20;
    if (count < 1 || count > 32 || 8 + count * stride > stat.size) throw new Error("Invalid universal Mach-O header.");
    const table = readAt(fd, count * stride, 8);
    const architectures = [];
    for (let i = 0; i < count; i += 1) {
      const start = i * stride;
      const read32 = position => little ? table.readUInt32LE(start + position) : table.readUInt32BE(start + position);
      const read64 = position => Number(little ? table.readBigUInt64LE(start + position) : table.readBigUInt64BE(start + position));
      const offset = fat64 ? read64(8) : read32(8);
      const size = fat64 ? read64(16) : read32(12);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 8 + count * stride || size < 32 || offset > stat.size - size) {
        throw new Error("Invalid universal Mach-O slice.");
      }
      const slice = readExecutableHeader(fd, offset, size, allowLibrary);
      if (slice.cpu !== read32(0)) throw new Error("Universal Mach-O slice architecture mismatch.");
      architectures.push(slice.architecture);
    }
    return Array.from(new Set(architectures));
  } finally {
    fs.closeSync(fd);
  }
}

/** A payload matches its declaration: the same entries, and each stored file's size, mode and digest. */
function verifyPayload(root, declaration) {
  const aliases = Object.keys(declaration.aliases?.files || {}), files = declaration.files || [];
  const actual = fileInventory(root, { allowedAliases: new Set(aliases) });
  if (JSON.stringify(actual) !== JSON.stringify([...files.map(file => file.path), ...aliases].sort())) throw new Error("Bundled runtime file inventory differs from its manifest.");
  for (const file of files) {
    const stored = readRegular(path.join(root, file.path), undefined, { digestOnly: true });
    if (stored.size !== file.size || stored.sha256 !== file.sha256 || stored.mode !== file.mode) throw new Error(`Bundled runtime checksum or permissions changed: ${file.path}`);
  }
  return true;
}

module.exports = { readMachOArchitectures, verifyPayload, LIMITS, digest, relativeFile, realDirectory, readRegular, hashFile, fileInventory, localMachO, versionAtLeast, validateManifest };
