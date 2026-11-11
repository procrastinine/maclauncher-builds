const fs = require("node:fs");
const path = require("node:path");
const Native = require('../../../../../lib/package-format.cjs');
const { throwIfAborted } = require('../../../../../lib/abort.cjs');

const REVISION = require("../../../../../lib/projects.mjs").upstreamRevision("krkrsdl2", "krkrsdl2");
const OVERLAY_REVISION = "macos-storage-font-monitor-v1";

function prepareSource({ sourceRoot, revision, signal }) {
  throwIfAborted(signal);
  const patches = [
    { relative: "external/krkrz/base/StorageIntf.cpp", include: "#include <dirent.h>\n#include <sys/stat.h>\n#include <cstring>\n",
      anchor: "TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/getFileProperty)", resource: "storage-dirlist.inc" },
    { relative: "external/krkrz/base/SystemIntf.cpp", include: '#include "FontSystem.h"\n#include "tjsDictionary.h"\n#include "SDL.h"\n#include <algorithm>\n#include <climits>\nextern FontSystem* TVPFontSystem;\n',
      anchor: "TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/terminate)", resource: "system-addfont.inc" }
  ];
  const files = [];
  for (const patch of patches) {
    throwIfAborted(signal);
    const file = path.join(sourceRoot, patch.relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("KiriKiri bridge accepts regular staged source files only.");
    const beforeSha256 = Native.hashFile(file), source = fs.readFileSync(file, "utf8");
    if (source.indexOf(patch.anchor) < 0 || source.indexOf(patch.anchor) !== source.lastIndexOf(patch.anchor)) throw new Error("KiriKiri bridge source anchor differs from the reviewed layout.");
    const implementation = fs.readFileSync(path.join(__dirname, "overlays", patch.resource), "utf8");
    fs.writeFileSync(file, patch.include + source.replace(patch.anchor, implementation + "\n" + patch.anchor));
    files.push({ file: patch.relative, beforeSha256, resource: patch.resource });
  }
  return { revision: OVERLAY_REVISION, upstreamRevision: REVISION, files,
    operations: ["actual local/archive directory listing", "process-local native FreeType font loading", "dialog rectangle positioning against actual SDL monitor work areas"] };
}

function applyIdentity(root) {
  const file=path.join(root,"src/core/sdl2/SDLApplication.cpp"),text=fs.readFileSync(file,"utf8"),anchor='this->window = SDL_CreateWindow("krkrsdl2", new_window_x, new_window_y, new_window_w, new_window_h, window_flags);';
  if(text.split(anchor).length!==2)throw new Error("Pinned KiriKiri initial window boundary changed.");
  fs.writeFileSync(file,text.replace(anchor,'const char *game_name = SDL_getenv("MACLAUNCHER_GAME_NAME");\n\tthis->window = SDL_CreateWindow(game_name && *game_name ? game_name : "krkrsdl2", new_window_x, new_window_y, new_window_w, new_window_h, window_flags);'));
  require("../shared/runtime/application-identity").attach(root,"krkrsdl2");
}
module.exports = { applyIdentity, REVISION, OVERLAY_REVISION, prepareSource };
