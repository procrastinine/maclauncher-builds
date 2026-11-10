const {addLicense,addLicenses} = require('../../../../../../lib/licenses.mjs');
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Native = require('../../../../../../lib/package-format.cjs');
const Source = require("../../shared/runtime/pinned-native-build");
const BuildTools = require("../../shared/runtime/native-build-tools");
// SDL2 is the shared release archive declared once for every Builds recipe; sdl12-compat is declared beside it.
const sdl2 = require("../../../../../dependencies/sdl2.json");
const sdl12 = require("../../../../../dependencies/sdl12Compat.json");
const { throwIfAborted } = require('../../../../../../lib/abort.cjs');

const SNAPSHOT_REVISION = require('../../../../../../lib/projects.mjs').upstreamRevision('onscripter-en', 'onscripter-en');
const PACKAGES = Object.freeze({
  source: { filename: `onscripter-en-${SNAPSHOT_REVISION}.tar.gz`, url: `https://github.com/Galladite27/ONScripter-EN/archive/${SNAPSHOT_REVISION}.tar.gz`, sha256: "ef79365a2c9fd432d1b13bc113b73a0b175a6e3cb94e43709211402a8f7b867c", folder: `ONScripter-EN-${SNAPSHOT_REVISION}` },
  sdl12: { filename: "sdl12-compat-1.2.76.tar.gz", url: sdl12.url, sha256: sdl12.sha256, folder: "sdl12-compat-release-1.2.76" },
  sdl2: { filename: path.basename(sdl2.url), url: sdl2.url, sha256: sdl2.sha256, folder: path.basename(sdl2.url, ".tar.gz") },
  ...BuildTools.PACKAGES
});
const SOURCE_SCOPE = Object.freeze({ kind: "primary-tree", omittedSubmodules: ["test/googletest"] });
const building = new Set();

function compilerPrefixMaps({ work, source, overlay, packageRoots = {}, profile, home = os.homedir(),
  workspace = path.resolve(__dirname, "../../../.."), temporary = os.tmpdir(), caches = [] } = {}) {
  const maps = new Map();
  function add(directory, logical) {
    if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0") || directory === path.parse(directory).root) return;
    maps.set(path.resolve(directory), logical);
    try { maps.set(fs.realpathSync(directory), logical); } catch {}
  }
  add(home, "maclauncher-home");
  add(workspace, "maclauncher-workspace");
  for (const cache of [path.join(home, "Library/Caches"), process.env.XDG_CACHE_HOME, ...caches]) add(cache, "maclauncher-cache");
  for (const root of [temporary, process.env.TMPDIR, process.env.TMP, process.env.TEMP]) add(root, "maclauncher-temporary");
  const buildRoot = `maclauncher-build/onscripter-en/${profile}`;
  add(work, buildRoot);
  add(source, "src/external/onscripter-en");
  add(overlay, "src/modules/nscripter/overlays/onscripter-en");
  add(packageRoots.sdl2, "third_party/SDL2/2.32.10");
  add(packageRoots.sdl12, "third_party/sdl12-compat/1.2.76");
  // Clang gives later prefix maps precedence. Broad origins precede owned
  // source/generator roots, including /var and /private/var aliases.
  return [...maps].sort(([a], [b]) => a.length - b.length).map(([from, to]) => ({ from, to }));
}

function compilerPathFlags(mappings) {
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  return mappings.flatMap(({ from, to }) => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${quote(from + "=" + to)}`)).join(" ");
}

function sourceFiles(root, depth = 0, prefix = "", output = []) {
  if (depth > 32) throw new Error("Source archive is too deeply nested.");
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) sourceFiles(root, depth + 1, relative, output);
    else if (entry.isFile()) output.push(relative);
    else throw new Error("Source archive contains unsupported symbolic or special files.");
  }
  return output;
}

async function buildRuntime({ manager, userDataDir, version, packageVersion, sourceDir, architecture = process.arch, retainBuildDirectory = false, logger, signal, onProgress, dependencies = {} } = {}) {
  const PROFILE = "MCLv1-0126", REVISION = SNAPSHOT_REVISION;
  const selected = version || PROFILE, outputVersion = packageVersion === undefined ? selected : packageVersion;
  if (selected !== PROFILE || typeof outputVersion !== "string" || !outputVersion.trim() || process.platform !== "darwin" || !["arm64", "x64"].includes(architecture)) {
    throw new Error("The reviewed ONScripter-EN source adapter supports the selected Mac source snapshot.");
  }
  const destination = manager.core.getInstallDir({ userDataDir, version: outputVersion });
  if (building.has(destination)) throw new Error("This ONScripter-EN version is already building.");
  if (fs.existsSync(path.join(destination, "runtime.json"))) throw new Error("This runtime version is already installed.");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-onscripter-en-build-"));
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  const download = dependencies.downloadToFile;
  fs.mkdirSync(destination, { recursive: true });
  const logPath = path.join(destination, "build.log");
  const payload = path.join(destination, "files");
  fs.writeFileSync(logPath, `ONScripter-EN ${outputVersion}\nSource ${REVISION}\n`);
  building.add(destination);
  try {
    const packageRoots = {};
    async function packageArchive(key, into) {
      const pin = PACKAGES[key], archive = path.join(work, pin.filename);
      await download(pin.url, archive, { signal });
      throwIfAborted(signal);
      if (Native.hashFile(archive) !== pin.sha256) throw new Error(`${pin.filename} failed its SHA-256 check.`);
      fs.mkdirSync(into, { recursive: true });
      await run(pin.filename.endsWith(".zip") ? "/usr/bin/ditto" : "/usr/bin/tar",
        pin.filename.endsWith(".zip") ? ["-x", "-k", archive, into] : ["-xzf", archive, "-C", into], { logPath, signal });
      packageRoots[key] = pin.folder ? path.join(into, pin.folder) : into;
    }
    // Probe Apple's compiler/SDK before acquiring auxiliary source or tools.
    await run("/usr/bin/xcrun", ["--find", "clang"], { logPath, signal });
    await run("/usr/bin/xcrun", ["--show-sdk-path"], { logPath, signal });
    const toolOptions = { temporary: work, packageArchive, findBuildTool: dependencies.findBuildTool || Source.findBuildTool };
    const cmake = await BuildTools.resolveBuildTool("cmake", toolOptions);
    const ninja = await BuildTools.resolveBuildTool("ninja", toolOptions);
    let source = sourceDir, sourceArchiveSha256 = null;
    if (source && fs.existsSync(path.join(source, ".git"))) {
      const pin = await Source.pinnedFiles(source, REVISION, { signal, sourceScope: SOURCE_SCOPE });
      const privateSource = path.join(work, "source");
      Source.stagePinnedFiles(source, pin.files, privateSource);
      source = privateSource;
    } else {
      await packageArchive("source", path.join(work, "source-package"));
      sourceArchiveSha256 = PACKAGES.source.sha256;
      source = path.join(work, "source");
      Source.stagePinnedFiles(packageRoots.source, sourceFiles(packageRoots.source), source);
    }
    await packageArchive("sdl12", path.join(work, "sdl12-package"));
    await packageArchive("sdl2", path.join(work, "sdl2-package"));
    onProgress?.({ downloaded: 1, total: 5 });
    const prefix = path.join(work, "deps"), arch = architecture === "x64" ? "x86_64" : "arm64";
    const overlaySource = path.resolve(__dirname, "../overlays/onscripter-en-v3"), overlay = path.join(work, "overlay");
    fs.cpSync(overlaySource, overlay, { recursive: true });
    const prefixMaps = compilerPrefixMaps({ work, source, overlay, packageRoots, profile: selected });
    const compilerFlags = compilerPathFlags(prefixMaps);
    async function build(sourceRoot, name, options = []) {
      const output = path.join(work, `${name}-build`);
      await run(cmake, ["-S", sourceRoot, "-B", output, "-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`,
        "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
        ...["C", "CXX", "OBJC", "OBJCXX"].map(language => `-DCMAKE_${language}_FLAGS=${compilerFlags}`),
        `-DCMAKE_OSX_ARCHITECTURES=${arch}`, `-DCMAKE_INSTALL_PREFIX=${name === "engine" ? payload : prefix}`,
        "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", "-DFETCHCONTENT_UPDATES_DISCONNECTED=ON", ...options], { logPath, signal });
      await run(cmake, ["--build", output, "--parallel", "4"], { logPath, signal });
      await run(cmake, ["--install", output], { logPath, signal });
      return output;
    }
    await build(packageRoots.sdl2, "sdl2", ["-DSDL_SHARED=ON", "-DSDL_STATIC=OFF", "-DSDL_TEST=OFF", "-DSDL_TESTS=OFF"]);
    onProgress?.({ downloaded: 2, total: 5 });
    await build(packageRoots.sdl12, "sdl12", ["-DSDL12TESTS=OFF", "-DSDL12DEVEL=ON", `-DSDL2_INCLUDE_DIR=${prefix}/include/SDL2`]);
    onProgress?.({ downloaded: 3, total: 5 });
    await build(overlay, "engine", [`-DONS_SOURCE=${source}`, `-DSDL12_PREFIX=${prefix}`]);
    fs.mkdirSync(path.join(payload, "lib"), { recursive: true });
    for (const name of ["libSDL-1.2.0.dylib", "libSDL2-2.0.0.dylib"]) {
      const target = path.join(payload, "lib", name);
      fs.copyFileSync(path.join(prefix, "lib", name), target);
      await run("/usr/bin/codesign", ["--force", "--sign", "-", target], { logPath, signal });
    }
    const executable = path.join(payload, "bin", "onscripter-en");
    await run("/usr/bin/codesign", ["--force", "--sign", "-", executable], { logPath, signal });
    addLicenses(payload, "ONScripter-EN", source);
    addLicenses(payload, "sdl12-compat", packageRoots.sdl12);
    addLicenses(payload, "SDL2", packageRoots.sdl2);
    const extlib = path.join(source, "extlib/src");
    addLicenses(payload, "SDL_image-1.2.12", path.join(extlib, "SDL_image-1.2.12"));
    addLicenses(payload, "SDL_mixer-1.2.12", path.join(extlib, "SDL_mixer-1.2.12"));
    addLicenses(payload, "SDL_ttf-2.0.11", path.join(extlib, "SDL_ttf-2.0.11"));
    addLicenses(payload, "freetype-2.13.0", path.join(extlib, "freetype-2.13.0"));
    addLicenses(payload, "libogg-1.3.5", path.join(extlib, "libogg-1.3.5"));
    addLicenses(payload, "libvorbis-1.3.7", path.join(extlib, "libvorbis-1.3.7"));
    addLicenses(payload, "libpng-1.6.39", path.join(extlib, "libpng-1.6.39"));
    addLicenses(payload, "bzip2-1.0.8", path.join(extlib, "bzip2-1.0.8"));
    addLicenses(payload, "smpeg", path.join(extlib, "smpeg"));
    addLicense(payload, "FreeType FTL", path.join(extlib, "freetype-2.13.0/docs/FTL.TXT"));
    addLicenses(payload, "SMPEG audio", path.join(extlib, "smpeg/audio"));
    addLicenses(payload, "SMPEG video", path.join(extlib, "smpeg/video"));
    addLicense(payload, "IJG JPEG", path.join(extlib, "jpeg-9f/README"));
    const verifiedBuild = { sourceRevision: REVISION, sourceArchiveSha256, sourceScope: SOURCE_SCOPE,
      adapterProfile: "mac-sdl12-v3", architecture, minimumMacOS: "13.0",
      compilerPrefixMaps: prefixMaps, compilerFlags, buildDirectory: work,
      nativeVersions: { sdl12Compat: "1.2.76", sdl2: "2.32.10" }, packages: Object.fromEntries(Object.entries(PACKAGES).map(([key, pin]) => [key, pin.sha256])) };
    // The shipped profile contains logical source identities only. Complete
    // machine-local compiler inputs remain in the private runtime receipt.
    const publicBuild = { ...verifiedBuild, compilerPrefixMaps: prefixMaps.map(({ to }) => ({ logicalRoot: to })) };
    delete publicBuild.compilerFlags; delete publicBuild.buildDirectory;
    fs.writeFileSync(path.join(payload, "onscripter-en-runtime.json"), JSON.stringify(publicBuild, null, 2));
    throwIfAborted(signal);
    onProgress?.({ downloaded: 4, total: 5 });
    const installed = manager.core.registerLocal({ userDataDir, version: outputVersion, runtimePath: executable, verifiedBuild });
    logger?.info?.(`[onscripter-en] installed ${outputVersion}; ${logPath}`);
    onProgress?.({ downloaded: 5, total: 5 });
    return { ...installed, logPath, verifiedBuild, sdl2Source: packageRoots.sdl2 };
  } finally { if (!retainBuildDirectory) fs.rmSync(work, { recursive: true, force: true }); building.delete(destination); }
}

module.exports = { SOURCE_SCOPE, PACKAGES, buildRuntime, sourceFiles, compilerPrefixMaps, compilerPathFlags };
