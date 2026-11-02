const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../../shared/runtime/local-native");

function snapshotPrefix(prefix, { readRoots = [] } = {}) {
  if (!path.isAbsolute(prefix || "") || !fs.lstatSync(prefix).isDirectory()) throw new Error("Dependency prefixes must be absolute directories.");
  const root = fs.realpathSync(prefix), allowed = [root, ...readRoots.map(value => fs.realpathSync(value))], files = [], tree = crypto.createHash("sha256");
  let bytes = 0;
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), item = path.posix.join(relative, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { visit(file, item); continue; }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Dependency prefix contains an unsupported file.");
      const resolved = fs.realpathSync(file);
      if (!allowed.some(value => resolved.startsWith(value + path.sep)) || !fs.statSync(resolved).isFile()) throw new Error("Dependency links must stay inside their declared inputs.");
      const size = fs.statSync(resolved).size;
      bytes += size;
      if (files.length >= 8000 || bytes > 256 * 1024 * 1024) throw new Error("Dependency inventory exceeds its bounds.");
      const row = { path: item, sha256: Native.hashFile(resolved), size, mode: stat.mode & 0o777,
        ...(stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : {}) };
      files.push(row); tree.update(JSON.stringify(row) + "\n");
    }
  }
  visit(root);
  return { prefix: root, sha256: tree.digest("hex"), files, bytes };
}

function linkPrefix(inputPrefix, outputPrefix) {
  const original = fs.realpathSync(inputPrefix), output = fs.realpathSync(outputPrefix);
  if (output === original || output.startsWith(original + path.sep) || original.startsWith(output + path.sep)) throw new Error("Dependency outputs must be separate from their inputs.");
  function visit(directory, relative) {
    const destination = path.join(output, relative);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(directory).sort()) {
      const source = path.join(directory, name), target = path.join(destination, name), stat = fs.lstatSync(source);
      if (stat.isDirectory()) { visit(source, path.join(relative, name)); continue; }
      const resolved = fs.realpathSync(source);
      if ((!stat.isFile() && !stat.isSymbolicLink()) || !resolved.startsWith(original + path.sep) || !fs.statSync(resolved).isFile()) throw new Error("Dependency links must reference contained regular files.");
      if (fs.existsSync(target)) {
        if (Native.hashFile(target) !== Native.hashFile(resolved)) throw new Error("Dependency prefixes contain conflicting files.");
      } else fs.symlinkSync(resolved, target);
    }
  }
  for (const relative of ["include", "lib", "share"]) if (fs.existsSync(path.join(original, relative))) visit(path.join(original, relative), relative);
}

module.exports = { snapshotPrefix, linkPrefix };
