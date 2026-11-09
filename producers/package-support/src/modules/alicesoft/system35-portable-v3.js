const {appRequire}=require('../../../../../tools/app-source.mjs');
const sharedDependencies=require('../../../../dependencies.json');
const {gitlink} = require("../../../../../lib/pins.mjs");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Source = require("../shared/runtime/pinned-native-build");
const Native = appRequire('src/modules/shared/runtime/local-native.js');
const Fonts = require("../shared/runtime/portable-sdl2-fonts");
const Audio = require("../shared/runtime/portable-sndfile");
const Mixer = require("../shared/runtime/portable-sdl2-mixer");
const Prefix = require("../shared/runtime/portable-dependency-prefix");
const Overlay = require("./system35-overlay-v3");
const { throwIfAborted } = appRequire('src/modules/shared/runtime/download-utils.js');
const PIN = Object.freeze({...require("./system35-portable.json"),dependencies:require("./system35-portable.json").dependencies.map(row=>{const pin=sharedDependencies[row.id];return pin?{...row,revision:pin.revision,sourceUrl:pin.repository,archiveUrl:pin.url||pin.repository+'/archive/'+pin.revision+'.tar.gz',archiveSha256:pin.sha256,archiveBytes:pin.bytes}:{...row,sourceUrl:row.repository||row.sourceUrl,archiveUrl:row.archiveUrl?.replaceAll('{revision}',row.revision)};})});
const VERSION = "MCLv1-1019";
const REVISION = gitlink("producers/package-support/src/external/xsystem35-sdl2");
const SOURCE_SHA256 = "73e633b7b9f3ecbbc760179347b542e4fe69fd18023981ff50224d099f2275a8";
const sourcePath = path.resolve(__dirname, "../../external/xsystem35-sdl2");
const recipeFiles = [__filename, require.resolve("./system35-overlay-v3"), require.resolve("./system35-portable.json"),
  ...["portable-sdl2-fonts", "portable-sndfile", "portable-sdl2-mixer"].flatMap(name =>
    [require.resolve("../shared/runtime/" + name), require.resolve("../shared/runtime/" + name + ".json")]),
  require.resolve("../shared/runtime/portable-dependency-prefix")];
const overlayIdentity = () => { const hash = crypto.createHash("sha256"); for (const file of recipeFiles) hash.update(fs.readFileSync(file)); return hash.digest("hex"); };

async function buildPortableSystem35({ sourceDir = sourcePath, archives, workRoot, dependencyStacks, architecture = process.arch, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(architecture)) throw new Error("xsystem35 builds require macOS and an arm64 or x64 target.");
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, ...Object.values(dependencyStacks || {}).map(stack => stack.prefix)] });
  Fonts.validateArchives(archives); Audio.validateArchives(archives); Audio.validateArchives(archives, { catalog: PIN });
  const source = await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== SOURCE_SHA256) throw new Error("xsystem35 source tree differs from the selected snapshot.");
  const overlaySha256 = overlayIdentity();
  if (dependencyStacks && (Object.keys(dependencyStacks).length !== 1 || !dependencyStacks.mixer)) throw new Error("xsystem35 dependency reuse needs the exact mixer profile.");
  const mixer = dependencyStacks?.mixer || await Mixer.buildMixer({ archives, workRoot: path.join(workRoot, "mixer"), architecture, pathMappings, signal, onProgress, dependencies });
  fs.mkdirSync(workRoot, { recursive: true });
  const prefix = path.join(workRoot, "prefix"), sourceRoots = {}, sources = [];
  fs.mkdirSync(prefix); Prefix.linkPrefix(mixer.prefix, prefix, { readRoots: [mixer.fonts.prefix, mixer.audio.prefix] });
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  for (const pin of PIN.dependencies.filter(pin => ["cjson", "webp"].includes(pin.id))) {
    const sourceRoot = path.join(workRoot, "source", pin.id); fs.mkdirSync(sourceRoot, { recursive: true });
    await run("/usr/bin/tar", ["-xf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot],
      { cwd: workRoot, logPath: path.join(workRoot, "extraction.log"), env: Fonts.buildEnvironment(prefix, mixer.sdk), signal });

    const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, pin.id), prefix, sdk: mixer.sdk,
      tools: mixer.tools, architecture, pathMappings, options: pin.options, signal, onProgress, dependencies });
    sourceRoots[pin.id] = sourceRoot; sources.push({ ...pin, ...build });
  }
  const sourceRoot = path.join(workRoot, "xsystem35-source"), sourceTreeSha256 = Source.stagePinnedFiles(sourceDir, source.files, sourceRoot);
  const sourceOverlay = Overlay.apply(sourceRoot, { sourceDir });
  const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, "xsystem35"), prefix, sdk: mixer.sdk,
    tools: mixer.tools, architecture, pathMappings, options: ["-DXSYSTEM35_SDL_VERSION=2", "-DXSYSTEM35_FETCH_SDL3_MIXER=OFF",
      "-DENABLE_DEBUGGER=ON", "-DENABLE_WEBP=ON", "-DENABLE_PORTMIDI=OFF", "-DENABLE_GETTEXT=OFF"], signal, onProgress, dependencies });
  const config = fs.readFileSync(path.join(workRoot, "xsystem35/config.h"), "utf8");
  for (const name of ["ENABLE_DEBUGGER", "ENABLE_MIDI_SDLMIXER", "HAVE_WEBP"]) if (!new RegExp(`^#define ${name} (?:1|ON)$`, "m").test(config)) throw new Error(`xsystem35 did not enable ${name}.`);
  for (const name of ["HAVE_LIBINTL", "ENABLE_MIDI_PORTMIDI"]) if (new RegExp(`^#define ${name} `, "m").test(config)) throw new Error("xsystem35 enabled an unselected dependency.");
  throwIfAborted(signal); await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== sourceTreeSha256 || overlayIdentity() !== overlaySha256) throw new Error("xsystem35 source or adapter changed during compilation.");
  const executable = path.join(prefix, "bin/xsystem35");
  return { managerId: "xsystem35", version: VERSION, sourceRevision: REVISION, sourceTreeSha256, overlaySha256, sourceOverlay,
    architecture, minimumMacOS: "13.0", executable, executableSha256: Native.hashFile(executable), resources: path.join(prefix, "share/xsystem35"),
    features: { debugger: true, webp: true, sdl: "2.32.10", midi: "macOS AudioToolbox", ...mixer.features },
    ...build, dependencyClosure: { mixer, prefix, sources, sourceRoots } };
}
module.exports = { VERSION, REVISION, SOURCE_SHA256, PIN, sourcePath, overlayIdentity, buildPortableSystem35 };
