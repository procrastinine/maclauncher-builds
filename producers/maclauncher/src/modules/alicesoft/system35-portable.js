const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../shared/runtime/local-native");
const Audio = require("../shared/runtime/portable-sndfile");

function linkPrefix(inputPrefix, outputPrefix) {
  const original = fs.realpathSync(inputPrefix), output = fs.realpathSync(outputPrefix);
  if (output === original || output.startsWith(original + path.sep) || original.startsWith(output + path.sep)) throw new Error("Portable dependency links require a separate build prefix.");
  function visit(directory, relative) {
    const destination = path.join(output, relative);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(directory).sort()) {
      const source = path.join(directory, name), target = path.join(destination, name), stat = fs.lstatSync(source);
      if (stat.isDirectory()) { visit(source, path.join(relative, name)); continue; }
      const resolved = fs.realpathSync(source);
      if ((!stat.isFile() && !stat.isSymbolicLink()) || !resolved.startsWith(original + path.sep) || !fs.statSync(resolved).isFile()) throw new Error("Portable dependency links must reference contained regular files.");
      if (fs.existsSync(target)) {
        if (Native.hashFile(target) !== Native.hashFile(resolved)) throw new Error("Portable dependency prefixes contain conflicting files.");
      } else fs.symlinkSync(resolved, target);
    }
  }
  // Executables, game fonts and other runtime resources are not inherited.
  for (const relative of ["include", "lib"]) if (fs.existsSync(path.join(original, relative))) visit(path.join(original, relative), relative);
}

function adaptDependencyMetadata(prefix) {
  // Opus's Git-source CMake version probe returns 0 without .git metadata.
  // Replace only this build descriptor; the linked library stays unchanged.
  const pin = Audio.PIN.dependencies.find(row => row.id === "opus");
  const file = path.join(prefix, "lib/pkgconfig/opus.pc"), bytes = fs.readFileSync(file), text = bytes.toString("utf8");
  const version = /^Version:\s*([^\r\n]+)$/m.exec(text)?.[1];
  if (!["0", pin.version].includes(version)) throw new Error("Opus build metadata differs from the selected source version.");
  const adapted = Buffer.from(text.replace(/^Version:[^\r\n]+/m, `Version: ${pin.version}`));
  const temporary = file + ".maclauncher-new";
  fs.writeFileSync(temporary, adapted, { flag: "wx", mode: 0o644 });
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
  return { path: "lib/pkgconfig/opus.pc", sourceRevision: pin.revision, version: pin.version,
    sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"), adaptedSha256: Native.hashFile(file) };
}

module.exports = { linkPrefix, adaptDependencyMetadata };
