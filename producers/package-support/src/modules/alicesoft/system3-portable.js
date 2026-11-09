const {upstreamRevision} = require("../../../../../lib/projects.mjs");
const fs = require("node:fs");
const path = require("node:path");
const Source = require("../shared/runtime/pinned-native-build");
const Native = require('../../../../../lib/package-format.cjs');
const Fonts = require("../shared/runtime/portable-sdl2-fonts");
const Resources = require("./system3-resource-overlay");
const Prefix = require("../shared/runtime/portable-dependency-prefix");

const VERSION = "1.8.0-MCLv1";
const REVISION = upstreamRevision("system3", "system3-sdl2");
const SOURCE_SHA256 = "7d5074ef5cce68c9f0f4246fb91f17ba8482f7ae798ddda9dd6208d8530f695c";
const sourcePath = path.resolve(__dirname, "../../external/system3-sdl2");

async function buildPortableSystem3({ sourceDir = sourcePath, archives, workRoot, fontStack, architecture = process.arch, pathMappings = [], signal, onProgress, dependencies = {} }) {
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir] });
  const source = await Source.pinnedFiles(sourceDir, REVISION, { signal });
  let stack;
  if(fontStack){
    const prefix=path.join(workRoot,"prefix");fs.mkdirSync(prefix,{recursive:true});Prefix.linkPrefix(fontStack.prefix,prefix);stack={...fontStack,prefix};
  }else stack = await Fonts.buildDependencies({ archives, workRoot, architecture, pathMappings, signal, onProgress, dependencies });
  const sourceRoot = path.join(workRoot, "system3-source");
  Source.stagePinnedFiles(sourceDir, source.files, sourceRoot);
  const sourceOverlay = Resources.apply(sourceRoot, { sourceDir });
  const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, "system3"), prefix: stack.prefix, sdk: stack.sdk,
    tools: stack.tools, architecture, pathMappings, options: ["-DSYSTEM3_SDL_VERSION=2", "-DBUILD_SHARED_LIBS=OFF"], signal, onProgress, dependencies });
  const executable = path.join(stack.prefix, "bin/system3");
  return { managerId: "system3", version: VERSION, sourceRevision: REVISION, sourceOverlay,
    architecture, minimumMacOS: "13.0", executable, executableSha256: Native.hashFile(executable), resources: path.join(stack.prefix, "share/system3"),
    ...build, dependencyClosure: stack };
}

module.exports = { VERSION, REVISION, SOURCE_SHA256, sourcePath, buildPortableSystem3 };
