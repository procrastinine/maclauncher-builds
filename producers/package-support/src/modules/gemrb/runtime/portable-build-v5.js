const {appRequire}=require('../../../../../../tools/app-source.mjs');
const {includeLicenses} = require('../../../../../../lib/licenses.mjs');
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = appRequire('src/modules/shared/runtime/local-native.js');
const Fonts = require("../../shared/runtime/portable-sdl2-fonts");
const Audio = require("../../shared/runtime/portable-sndfile");
const Mixer = require("../../shared/runtime/portable-sdl2-mixer");
const Python = require("../../shared/runtime/portable-python-v2");
const Prefix = require("../../shared/runtime/portable-dependency-prefix");
const { throwIfAborted } = appRequire('src/modules/shared/runtime/download-utils.js');
const Overlay = require("./portable-overlay-v5");
const PayloadContent = require("./payload-content");
const VERSION = "0.9.5-git-MCLv9";
const {gitlink} = require("../../../../../../lib/pins.mjs");
const REVISION = gitlink("producers/package-support/src/external/gemrb");
const SOURCE_SHA256 = "8fa74bb83dd85ead39ab73068055414c1eaad58c8a05ada31c7d212ed59eef48";
const sourcePath = path.resolve(__dirname, "../../../external/gemrb");
const recipeFiles = [__filename, require.resolve("./portable-overlay-v5"), require.resolve("./payload-content"), require.resolve("../../shared/runtime/portable-dependency-prefix"),
  ...["portable-sdl2-fonts", "portable-sndfile", "portable-sdl2-mixer", "portable-python", "portable-python-v2"].flatMap(name => [require.resolve("../../shared/runtime/" + name), require.resolve("../../shared/runtime/" + name + ".json")])];
const overlayIdentity = () => { const h = crypto.createHash("sha256"); for (const file of recipeFiles) h.update(fs.readFileSync(file)); return h.digest("hex"); };

function configureOptions({ prefix, sdk, tools, python, architecture = process.arch, pathMappings = [] }) {
  const maps = [...pathMappings].flatMap(({ from, to }) => ["file", "macro", "debug"].map(kind => `-f${kind}-prefix-map=${from}=${to}`));
  const flags = [...maps, "-Werror=unguarded-availability-new"].join(" ");
  return [...Fonts.cmakeOptions({ prefix, sdk, ninja: tools.ninja, architecture, pathMappings, options: [] }),
    "-DCMAKE_OBJC_COMPILER=/usr/bin/clang", "-DCMAKE_OBJCXX_COMPILER=/usr/bin/clang++", `-DCMAKE_OBJC_FLAGS=${flags}`, `-DCMAKE_OBJCXX_FLAGS=${flags}`,
    "-DDISABLE_WERROR=ON", "-DUSE_TRACY=OFF", "-DSKIP_DEMO_DATA=ON", "-DSDL_BACKEND=SDL2", "-DOPENGL_BACKEND=None", "-DUSE_SDLMIXER=ON", "-DUSE_OPENAL=ON", "-DUSE_LIBVLC=OFF",
    "-DUSE_FREETYPE=ON", "-DUSE_PNG=ON", "-DUSE_VORBIS=ON", "-DPYTHON_VERSION=3.14", "-DPython_FIND_FRAMEWORK=NEVER", "-DPython_FIND_REGISTRY=NEVER",
    `-DPython_LIBRARY=${python.library}`, `-DPython_INCLUDE_DIR=${python.includeDir}`, `-DPython_ROOT_DIR=${python.prefix}`,
    `-DZLIB_LIBRARY=${sdk}/usr/lib/libz.tbd`, `-DZLIB_INCLUDE_DIR=${sdk}/usr/include`, `-DIconv_LIBRARY=${sdk}/usr/lib/libiconv.tbd`, `-DIconv_INCLUDE_DIR=${sdk}/usr/include`,
    `-DOPENAL_LIBRARY=${sdk}/System/Library/Frameworks/OpenAL.framework`, `-DOPENAL_INCLUDE_DIR=${sdk}/System/Library/Frameworks/OpenAL.framework/Headers`];
}
function validateFeatures(buildRoot) {
  return { python: "3.14.8", pythonObjectSymbolPaths: "relative", sdl: "2.32.10", sdlMixer: "2.8.2", openAL: "macOS system", trueType: true, png: true, vorbis: true, nativeMovieFormats: ["MVE", "BIK"],vlc: false, networkFetch: false,cliConfiguration: true,scriptingReferenceExports: true,bundledDemo: false };
}

async function buildPortableGemRB({ sourceDir = sourcePath, archives, workRoot, dependencyStacks, architecture = process.arch, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(architecture)) throw new Error("GemRB builds require macOS and an arm64 or x64 target.");
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, ...Object.values(dependencyStacks || {}).map(stack => stack.prefix)] });
  Fonts.validateArchives(archives); Audio.validateArchives(archives); Audio.validateArchives(archives, { catalog: Mixer.PIN }); Python.validateArchive(archives?.python);
  const source = await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== SOURCE_SHA256) throw new Error("GemRB source tree differs from the selected version.");
  const recipeSha256 = overlayIdentity();
  let mixer, python;
  if (dependencyStacks) {
    if (Object.keys(dependencyStacks).length !== 2 || !dependencyStacks.mixer || !dependencyStacks.python) throw new Error("GemRB dependency reuse needs exact mixer and Python profiles.");
    mixer = dependencyStacks.mixer; python = dependencyStacks.python;
  }
  fs.mkdirSync(workRoot, { recursive: true });
  if (!mixer) { mixer = await Mixer.buildMixer({ archives, workRoot: path.join(workRoot, "mixer"), architecture, pathMappings, signal, onProgress, dependencies }); python = await Python.buildPython({ archive: archives.python, workRoot: path.join(workRoot, "python"), sdk: mixer.sdk, architecture, pathMappings, signal, onProgress, dependencies }); }
  if (mixer.sdk !== python.sdk) throw new Error("GemRB dependencies must use the same macOS SDK.");
  const prefix = path.join(workRoot, "prefix"), sourceRoot = path.join(workRoot, "gemrb-source"), outputRoot = path.join(workRoot, "gemrb");
  fs.mkdirSync(prefix); Prefix.linkPrefix(mixer.prefix, prefix, { readRoots: [mixer.fonts.prefix, mixer.audio.prefix] });
  const logPath = path.join(workRoot, "gemrb.log"), env = Fonts.buildEnvironment(prefix, mixer.sdk), run = dependencies.runBuildCommand || Source.runBuildCommand;
  delete env.GITHUB_SHA;
  // The shared Python input uses a neutral install name. Give only this new
  // build's library copy an absolute producer location for link collection;
  // runtime packaging replaces it with a contained loader-relative name.
  const pythonLibrary = path.join(prefix, "lib/libpython3.14.dylib");
  fs.copyFileSync(python.library, pythonLibrary, fs.constants.COPYFILE_EXCL);
  includeLicenses(prefix, path.join(python.prefix, 'licenses'));
  const pythonSourceSha256 = Native.hashFile(pythonLibrary);
  await run("/usr/bin/install_name_tool", ["-id", pythonLibrary, pythonLibrary], { cwd: workRoot, logPath, env, signal });
  const pythonLibraryAdapter = { originalSha256: pythonSourceSha256, adaptedSha256: Native.hashFile(pythonLibrary), library: pythonLibrary };
  const sourceTreeSha256 = Source.stagePinnedFiles(sourceDir, source.files, sourceRoot), sourceOverlay = Overlay.apply(sourceRoot, { sourceDir });
  const tools = mixer.tools || { cmake: Source.findBuildTool("cmake"), ninja: Source.findBuildTool("ninja") };
  const compilerMappings = [...pathMappings, { from: sourceRoot, to: "gemrb-source" }, { from: workRoot, to: "gemrb-build" }];
  const options = configureOptions({ prefix, sdk: mixer.sdk, tools, architecture, python: { ...python, library: pythonLibrary }, pathMappings: compilerMappings });
  onProgress?.({ phase: "configure", project: "gemrb" });
  await run(tools.cmake, ["-S", sourceRoot, "-B", outputRoot, ...options], { cwd: workRoot, logPath, env, signal });
  onProgress?.({ phase: "build", project: "gemrb" });
  // Apple plugins link against the CLI bundle loader; finish it first.
  for (const args of [["--build", outputRoot, "--target", "gemrb", "--parallel", "2"], ["--build", outputRoot, "--parallel", "2"]]) await run(tools.cmake, args, { cwd: workRoot, logPath, env, signal, timeout: 20 * 60 * 1000 });
  throwIfAborted(signal);
  const appRoot = path.join(outputRoot, "gemrb/gemrb.app"), executable = path.join(appRoot, "Contents/MacOS/gemrb"), features = validateFeatures(outputRoot);
  PayloadContent.omitOptionalTests(appRoot);
  await run("/usr/libexec/PlistBuddy", ["-c", "Add :LSMinimumSystemVersion string 13.0", path.join(appRoot, "Contents/Info.plist")], { cwd: workRoot, logPath, env, signal });
  await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== sourceTreeSha256 || overlayIdentity() !== recipeSha256) throw new Error("GemRB source or adapter changed during compilation.");
  return { managerId: "gemrb", version: VERSION, sourceRevision: REVISION, sourceTreeSha256, overlaySha256: recipeSha256, sourceOverlay,
    architecture, minimumMacOS: "13.0", appRoot, executable, executableSha256: Native.hashFile(executable), sourceRoot, outputRoot, configureOptions: options, features,
    logPath, dependencyClosure: { mixer, python, pythonLibraryAdapter, prefix }, resources: path.join(appRoot, "Contents/Resources"), plugins: path.join(appRoot, "Contents/PlugIns") };
}
module.exports = { VERSION, REVISION, SOURCE_SHA256, sourcePath, overlayIdentity, configureOptions, validateFeatures, buildPortableGemRB };
