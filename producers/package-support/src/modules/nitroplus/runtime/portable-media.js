const {addLicenses} = require('../../../../../../lib/licenses.mjs');
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require('../../../../../../lib/package-format.cjs');
const Portable = require("../../shared/runtime/portable-sdl2-fonts");
const { throwIfAborted } = require('../../../../../../lib/abort.cjs');
// A utility without its own archive record uses the shared declaration of that library.
const shared = id => require("../../../../../dependencies/" + id + ".json"), media = require("./portable-media.json");
const PIN = Object.freeze({ ...media, utilitySources: media.utilitySources.map(row => row.archiveSha256 ? row :
  { ...row, archiveUrl: shared(row.id).url, archiveSha256: shared(row.id).sha256, archiveBytes: shared(row.id).bytes }) });
function validateSDKPrefix(prefix) {
  return { version: PIN.version, prefix, architecture: PIN.architecture, minimumMacOS: PIN.minimumMacOS };
}

function buildEnvironment(prefix, sdk) {
  const env = Portable.buildEnvironment(prefix, sdk);
  for (const key of Object.keys(env)) if (key.startsWith("DYLD_") || key.startsWith("GST_")) delete env[key];
  return env;
}

async function unpackSDK({ archive, workRoot, signal, dependencies = {} }) {
  throwIfAborted(signal);
  if (!path.isAbsolute(archive || "") || !fs.lstatSync(archive).isFile() || fs.lstatSync(archive).isSymbolicLink() ||
      fs.statSync(archive).size !== PIN.sdkArchive.bytes || Native.hashFile(archive) !== PIN.sdkArchive.sha256) {
    throw new Error("Nitroplus media SDK archive checksum changed.");
  }
  workRoot = Portable.assertFreshBuildRoot(workRoot, { readOnlyRoots: [path.dirname(archive)] });
  fs.mkdirSync(workRoot, { recursive: true });
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
  await (dependencies.runBuildCommand || Source.runBuildCommand)("/usr/bin/tar", ["-xf", archive, "-C", workRoot],
    { cwd: workRoot, env: buildEnvironment(workRoot, sdk), logPath: path.join(path.dirname(workRoot), "media-sdk-extraction.log"), signal });
  return validateSDKPrefix(workRoot);
}

async function buildUtilities({ archives, workRoot, signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This Nitroplus dependency profile builds on Apple Silicon Macs.");
  for (const pin of PIN.utilitySources) {
    const file = archives?.[pin.id];
    if (!path.isAbsolute(file || "") || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() ||
        fs.statSync(file).size !== pin.archiveBytes || Native.hashFile(file) !== pin.archiveSha256) throw new Error(`Nitroplus ${pin.id} source archive checksum changed.`);
  }
  workRoot = Portable.assertFreshBuildRoot(workRoot, { readOnlyRoots: Object.values(archives || {}).map(file => path.dirname(file)) });
  if (/[\s'"$`\\]/.test(workRoot)) throw new Error("Nitroplus dependency builds require a path without spaces or shell metacharacters.");
  fs.mkdirSync(workRoot, { recursive: true });
  const prefix = path.join(workRoot, "prefix"); fs.mkdirSync(prefix);
  const sdk = (dependencies.readSDK || (() => execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim()))();
  const tool = dependencies.findBuildTool || Source.findBuildTool, tools = { cmake: tool("cmake"), ninja: tool("ninja") };
  const env = buildEnvironment(prefix, sdk), run = dependencies.runBuildCommand || Source.runBuildCommand;
  const builds = [], pathMappings = [{ from: workRoot, to: "NPENGINE_UTILITY_BUILD_ROOT" }];
  for (const pin of PIN.utilitySources) {
    throwIfAborted(signal);
    const sourceRoot = path.join(workRoot, "source-" + pin.id); fs.mkdirSync(sourceRoot);
    await run("/usr/bin/tar", ["-xf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot], { cwd: workRoot, env, logPath: path.join(workRoot, "extract.log"), signal });
    onProgress?.({ phase: "build", project: pin.id }); let build;
    if (pin.id === "boost") {
      const flags = `-O2 -arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk} -ffile-prefix-map=${workRoot}=NPENGINE_UTILITY_BUILD_ROOT -fdebug-prefix-map=${workRoot}=NPENGINE_UTILITY_BUILD_ROOT -fmacro-prefix-map=${workRoot}=NPENGINE_UTILITY_BUILD_ROOT -Werror=unguarded-availability-new`;
      const linkFlags = `-arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk} -Wl,-headerpad_max_install_names -Wl,-rpath,${prefix}/lib`;
      const config = path.join(workRoot, "boost-user-config.jam"), logPath = path.join(workRoot, "boost.log");
      fs.writeFileSync(config, `using clang : mac13 : /usr/bin/clang++ : <cxxflags>"${flags}" <linkflags>"${linkFlags}" ;\n`);
      const bootstrap = ["--with-toolset=clang", "--with-libraries=locale", "--without-icu", `--prefix=${prefix}`];
      await run(path.join(sourceRoot, "bootstrap.sh"), bootstrap, { cwd: sourceRoot, env, logPath, signal });
      const options = [`--user-config=${config}`, "toolset=clang-mac13", "target-os=darwin", "architecture=arm", "address-model=64", "variant=release", "link=shared", "threading=multi", "runtime-link=shared", "boost.locale.icu=off", "boost.locale.iconv=on", "boost.locale.posix=on", "boost.locale.std=on", `--prefix=${prefix}`, "--with-locale", "-j2", "install"];
      await run(path.join(sourceRoot, "b2"), options, { cwd: sourceRoot, env, logPath, signal, timeout: 20 * 60 * 1000 });
      build = { configureOptions: bootstrap, buildOptions: options, compilerOptions: flags, linkerOptions: linkFlags, logPath };
    } else {
      const options = ["-DBUILD_UTILS=OFF", "-DBUILD_FRAMEWORK=OFF", "-DGLEW_X11=OFF", "-DGLEW_EGL=OFF", "-DGLEW_OSMESA=OFF", "-DGLEW_REGAL=OFF"];
      build = await Portable.buildProject({ sourceRoot: path.join(sourceRoot, "build/cmake"), outputRoot: path.join(workRoot, pin.id), prefix, sdk, tools, pathMappings, options, signal,
        dependencies: { ...dependencies, runBuildCommand: (command, args, options) => run(command, args, { ...options, env }) } });
    }
    addLicenses(prefix,pin.id,sourceRoot);
    builds.push({ ...pin, sourceRoot, ...build });
  }
  return { version: "boost-glew-macos13-v1", architecture: "arm64", minimumMacOS: "13.0", prefix, sdk, tools, sources: builds };
}
module.exports = { PIN, validateSDKPrefix, buildEnvironment, unpackSDK, buildUtilities };
