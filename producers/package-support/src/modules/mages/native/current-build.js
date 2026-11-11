const {sourceRevision}=require('../../../../../../lib/pins.mjs');
const fs = require("node:fs");
const path = require("node:path");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require('../../../../../../lib/package-format.cjs');
const Fonts = require("../../shared/runtime/portable-sdl2-fonts");
const Dependency = require("./portable-dependencies");
const Portable = require("./portable-build");
const Patches = require("./source-patches");
const Pins = require("./sources.json");
const { throwIfAborted } = require('../../../../../../lib/abort.cjs');

const VERSION = "0.10.8.937-MCLv1";
// Exact upstream sources of this build: { repository, revision } each.
const SOURCES = Object.freeze(Object.fromEntries(["impacto", "avcpp", "atrac9", "magicEnum"]
  .map(id => [id, Object.freeze({ repository: Pins[id].repository, revision: sourceRevision(Pins[id]) })])));
const REVISION = SOURCES.impacto.revision;
const PROFILE = "windows-mpk2-sc3-sfx-macos13-v9";
const PATCH = path.join(__dirname, "current-windows.patch");
const ABI_PROFILE = Object.freeze({ input: "windows-sc3-input-v1", audio: "windows-sc3-voice-v1",
  checkpoint: "windows-sc3-checkpoint-u16-v1", backlog: "backlog-zero-capacity-v1", soundEffect: "windows-sc3-sfx-v1" });
function applyIdentity(directory) {
  const file=path.join(directory,"src/renderer/window.cpp");let text=fs.readFileSync(file,"utf8");
  const replace=(before,after)=>{if(text.split(before).length!==2)throw new Error("Pinned Impacto game identity boundary changed.");text=text.replace(before,after);};
  replace('SDLWindow = SDL_CreateWindow("Impacto", WindowWidth, WindowHeight, flags);','const char *game_name = SDL_getenv("MACLAUNCHER_GAME_NAME");\n  SDLWindow = SDL_CreateWindow(game_name && *game_name ? game_name : "Impacto", WindowWidth, WindowHeight, flags);');
  replace('SDL_SetWindowTitle(SDLWindow, Profile::Game::WindowName.c_str());','const char *game_name = SDL_getenv("MACLAUNCHER_GAME_NAME");\n  SDL_SetWindowTitle(SDLWindow, game_name && *game_name ? game_name : Profile::Game::WindowName.c_str());');
  replace('void SetWindowIcon(SDL_Window* window) {','void SetWindowIcon(SDL_Window* window) {\n  const char *file = SDL_getenv("MACLAUNCHER_GAME_ICON");\n  if (file && *file) {\n    int width, height, channels;\n    if (uint8_t *pixels = stbi_load(file, &width, &height, &channels, STBI_rgb_alpha)) {\n      SDL_Surface *icon = SDL_CreateSurfaceFrom(width, height, SDL_PIXELFORMAT_RGBA32, pixels, width * 4);\n      if (icon) { SDL_SetWindowIcon(window, icon); SDL_DestroySurface(icon); }\n      stbi_image_free(pixels);\n      if (icon) return;\n    }\n  }');
  fs.writeFileSync(file,text);
  require("../../shared/runtime/application-identity").attach(directory,"impacto");
}
async function applyCurrentOverlay(directory, { logPath, signal } = {}) {
  return { upstreamRevision: REVISION,
    ...await Patches.applyPinnedPatch(directory, PATCH, { logPath, signal }) };
}

// SDK prefixes are ordinary outputs of the portable dependency, codec and
// avcpp recipes. The Windows Bink2 codec and all earlier ABI profiles remain
// independent of this engine source snapshot.
async function buildCurrentImpacto({ sourceDir, workRoot, dependencyStack, ffmpegPrefix, avcppPrefix,
  atrac9Source, magicEnumSource, pathMappings = [], dependencies = {}, signal }) {
  throwIfAborted(signal);
  const source = await Source.pinnedFiles(sourceDir, REVISION, { signal });
  const inputs = [ffmpegPrefix, avcppPrefix, atrac9Source, magicEnumSource];
  if (inputs.some(value => !path.isAbsolute(value || "") || !fs.statSync(value).isDirectory()))
    throw new Error("Impacto requires explicit codec, avcpp and native dependency source directories.");
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, dependencyStack.prefix, ...inputs] });
  const sdk = dependencyStack.sdk;
  const findTool = dependencies.findBuildTool || Source.findBuildTool;
  const tools = { cmake: findTool("cmake"), ninja: findTool("ninja") };
  const projected = path.join(workRoot, "source"), output = path.join(workRoot, "build"), prefix = path.join(workRoot, "prefix");
  fs.mkdirSync(workRoot, { recursive: true });
  Source.stagePinnedFiles(sourceDir, source.files, projected);
  const logPath = path.join(workRoot, "build.log");
  const sourceOverlay = await applyCurrentOverlay(projected, { logPath, signal });
  applyIdentity(projected);
  const atrac9 = path.join(workRoot, "atrac9");
  fs.cpSync(atrac9Source, atrac9, { recursive: true, verbatimSymlinks: true,
    filter: file => path.basename(file) !== ".git" });
  fs.copyFileSync(path.join(projected, "vendor/patches/LibAtrac9/CMakeLists.txt"), path.join(atrac9, "CMakeLists.txt"));
  const harfbuzz = Portable.writeHarfBuzzDescriptor(path.join(workRoot, "harfbuzz"),
    require("../../shared/runtime/portable-sdl2-fonts.json").dependencies.find(pin => pin.id === "harfbuzz").version);
  const prefixes = [avcppPrefix, ffmpegPrefix, dependencyStack.prefix];
  const env = Dependency.environment(prefix, sdk, prefixes);
  const configureOptions = ["-S", projected, "-B", output,
    ...Dependency.cmakeOptions({ prefix, sdk, ninja: tools.ninja, prefixes, pathMappings,
      options: ["-DIMPACTO_DISABLE_IMGUI=ON", "-DIMPACTO_DISABLE_VULKAN=ON", "-DIMPACTO_WARNINGS=OFF", "-DIMPACTO_DISABLE_LIBASS=ON"] }),
    "-DFETCHCONTENT_SOURCE_DIR_LIBATRAC9=" + atrac9, "-DFETCHCONTENT_SOURCE_DIR_MAGIC_ENUM=" + magicEnumSource,
    "-Dharfbuzz_DIR=" + harfbuzz.directory, "-DZLIB_LIBRARY=" + sdk + "/usr/lib/libz.tbd", "-DZLIB_INCLUDE_DIR=" + sdk + "/usr/include"];
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  const codecSource = path.join(__dirname, "ffmpeg-probe.c"), codecProbe = path.join(workRoot, "codec-probe");
  await run("/usr/bin/clang", ["-std=c11", ...Dependency.compilerFlags(sdk, pathMappings).split(" "),
    "-I" + path.join(ffmpegPrefix, "include"), codecSource, "-L" + path.join(ffmpegPrefix, "lib"),
    "-lavformat", "-lavcodec", "-lavutil", "-Wl,-rpath," + path.join(ffmpegPrefix, "lib"), "-o", codecProbe],
  { cwd: workRoot, logPath, env, signal });
  await run(codecProbe, [], { cwd: workRoot, logPath, env, signal });
  for (const args of [configureOptions, ["--build", output, "--parallel", "4"], ["--install", output]])
    await run(tools.cmake, args, { cwd: workRoot, logPath, env, signal, timeout: 20 * 60 * 1000 });
  const executable = path.join(prefix, "Impacto.app/Contents/MacOS/Impacto");
  await Portable.linkDependencyPaths(executable, [dependencyStack.prefix, ffmpegPrefix], { logPath, env, signal, dependencies });
  Portable.assertMinimumMacOS(executable);
  return { version: VERSION, profile: PROFILE, sourceRevision: REVISION,
    sourceOverlay, currentWindowsAbiProfile: ABI_PROFILE,
    executable, runtimeRoot: prefix, executableSha256: Native.hashFile(executable),
    codecProbe: { sourceSha256: Native.hashFile(codecSource), bink2Decoder: true, headerLibraryVersionsMatch: true },
    dependencyStack, configureOptions, logPath };
}

module.exports = { VERSION, SOURCES, REVISION, PROFILE, ABI_PROFILE,
  applyIdentity, applyCurrentOverlay, buildCurrentImpacto };
