const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");

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

module.exports = { linkPrefix };
