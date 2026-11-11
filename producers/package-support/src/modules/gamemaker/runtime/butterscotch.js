const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const { findBuildTool } = require("../../shared/runtime/pinned-native-build");

function applyIdentity(root) {
  const file=path.join(root,"src/backends/appkit.m");let text=fs.readFileSync(file,"utf8");
  const replace=(before,after)=>{if(text.split(before).length!==2)throw new Error("Pinned Butterscotch identity boundary changed.");text=text.replace(before,after);};
  replace('    [NSApplication sharedApplication];','    const char *game_name = getenv("MACLAUNCHER_GAME_NAME"), *artwork = getenv("MACLAUNCHER_GAME_ICON");\n    NSString *display_name = game_name && *game_name ? [NSString stringWithUTF8String:game_name] : nil;\n    if (display_name.length) { NSProcessInfo.processInfo.processName = display_name; title = game_name; }\n    [NSApplication sharedApplication];\n    if (artwork && *artwork) {\n        NSImage *image = [[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:artwork]];\n        if (image) NSApp.applicationIconImage = image;\n        [image release];\n    }');
  replace('NSMenu* createAppMenu() {','NSMenu* createAppMenu() {\n    const char *game_name = getenv("MACLAUNCHER_GAME_NAME");\n    NSString *display_name = game_name && *game_name ? [NSString stringWithUTF8String:game_name] : nil;');
  replace('initWithTitle:@"About"','initWithTitle:display_name.length ? [@"About " stringByAppendingString:display_name] : @"About"');
  replace('initWithTitle:@"Hide"','initWithTitle:display_name.length ? [@"Hide " stringByAppendingString:display_name] : @"Hide"');
  replace('[window setTitle:[NSString stringWithFormat:@"Butterscotch - %s", title]];','const char *game_name = getenv("MACLAUNCHER_GAME_NAME");\n    [window setTitle:game_name && *game_name ? [NSString stringWithUTF8String:title] : [NSString stringWithFormat:@"Butterscotch - %s", title]];');
  fs.writeFileSync(file,text);
}
async function buildRuntime({ userDataDir, version, sourceDir, architecture = process.arch, logger, signal, runtimeManager } = {}) {
  if (!["arm64", "x64"].includes(architecture)) throw new Error("Select an arm64 or x64 Butterscotch build.");
  if (process.platform !== "darwin") throw new Error("Butterscotch AppKit builds require macOS.");
  version ||= runtimeManager.resolveSelection(null, {}, userDataDir).version;
  if (!version) throw new Error("Select a compatible source build version before compiling Butterscotch.");
  const installed = runtimeManager.core.resolveRegistered({ userDataDir, version });
  if (installed) return installed;
  runtimeManager.core.normalizeVersion(version);
  const pin = runtimeManager.core.catalog.find(entry => entry.version === version);
  if (pin?.asset) throw new Error("Choose a source build version for compilation. Public nightlies install from their matching download.");
  if (!pin || !/^[a-f0-9]{40}$/.test(pin.upstreamRevision || "")) throw new Error("Selected Butterscotch build has no immutable source revision.");
  if (!path.isAbsolute(sourceDir || "")) throw new Error("Butterscotch source checkout must be an absolute local path.");
  const source = sourceDir;
  const abortOptions = signal ? { signal } : {};
  // Source pin verification is required: this builder never fetches or edits the submodule.
  try { await run("/usr/bin/git", ["-C", source, "cat-file", "-e", `${pin.upstreamRevision}^{commit}`], { ...abortOptions, timeout: 10000 }); }
  catch { throw new Error("Selected Butterscotch commit is absent from the local checkout. Fetch that exact revision into a separate clean checkout and choose it as the build source."); }
  const dirty = await run("/usr/bin/git", ["-C", source, "status", "--porcelain", "--untracked-files=normal"], { ...abortOptions, timeout: 10000 });
  if (dirty.stdout.trim()) throw new Error("Butterscotch source has local modifications; the pinned builder requires unchanged source.");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-butterscotch-build-"));
  try {
    logger?.info?.(`[butterscotch] building ${version} from ${pin.upstreamRevision}`);
    const snapshot = path.join(temporary, "source"), archive = path.join(temporary, "source.tar");
    fs.mkdirSync(snapshot);
    await run("/usr/bin/git", ["-C", source, "archive", "--format=tar", `--output=${archive}`, pin.upstreamRevision], { ...abortOptions, timeout: 60000 });
    await run("/usr/bin/tar", ["-xf", archive, "-C", snapshot], { ...abortOptions, timeout: 60000 });
    fs.rmSync(archive);
    const overlay = pin.gameArguments === "repeat-game-arg-v1"
      ? require("../overlays/butterscotch-game-arguments").apply(snapshot) : null;
    applyIdentity(snapshot);
    const options = { ...abortOptions, timeout: 15 * 60 * 1000, maxBuffer: Infinity};
    const cmake = findBuildTool("cmake");
    const maps = ["-ffile-prefix-map", "-fmacro-prefix-map", "-fdebug-prefix-map"].flatMap(option =>
      [`${option}=${temporary}=butterscotch-build`, `${option}=${snapshot}=butterscotch-source`]).join(" ");
    const configureOptions = ["-DBACKEND=appkit", "-DVIDEO_BACKEND=none", "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0", `-DCMAKE_OSX_ARCHITECTURES=${architecture === "x64" ? "x86_64" : architecture}`,
      `-DBUTTERSCOTCH_COMMIT_HASH=${pin.upstreamRevision}`,
      `-DCMAKE_C_FLAGS=${maps}`, `-DCMAKE_OBJC_FLAGS=${maps}`];
    await run(cmake, ["-S", snapshot, "-B", path.join(temporary, "build"), ...configureOptions], options);
    await run(cmake, ["--build", path.join(temporary, "build"), "--parallel", "2"], options);
    const destination = runtimeManager.core.getInstallDir({ userDataDir, version });
    fs.mkdirSync(destination, { recursive: true });
    const executablePath = path.join(destination, "butterscotch");
    fs.copyFileSync(path.join(temporary, "build", "butterscotch"), executablePath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(executablePath, 0o755);
    try {
      const result = runtimeManager.core.registerLocal({ userDataDir, version, runtimePath: executablePath });
      // Registration records the hash; retain the stronger source-build evidence as well.
      const recordPath = path.join(destination, "runtime.json");
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      const metadataTemp = path.join(destination, `.runtime-build-${randomUUID()}.json`);
      try {
        fs.writeFileSync(metadataTemp, JSON.stringify({ ...record, sourceBuildVerified: true, provenanceVerified: true, backend: "appkit",
          renderer: "legacy-opengl", videoBackend: "none", deploymentTarget: "13.0",
          ...(overlay ? { gameArguments: pin.gameArguments, argumentOverlay: overlay } : {}),
          configureOptions: configureOptions.map(option => option.replaceAll(snapshot, "${SOURCE_ROOT}").replaceAll(temporary, "${BUILD_ROOT}")) }, null, 2) + "\n", { flag: "wx" });
        fs.renameSync(metadataTemp, recordPath);
      } finally { fs.rmSync(metadataTemp, { force: true }); }
      return { ...result, sourceBuildVerified: true, provenanceVerified: true, backend: "appkit" };
    } catch (error) {
      fs.rmSync(executablePath, { force: true });
      throw error;
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { applyIdentity, buildRuntime };
