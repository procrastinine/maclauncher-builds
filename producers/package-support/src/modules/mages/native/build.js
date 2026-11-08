const fs = require("node:fs");
const path = require("node:path");
const Adapter = require("./adapter");

const FFMPEG_OPTIONS = Object.freeze(["--cc=clang", "--target-os=darwin", "--enable-shared", "--disable-static",
  "--enable-pic", "--disable-doc", "--disable-debug", "--disable-autodetect", "--disable-gpl", "--disable-nonfree",
  "--disable-version3", "--disable-everything", "--enable-decoder=bink,bink2,binkaudio_dct,binkaudio_rdft,vorbis,pcm_s16le",
  "--enable-demuxer=bink,ogg,wav", "--enable-parser=vorbis", "--enable-protocol=file", "--enable-encoder=rawvideo",
  "--enable-muxer=rawvideo,null", "--disable-avdevice", "--disable-avfilter", "--disable-network",
  "--extra-cflags=-mmacosx-version-min=13.0", "--extra-ldflags=-mmacosx-version-min=13.0"]);

function diagnosticPathMappings(workDir, dependencyPrefix) {
  const pairs = [[path.resolve(workDir), "IMPACTO_BUILD"], [fs.realpathSync(workDir), "IMPACTO_BUILD"],
    [path.resolve(dependencyPrefix), "DEPENDENCY_PREFIX"], [fs.realpathSync(dependencyPrefix), "DEPENDENCY_PREFIX"]];
  return [...new Map(pairs.map(([from, to]) => [from, { from, to }])).values()].sort((a, b) => b.from.length - a.from.length);
}

function compilerDiagnosticFlags(mappings) {
  return mappings.flatMap(({ from, to }) => [`-ffile-prefix-map=${from}=${to}`, `-fmacro-prefix-map=${from}=${to}`]);
}

function normalizeGeneratedFfmpegConfiguration(outputDir, mappings) {
  const file = path.join(outputDir, "config.h"), original = fs.readFileSync(file, "utf8");
  let found = false;
  const normalized = original.replace(/^#define FFMPEG_CONFIGURATION (.*)$/m, (_line, value) => {
    found = true;
    const projected = mappings.reduce((text, { from, to }) => text.split(from).join(to), value);
    if (/\/(?:Users|Volumes|home)\/|(?:^|[\\/])\.local[\\/]/.test(projected)) throw new Error("FFmpeg diagnostic configuration retains a private build path.");
    return "#define FFMPEG_CONFIGURATION " + projected;
  });
  if (!found) throw new Error("Generated FFmpeg configuration macro is unavailable.");
  const originalSha256 = Adapter.hash(file);
  fs.writeFileSync(file, normalized);
  return { generatedFile: "config.h", macro: "FFMPEG_CONFIGURATION", originalSha256, normalizedSha256: Adapter.hash(file),
    mappings: mappings.map(mapping => ({ ...mapping })) };
}

module.exports = { FFMPEG_OPTIONS, diagnosticPathMappings, compilerDiagnosticFlags, normalizeGeneratedFfmpegConfiguration };
