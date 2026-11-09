const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Build = require("../../shared/runtime/pinned-native-build");

function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function patchEnvironment(sourceDir, inherited = process.env) {
  const env = { ...inherited, GIT_OPTIONAL_LOCKS: "0", GIT_CEILING_DIRECTORIES: path.dirname(fs.realpathSync(sourceDir)) };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[name];
  return env;
}

// The files a unified patch writes, in code point order.
function patchFiles(patchFile) {
  const files = new Set();
  let removed = null;
  for (const line of fs.readFileSync(patchFile, "utf8").split("\n")) {
    const header = line.match(/^(---|\+\+\+) (\S+)/);
    if (!header) continue;
    if (header[1] === "---") { removed = header[2]; continue; }
    const name = header[2] === "/dev/null" ? removed : header[2];
    files.add(name.replace(/^[ab]\//, ""));
  }
  return [...files].sort();
}

async function applyPinnedPatch(sourceDir, patchFile, { logPath, signal, env } = {}) {
  if (fs.existsSync(path.join(sourceDir, ".git"))) throw new Error("Apply native dependency patches only to an owned source copy.");
  const files = patchFiles(patchFile);
  for (const file of files)
    if (path.isAbsolute(file) || file.split(/[\\/]/).some(part => part === ".." || part === ".git")) throw new Error("Unsafe native dependency patch path.");
  const digest = file => fs.existsSync(path.join(sourceDir, file)) ? hash(path.join(sourceDir, file)) : null;
  const original = files.map(digest);
  // A copied source tree can sit inside the launcher's Git checkout. Without
  // this boundary git apply can silently skip every hunk and still exit zero.
  const options = { cwd: sourceDir, logPath, signal, env: patchEnvironment(sourceDir, env) };
  const git = Build.findBuildTool("git");
  await Build.runBuildCommand(git, ["apply", "--check", patchFile], options);
  await Build.runBuildCommand(git, ["apply", patchFile], options);
  const adapted = files.map(digest);
  files.forEach((file, index) => { if (adapted[index] === original[index]) throw new Error(`Native dependency patch was not applied: ${file}.`); });
  return { files: files.map(file => ({ path: file })) };
}

module.exports = { patchEnvironment, patchFiles, applyPinnedPatch };
