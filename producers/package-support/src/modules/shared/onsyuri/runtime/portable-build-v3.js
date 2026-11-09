const fs = require("node:fs");
const path = require("node:path");
const Base = require("./portable-build");
const Page = require("./portable-page-reset");
const Source = require("../../runtime/pinned-native-build");
const Native = require('../../../../../../../lib/package-format.cjs');
const Fonts = require("../../runtime/portable-sdl2-fonts");
const Audio = require("../../runtime/portable-sndfile");
const Mixer = require("../../runtime/portable-sdl2-mixer");
const Prefix = require("../../runtime/portable-dependency-prefix");
const { throwIfAborted } = require('../../../../../../../lib/abort.cjs');
const VERSION_PIN = require("./portable-build-v3.json");
const PIN = Object.freeze({ ...Base.PIN, ...VERSION_PIN, engine: { ...Base.PIN.engine, ...VERSION_PIN.engine } });
const VERSION = PIN.engine.version, REVISION = PIN.engine.revision, SOURCE_SHA256 = PIN.engine.sourceTreeSha256;

function validateBase() {
}

function validateEngineFeatures(outputRoot) {
  const commands = fs.readFileSync(path.join(outputRoot, "compile_commands.json"), "utf8");
  for (const name of ["USE_LUA", "USE_BUILTIN_LAYER_EFFECTS", "ENABLE_1BYTE_CHAR", "USE_PARALLEL"]) if (!commands.includes(name)) throw new Error(`Yuri native host did not enable ${name}.`);
  if (commands.includes("USE_GLES") || commands.includes("renderer/gles_renderer.cpp")) throw new Error("Yuri macOS build enabled the excluded GLES sharpness path.");
}

async function buildPortableYuri({ sourceDir, archives, workRoot, mixerStack, architecture = process.arch, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(architecture)) throw new Error("Yuri builds require macOS and an arm64 or x64 target.");
  validateBase();
  if (!path.isAbsolute(sourceDir || "")) throw new Error("Choose an absolute clean checkout of the pinned Yuri source.");
  const scope = Base.PIN.engine.sourceScope;
  const original = await Source.pinnedFiles(sourceDir, REVISION, { signal, sourceScope: scope });
  Base.validateEngineArchive(archives); Fonts.validateArchives(archives); Audio.validateArchives(archives); Audio.validateArchives(archives, { catalog: Mixer.PIN }); Fonts.validateArchives(archives, { catalog: Base.PIN });
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir] });
  fs.mkdirSync(workRoot, { recursive: true });
  const mixer = mixerStack || await Mixer.buildMixer({ archives, workRoot: path.join(workRoot, "mixer-dependencies"), architecture, pathMappings, signal, onProgress, dependencies });
  const prefix = path.join(workRoot, "prefix"); fs.mkdirSync(prefix);
  Prefix.linkPrefix(mixer.prefix, prefix, { readRoots: mixer.readRoots });
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  const sources = [], sourceRoots = {};
  for (const pin of Base.PIN.dependencies) {
    throwIfAborted(signal);
    const sourceRoot = path.join(workRoot, "source", pin.id); fs.mkdirSync(sourceRoot, { recursive: true });
    await run("/usr/bin/tar", ["-xf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot],
      { cwd: workRoot, logPath: path.join(workRoot, "extraction.log"), env: Fonts.buildEnvironment(prefix, mixer.sdk), signal });

    const sourceOverlay = pin.id === "lua" ? Base.adaptLua(sourceRoot) : undefined;
    const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, pin.id), prefix, sdk: mixer.sdk, tools: mixer.tools, architecture,
      pathMappings, options: pin.options, signal, onProgress, dependencies });
    sources.push({ ...pin, ...build, ...(sourceOverlay ? { sourceOverlay } : {}) }); sourceRoots[pin.id] = sourceRoot;
  }
  const sourceRoot = path.join(workRoot, "onsyuri-source");
  Source.stagePinnedFiles(sourceDir, original.files, sourceRoot);
  const cmake = Base.adaptEngine(sourceRoot, sourceDir), page = Page.apply(sourceRoot, sourceDir);
  const sourceOverlay = { files: [...cmake.files, ...page.files] };
  const outputRoot = path.join(workRoot, "onsyuri");
  const build = await Fonts.buildProject({ sourceRoot, outputRoot, prefix, sdk: mixer.sdk, tools: mixer.tools, architecture,
    pathMappings, options: [], signal, onProgress, dependencies });
  validateEngineFeatures(outputRoot);
  const features = { ...mixer.features, ...Base.validateFeatures(workRoot), emptyPageReset: true };
  const profile = { schemaVersion: 1, version: VERSION, upstreamVersion: PIN.engine.upstreamVersion, upstreamRevision: REVISION,
    sourceScope: original.sourceScope, omittedSubmodules: original.omittedSubmodules, architecture, minimumMacOS: "13.0", features };
  fs.writeFileSync(path.join(prefix, "profile.json"), JSON.stringify(profile, null, 2) + "\n", { flag: "wx" });
  throwIfAborted(signal);
  const executable = path.join(prefix, "bin/onsyuri");
  return { managerId: "onsyuri", version: VERSION, sourceRevision: REVISION, sourceScope: original.sourceScope,
    omittedSubmodules: original.omittedSubmodules, sourceOverlay, architecture, minimumMacOS: "13.0", executable,
    executableSha256: Native.hashFile(executable), profile, features, ...build,
    dependencyClosure: { version: PIN.version, prefix, sdk: mixer.sdk, tools: mixer.tools, mixer, sources, sourceRoots } };
}

module.exports = { PIN, VERSION, REVISION, SOURCE_SHA256, validateBase,
  validateEngineFeatures, buildPortableYuri };
