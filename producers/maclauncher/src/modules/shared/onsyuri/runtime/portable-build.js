const {gitlink}=require('../../../../../../../lib/pins.mjs');
const sharedDependencies=require('../../../../../../dependencies.json');
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../../runtime/local-native");
const metadata = require("./portable-build.json");
const revision = gitlink("producers/maclauncher/src/external/onscripter-yuri");
const PIN = Object.freeze({ ...metadata, dependencies: metadata.dependencies.map(row=>{if(row.id==='webp')row={...require('../../../alicesoft/system35-portable.json').dependencies.find(pin=>pin.id==='webp'),...row};if(row.id==='turbojpeg')row={...require('../../../alicesoft/system4-portable.json').dependencies.find(pin=>pin.id==='turbojpeg'),...row};if(row.id==='turbojpeg'){const pin=require('../../../alicesoft/system4-portable.json').dependencies.find(pin=>pin.id==='turbojpeg');return {...row,get revision(){return require('node:child_process').execFileSync('git',['-C',require('node:path').resolve(__dirname,'../../../../../../../sources/anyps5'),'rev-parse',gitlink('sources/anyps5')+':3rdparty/'+'libjpeg-turbo'],{encoding:'utf8'}).trim();},sourceUrl:pin.repository||pin.sourceUrl,get archiveUrl(){return (pin.repository||pin.sourceUrl)+'/archive/'+this.revision+'.tar.gz';},archiveSha256:pin.archiveSha256,archiveBytes:pin.archiveBytes};}const pin=sharedDependencies[row.id];return pin?{...row,revision:pin.revision,sourceUrl:pin.repository,archiveUrl:pin.url||pin.repository+'/archive/'+pin.revision+'.tar.gz',archiveSha256:pin.sha256,archiveBytes:pin.bytes}:{...row,sourceUrl:row.repository||row.sourceUrl,archiveUrl:row.archiveUrl?.replaceAll('{revision}',row.revision)};}), engine: { ...metadata.engine, revision,
  sourceUrl: `https://github.com/YuriSizuku/OnscripterYuri/tree/${revision}`,
  archiveUrl: `https://codeload.github.com/YuriSizuku/OnscripterYuri/tar.gz/${revision}` } });
const VERSION = PIN.engine.version;
const REVISION = PIN.engine.revision;
const SOURCE_SHA256 = PIN.engine.sourceTreeSha256;
const OWNED_FILES = [__filename, require.resolve("./portable-build.json"),
  require.resolve("../../../alicesoft/system35-portable.json"), require.resolve("../../../alicesoft/system4-portable.json"),
  path.join(__dirname, "portable-native/CMakeLists.txt"), path.join(__dirname, "portable-native/lua.CMakeLists.txt"),
  require.resolve("../../runtime/pinned-native-build"), require.resolve("../../runtime/portable-sdl2-fonts"), require.resolve("../../runtime/portable-sdl2-fonts.json"),
  require.resolve("../../runtime/portable-sndfile"), require.resolve("../../runtime/portable-sndfile.json"),
  require.resolve("../../runtime/portable-sdl2-mixer"), require.resolve("../../runtime/portable-sdl2-mixer.json"), require.resolve("../../runtime/portable-dependency-prefix")];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const overlayIdentity = () => hash(Buffer.concat(OWNED_FILES.map(file => fs.readFileSync(file))));

function validateEngineArchive(archives) {
  const file = archives?.onsyuri;
  if (!path.isAbsolute(file || "") || !fs.lstatSync(file).isFile() || fs.statSync(file).size !== PIN.engine.archiveBytes ||
      Native.hashFile(file) !== PIN.engine.archiveSha256) throw new Error("Yuri primary source archive checksum or size differs from its pinned version.");
}

function requireOwnedSource(sourceRoot, sourceDir) {
  if (!path.isAbsolute(sourceRoot || "") || !fs.lstatSync(sourceRoot).isDirectory() || fs.existsSync(path.join(sourceRoot, ".git"))) {
    throw new Error("Yuri adapters require a separate disposable source directory.");
  }
  const root = fs.realpathSync(sourceRoot), external = path.resolve(__dirname, "../../../../external");
  for (const input of [external, ...(sourceDir ? [fs.realpathSync(sourceDir)] : [])]) {
    if (root === input || root.startsWith(input + path.sep) || input.startsWith(root + path.sep)) throw new Error("Yuri adapters cannot change source checkouts.");
  }
}

function adaptEngine(sourceRoot, sourceDir) {
  requireOwnedSource(sourceRoot, sourceDir);
  const file = path.join(sourceRoot, "CMakeLists.txt"), original = fs.readFileSync(file);
  if (hash(original) !== PIN.engine.cmakeSha256) throw new Error("Yuri CMake source differs from its pinned version.");
  fs.copyFileSync(path.join(__dirname, "portable-native/CMakeLists.txt"), file);
  return { files: [{ path: "CMakeLists.txt", sourceSha256: hash(original), adaptedSourceSha256: Native.hashFile(file) }] };
}

function adaptLua(sourceRoot) {
  requireOwnedSource(sourceRoot);
  const file = path.join(sourceRoot, "CMakeLists.txt"), header = fs.readFileSync(path.join(sourceRoot, "src/lua.h"), "utf8");
  if (fs.existsSync(file) || !header.includes('#define LUA_VERSION_RELEASE\t"9"') || !header.includes('#define LUA_VERSION_MINOR\t"4"')) {
    throw new Error("Lua source differs from the selected 5.4.9 profile.");
  }
  fs.copyFileSync(path.join(__dirname, "portable-native/lua.CMakeLists.txt"), file);
  return { files: [{ path: "CMakeLists.txt", sourceSha256: null, adaptedSourceSha256: Native.hashFile(file) }] };
}

function validateFeatures(outputRoot) {
  const commands = fs.readFileSync(path.join(outputRoot, "sdl2_image/compile_commands.json"), "utf8");
  for (const name of ["LOAD_PNG", "LOAD_JPG", "LOAD_WEBP"]) if (!commands.includes(name)) throw new Error(`Yuri image library did not enable ${name}.`);
  if (/LOAD_(?:PNG|JPG|WEBP|AVIF|JXL|TIF)_DYNAMIC/.test(commands)) throw new Error("Yuri image library enabled an unselected dynamic codec.");
  const engine = fs.readFileSync(path.join(outputRoot, "onsyuri/compile_commands.json"), "utf8");
  for (const name of ["USE_LUA", "USE_BUILTIN_LAYER_EFFECTS", "ENABLE_1BYTE_CHAR", "USE_PARALLEL"]) if (!engine.includes(name)) throw new Error(`Yuri native host did not enable ${name}.`);
  if (engine.includes("USE_GLES") || engine.includes("renderer/gles_renderer.cpp")) throw new Error("Yuri macOS build enabled the excluded GLES sharpness path.");
  return { imageFormats: ["BMP", "GIF", "JPEG", "LBM", "PCX", "PNG", "PNM", "QOI", "SVG", "TGA", "WebP", "XCF", "XPM", "XV"],
    imageFormatsExcluded: ["AVIF", "JPEG XL", "TIFF"], lua: "5.4.9", renderer: "SDL automatic", dynamicCodecLoading: false,
    moviePlayback: false, externalWindowsPlugins: false, glesSharpness: false };
}

module.exports = { PIN, VERSION, REVISION, SOURCE_SHA256, OWNED_FILES, overlayIdentity, validateEngineArchive,
  requireOwnedSource, adaptEngine, adaptLua, validateFeatures };
