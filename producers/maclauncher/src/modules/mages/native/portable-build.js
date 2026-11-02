const fs = require("node:fs");
const path = require("node:path");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const MachO = require("../../shared/runtime/macho-load-commands");
const Dependency = require("./portable-dependencies");
const Existing = require("./build");

const FFMPEG_ARCHIVE_BYTES = 11030368;

function assertMinimumMacOS(file, maximum = "13.0") {
  const info = MachO.readMachOLoadCommands(file, { architecture: "arm64" });
  if (info.slices.length !== 1 || info.slices[0].platform !== 1 || !info.slices[0].minimumMacOS) throw new Error("Impacto build requires an ARM macOS executable or library.");
  const compare = (a, b) => {
    const left = a.split(".").map(Number), right = b.split(".").map(Number);
    for (let index = 0; index < 3; index++) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
    return 0;
  };
  if (compare(info.slices[0].minimumMacOS, maximum) > 0) throw new Error(`Impacto library requires macOS ${info.slices[0].minimumMacOS}, above ${maximum}.`);
  return { file, sha256: Native.hashFile(file), ...info.slices[0] };
}

function ffmpegOptions({ prefix, sdk, pathMappings = [] }) {
  if (!path.isAbsolute(prefix || "") || /[\s'"$`\\\r\n\0;]/.test(prefix)) throw new Error("FFmpeg build prefix must be an absolute path without shell metacharacters.");
  const flags = Dependency.compilerFlags(sdk, pathMappings);
  return [`--prefix=${prefix}`, "--arch=arm64", ...Existing.FFMPEG_OPTIONS.filter(option => !option.startsWith("--extra-cflags=") && !option.startsWith("--extra-ldflags=")),
    `--extra-cflags=${flags}`, `--extra-ldflags=-arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk} -Wl,-headerpad_max_install_names`];
}

function writeHarfBuzzDescriptor(directory, version) {
  if (!path.isAbsolute(directory || "") || /[\r\n\0;]/.test(directory) || !/^\d+\.\d+\.\d+$/.test(version || "")) {
    throw new Error("HarfBuzz build metadata requires an absolute output and exact version.");
  }
  fs.mkdirSync(directory, { recursive: true });
  // The source-build export omits its include prefix. Its verified pkg-config
  // descriptor contains the installed headers and the same shared library.
  const contents = `include(CMakeFindDependencyMacro)\nfind_dependency(PkgConfig REQUIRED)\npkg_check_modules(MACLAUNCHER_HARFBUZZ REQUIRED IMPORTED_TARGET GLOBAL harfbuzz=${version})\nif(NOT TARGET harfbuzz::harfbuzz)\n  add_library(harfbuzz::harfbuzz ALIAS PkgConfig::MACLAUNCHER_HARFBUZZ)\nendif()\n`;
  const file = path.join(directory, "harfbuzzConfig.cmake");
  fs.writeFileSync(file, contents, { flag: "wx" });
  return { version, directory, sha256: Native.hashFile(file), descriptor: "pkg-config" };
}

async function linkDependencyPaths(executable, prefixes, { logPath, env, signal, dependencies = {} } = {}) {
  if (!path.isAbsolute(executable || "") || fs.lstatSync(executable).isSymbolicLink() || !fs.lstatSync(executable).isFile() ||
      !Array.isArray(prefixes) || !prefixes.length || prefixes.some(prefix => !path.isAbsolute(prefix || "") || /[\r\n\0;]/.test(prefix))) {
    throw new Error("Impacto dependency linking requires its owned executable and explicit library prefixes.");
  }
  const existing = MachO.readMachOLoadCommands(executable, { architecture: "arm64" }).slices[0].runPaths;
  const paths = [...new Set(prefixes.map(prefix => path.join(prefix, "lib")))];
  for (const directory of paths) if (!fs.statSync(directory).isDirectory()) throw new Error("Impacto dependency library directory is unavailable.");
  const beforeSha256 = Native.hashFile(executable), commands = [];
  for (const directory of paths) {
    if (existing.includes(directory)) continue;
    const args = ["-add_rpath", directory, executable];
    await (dependencies.runBuildCommand || Source.runBuildCommand)("/usr/bin/install_name_tool", args,
      { cwd: path.dirname(executable), logPath, env, signal });
    commands.push(args);
  }
  return { beforeSha256, sha256: Native.hashFile(executable), paths, commands };
}

module.exports = { FFMPEG_ARCHIVE_BYTES, assertMinimumMacOS, ffmpegOptions, writeHarfBuzzDescriptor, linkDependencyPaths };
