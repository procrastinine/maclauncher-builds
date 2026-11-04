const { gitlink } = require("../../../../../../../lib/pins.mjs");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REVISION = gitlink("producers/maclauncher/src/external/ramen");
const OVERLAY_VERSION = "maclauncher-appkit-4";
const SOURCE_FILES = ["Cargo.toml", "src/platform.rs", "src/connection.rs", "src/window.rs", "src/input.rs", "src/event.rs", "src/window/builder.rs", "src/window/decoration.rs", "src/lib.rs"];
function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function replaceOnce(text, original, replacement, file) {
  if (!text.includes(original) || text.indexOf(original) !== text.lastIndexOf(original)) throw Error(`Pinned ramen ${file} patch context changed.`);
  return text.replace(original, replacement);
}
function applyRamenOverlay({ sourceDir, destination }) {
  if (!path.isAbsolute(sourceDir || "") || !path.isAbsolute(destination || "")) throw Error("Ramen source and owned overlay destinations must be absolute.");
  const source = fs.realpathSync(sourceDir), target = path.resolve(destination);
  if (target === source || target.startsWith(source + path.sep)) throw Error("Copy ramen into an owned staging directory; upstream and Cargo cache are read-only.");
  let existingParent = path.dirname(target);
  while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
  const resolvedTarget = path.join(fs.realpathSync(existingParent), path.relative(existingParent, target));
  if (resolvedTarget === source || resolvedTarget.startsWith(source + path.sep) ||
    resolvedTarget.includes(`${path.sep}.cargo${path.sep}`) || resolvedTarget.includes(`${path.sep}src${path.sep}external${path.sep}`)) {
    throw Error("Copy ramen into an owned staging directory; upstream and Cargo cache are read-only.");
  }
  if (fs.existsSync(target)) throw Error("Ramen overlay destination must be a new staging directory.");
  for (const file of SOURCE_FILES) {
    const location = path.join(source, file), stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw Error(`Ramen ${REVISION} identity check failed for ${file}; no source was patched.`);
    }
  }
  const overlay = path.join(__dirname, "ramen");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.cpSync(source, target, { recursive: true, dereference: false,
      filter: file => !path.relative(source, file).split(path.sep).includes(".git") });
    const edit = (file, transform) => fs.writeFileSync(path.join(target, file), transform(fs.readFileSync(path.join(target, file), "utf8")));
    edit("Cargo.toml", text => text + '\n[target.\'cfg(target_os = "macos")\'.build-dependencies]\ncc = "=1.2.60"\n');
    edit("src/platform.rs", text => text + '\n#[cfg(target_os = "macos")]\npub mod macos;\n#[cfg(target_os = "macos")]\npub(crate) use macos as imp;\n');
    edit("src/connection.rs", text => text.replaceAll("#[cfg(unix)]", '#[cfg(target_os = "linux")]'));
    edit("src/window/builder.rs", text => text.replaceAll("#[cfg(unix)]", '#[cfg(target_os = "linux")]'));
    edit("src/window.rs", text => {
      text = replaceOnce(text, "#[cfg(windows)]", '#[cfg(any(target_os = "windows", target_os = "macos"))]', "cursor dispatch");
      text = replaceOnce(text, "#[cfg(not(windows))]", '#[cfg(not(any(target_os = "windows", target_os = "macos")))]', "cursor fallback");
      return text + '\nimpl Window {\n    /// Borrowed NSView pointer for renderer attachment on the main thread.\n    #[cfg(target_os = "macos")]\n    pub fn nsview(&self) -> *mut std::ffi::c_void { self.0.nsview() }\n    /// Borrowed NSWindow pointer; it remains valid until this window is dropped.\n    #[cfg(target_os = "macos")]\n    pub fn nswindow(&self) -> *mut std::ffi::c_void { self.0.nswindow() }\n}\n';
    });
    fs.cpSync(overlay, target, { recursive: true });
    const overlayFiles = ["build.rs", "src/platform/macos.rs", "src/platform/macos/window.m"];
    const overlayHashes = Object.fromEntries(overlayFiles.map(file => [file, digest(fs.readFileSync(path.join(overlay, file)))]));
    const record = { schemaVersion: 1, dependency: "ramen", upstreamVersion: "0.0.3", upstreamRevision: REVISION,
      overlayVersion: OVERLAY_VERSION, sourceHashes: Object.fromEntries(SOURCE_FILES.map(file=>[file,digest(fs.readFileSync(path.join(source,file)))])), overlayHashes, buildDependency: "cc=1.2.60",
      backend: "AppKit", externalFilesModified: false };
    fs.writeFileSync(path.join(target, "maclauncher-overlay.json"), JSON.stringify(record, null, 2) + "\n");
    return { sourceDir: target, ...record };
  } catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
}
module.exports = { REVISION, OVERLAY_VERSION, SOURCE_FILES, applyRamenOverlay };
