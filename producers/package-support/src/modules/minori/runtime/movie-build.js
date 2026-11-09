const {addLicenses} = require('../../../../../../lib/licenses.mjs');
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Build = require("../../shared/runtime/pinned-native-build");
const Native = require('../../../../../../lib/package-format.cjs');
const { version, url, sha256 } = require("../../shared/runtime/portable-ffmpeg.json").source;
const SOURCE = Object.freeze({ version, url, sha256 });
const DECODERS = Object.freeze(["mpeg1video", "mpeg2video", "mpeg4", "msmpeg4v1", "msmpeg4v2", "msmpeg4v3",
  "wmv1", "wmv2", "wmv3", "vc1", "h264", "mjpeg", "png", "rawvideo", "cinepak", "indeo3", "indeo5",
  "aac", "mp3", "wmav1", "wmav2", "wmapro", "wmalossless", "wmavoice", "vorbis",
  "pcm_s16le", "pcm_s16be", "pcm_f32le", "adpcm_ima_wav", "adpcm_ms"]);
const DEMUXERS = Object.freeze(["asf", "avi", "mov", "mpegps", "mpegts", "ogg", "wav", "matroska"]);
const OPTIONS = Object.freeze(["--cc=clang", "--target-os=darwin", "--enable-shared", "--disable-static", "--enable-pic",
  "--disable-doc", "--disable-debug", "--disable-autodetect", "--disable-gpl", "--disable-nonfree", "--disable-version3",
  "--disable-everything", "--disable-programs", "--disable-network", "--disable-avdevice", "--disable-avfilter", "--enable-zlib",
  "--enable-decoder=" + DECODERS.join(","), "--enable-demuxer=" + DEMUXERS.join(","),
  "--enable-parser=h264,mpeg4video,mpegaudio,mpegvideo,vc1,vorbis,aac", "--enable-protocol=file"]);
function normalizeDiagnostics(directory, mappings) {
  const file = path.join(directory, "config.h"), original = fs.readFileSync(file, "utf8");
  let found = false;
  const text = original.replace(/^#define FFMPEG_CONFIGURATION (.*)$/m, (_line, value) => {
    found = true; for (const from of mappings) value = value.split(from).join("maclauncher-build/minori/movie");
    if (/\/(?:Users|Volumes|home)\/|\.local\//.test(value)) throw new Error("Minori movie diagnostics retain a private build path.");
    return "#define FFMPEG_CONFIGURATION " + value;
  });
  if (!found) throw new Error("The FFmpeg configuration diagnostic is missing.");
  fs.writeFileSync(file, text); return { path: "config.h", sha256: Native.hashFile(file) };
}
async function buildMovieDependencies({ archive, destination, workspace, architecture = process.arch, signal, dependencies = {} } = {}) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(architecture)) throw new Error("Minori movie dependencies require a supported Mac architecture.");
  if (!path.isAbsolute(archive || "")) throw new Error("Minori movie dependencies require the FFmpeg 7.1.2 source archive.");
  if (!path.isAbsolute(destination || "") || fs.existsSync(destination)) throw new Error("Choose a new Minori movie dependency directory.");
  // A recipe builds in a new directory inside its own work directory; other callers use a temporary one.
  if (workspace === undefined) workspace = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-minori-movie-"));
  else if (!path.isAbsolute(workspace) || fs.existsSync(workspace)) throw new Error("Choose a new Minori movie build directory.");
  else fs.mkdirSync(workspace, { recursive: true });
  const output = path.join(workspace, "output"), prefix = path.join(workspace, "install"), logPath = path.join(workspace, "build.log");
  fs.mkdirSync(output); fs.writeFileSync(logPath, `FFmpeg ${SOURCE.version} ${SOURCE.sha256}\n`);
  const mappings = [...new Set([workspace, fs.realpathSync(workspace)])];
  const flags = ["-arch " + (architecture === "x64" ? "x86_64" : architecture), "-mmacosx-version-min=13.0", ...mappings.flatMap(from => [`-ffile-prefix-map=${from}=maclauncher-build/minori/movie`, `-fmacro-prefix-map=${from}=maclauncher-build/minori/movie`])].join(" ");
  const run = dependencies.runBuildCommand || Build.runBuildCommand;
  const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0" };
  await run("/usr/bin/tar", ["-xf", archive, "-C", workspace], { cwd: workspace, logPath, env, signal });
  const sourceRoot = path.join(workspace, "ffmpeg-" + SOURCE.version);
  const options = [`--prefix=${prefix}`, `--arch=${architecture === "arm64" ? "arm64" : "x86_64"}`, ...OPTIONS,
    "--extra-cflags=" + flags, "--extra-ldflags=-mmacosx-version-min=13.0 -arch " + (architecture === "x64" ? "x86_64" : architecture)];
  await run(path.join(sourceRoot, "configure"), options, { cwd: output, logPath, env, signal });
  const diagnostics = normalizeDiagnostics(output, mappings);
  await run("/usr/bin/make", ["-j6"], { cwd: output, logPath, env, signal });
  await run("/usr/bin/make", ["install"], { cwd: output, logPath, env, signal });
  addLicenses(prefix,'FFmpeg',sourceRoot);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(prefix, destination, { recursive: true, force: false, errorOnExist: true });
  const receipt = { source: SOURCE, decoders: DECODERS, demuxers: DEMUXERS, options, diagnostics, workspace, prefix: destination,
    sourceRoot, architecture, minimumMacOS: "13.0", network: false, externalCodecs: false, gpl: false, nonfree: false };
  fs.writeFileSync(path.join(destination, "minori-movie-source.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}
module.exports = { SOURCE, DECODERS, DEMUXERS, OPTIONS, normalizeDiagnostics, buildMovieDependencies };
