const sdlHeaders=require('../../../../../dependencies/sdlHeaders.json');
const { sourceRevision } = require("../../../../../../lib/pins.mjs");
const { upstreamRevision } = require("../../../../../../lib/projects.mjs");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require('../../../../../../lib/package-format.cjs');

const UPSTREAM_VERSION = "1.9";
const VERSION = "1.9-MCLv1";
const REVISION = upstreamRevision("hashlink", "hashlink-1-9");
const SDL_REVISION = sourceRevision(sdlHeaders);
const OPENAL_REVISION = upstreamRevision("native-openal", "openal-soft");

function adaptSource(source, sdlSource) {
  const jpeg = path.join(source, "include/turbojpeg/jconfig.h"), png = path.join(source, "include/png/pngpriv.h");
  const jpegText = fs.readFileSync(jpeg, "utf8"), pngText = fs.readFileSync(png, "utf8");
  if (!jpegText.includes("#\tdefine WITH_SIMD") || !pngText.includes("|| defined(TARGET_OS_MAC)")) throw new Error("HashLink 1.9 source files do not match the Mac build adapter.");
  fs.writeFileSync(jpeg, jpegText.replace("#\tdefine WITH_SIMD", "/* Portable Mac build uses the bundled non-SIMD JPEG implementation. */"));
  // TARGET_OS_MAC denotes classic Mac in this old bundled PNG source. Modern
  // Apple's SDK also defines it; its C math interface is math.h, not fp.h.
  fs.writeFileSync(png, pngText.replace(" || defined(TARGET_OS_MAC)", ""));
  fs.copyFileSync(path.resolve(__dirname, "../overlays/native-1.9.cmake"), path.join(source, "CMakeLists.txt"));
  const headers = path.join(source, "include/SDL2"); fs.mkdirSync(headers, { recursive: true });
  for (const name of fs.readdirSync(path.join(sdlSource, "include"))) {
    if (name.endsWith(".h")) fs.copyFileSync(path.join(sdlSource, "include", name), path.join(headers, name));
  }
  return crypto.createHash("sha256").update(Native.hashFile(jpeg)).update(Native.hashFile(png))
    .update(Native.hashFile(path.join(source, "CMakeLists.txt"))).digest("hex");
}

module.exports = { adaptSource, VERSION, UPSTREAM_VERSION, REVISION, SDL_REVISION, OPENAL_REVISION };
