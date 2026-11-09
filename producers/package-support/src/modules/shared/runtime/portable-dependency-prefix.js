const {appRequire}=require('../../../../../../tools/app-source.mjs');
const fs = require("node:fs");
const path = require("node:path");
const Native = appRequire('src/modules/shared/runtime/local-native.js');

function linkPrefix(inputPrefix, outputPrefix, { readRoots = [] } = {}) {
  const original = fs.realpathSync(inputPrefix), output = fs.realpathSync(outputPrefix);
  if (!Array.isArray(readRoots) || readRoots.length > 8 || readRoots.some(value => !path.isAbsolute(value || "") || !fs.lstatSync(value).isDirectory())) throw new Error("Dependency read roots must be explicit real directories.");
  const roots = [original, ...readRoots.map(value => fs.realpathSync(value))];
  if (output === original || output.startsWith(original + path.sep) || original.startsWith(output + path.sep)) throw new Error("Dependency links require a separate build prefix.");
  function visit(directory, relative) {
    const destination = path.join(output, relative); fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(directory).sort()) {
      const source = path.join(directory, name), target = path.join(destination, name), stat = fs.lstatSync(source);
      if (stat.isDirectory()) { visit(source, path.join(relative, name)); continue; }
      const resolved = fs.realpathSync(source);
      if ((!stat.isFile() && !stat.isSymbolicLink()) || !roots.some(value => resolved.startsWith(value + path.sep)) || !fs.statSync(resolved).isFile()) throw new Error("Dependency links must reference declared regular files.");
      if (fs.existsSync(target)) {
        if (Native.hashFile(target) !== Native.hashFile(resolved)) throw new Error("Dependency prefixes contain conflicting files.");
      } else fs.symlinkSync(resolved, target);
    }
  }
  for (const relative of ["include", "lib"]) if (fs.existsSync(path.join(original, relative))) visit(path.join(original, relative), relative);
}

module.exports = { linkPrefix };
