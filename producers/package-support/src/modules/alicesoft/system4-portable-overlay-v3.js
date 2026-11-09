const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const VERSION = "xsystem4-macos-resources-v3";
const SOURCE_FILES = ["meson.build", "meson_options.txt", "src/meson.build", "src/video.c", "src/text.c", "src/util.c", "include/xsystem4.h", "subprojects/libsys4/meson.build"];
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function replace(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("xsystem4 source differs from the selected Mac adapter.");
  return source.replace(before, after);
}

const RESOURCE_FUNCTION = `// Runtime-owned assets follow the real executable; game files stay separate.
bool xsys4_resource_path(char *output, size_t capacity, const char *relative)
{
\tif (!output || !capacity || !relative || !*relative || *relative == '/' || strchr(relative, '\\\\'))
\t\treturn false;
\tfor (const char *part = relative; *part;) {
\t\tconst char *end = strchr(part, '/');
\t\tsize_t size = end ? (size_t)(end - part) : strlen(part);
\t\tif (!size || (size == 1 && part[0] == '.') || (size == 2 && part[0] == '.' && part[1] == '.'))
\t\t\treturn false;
\t\tif (!end) break;
\t\tpart = end + 1;
\t\tif (!*part) return false;
\t}
\tchar executable[PATH_MAX], resolved[PATH_MAX];
\tuint32_t length = sizeof(executable);
\tif (_NSGetExecutablePath(executable, &length) != 0 || !realpath(executable, resolved))
\t\treturn false;
\tchar *separator = strrchr(resolved, '/');
\tif (!separator) return false;
\t*separator = '\\0';
\tint length_written = snprintf(output, capacity, "%s/../share/xsystem4/%s", resolved, relative);
\treturn length_written >= 0 && (size_t)length_written < capacity;
}
`;

function adapt(file, bytes, { version = "MCLv1-1021" } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) throw new Error("Invalid xsystem4 runtime version.");
  let source = bytes.toString("utf8");
  if (file === "meson.build") {
    source = replace(source, "add_project_arguments('-DXSYS4_DATA_DIR=\"' + get_option('prefix') / get_option('datadir') / 'xsystem4\"', language : 'c')", "add_project_arguments('-DXSYS4_DATA_DIR=\"\"', language : 'c')");
    source = replace(source, "gl = dependency('GL')", "gl = dependency('appleframeworks', modules : ['OpenGL'])");
    for (const name of ["libavcodec", "libavformat", "libavutil", "libswscale"]) {
      const expression = new RegExp(`(dependency\\('${name}'[^\\n]*required:) false`);
      if (!expression.test(source)) throw new Error("xsystem4 movie dependency adapter differs.");
      source = source.replace(expression, "$1 get_option('ffmpeg')");
    }
    for (const [name, option] of [["chibi-scheme", "scheme"], ["readline", "readline"]]) source = replace(source,
      `dependency('${name}', required : false, static : static_libs)`,
      `dependency('${name}', required : get_option('${option}'), static : static_libs, method : 'pkg-config')`);
    for (const name of ["zlib", "sdl2", "freetype2", "libffi", "libturbojpeg", "libwebp", "libpng", "sndfile"]) source = replace(source,
      `dependency('${name}', static : static_libs)`, `dependency('${name}', static : static_libs, method : 'pkg-config')`);
    source = replace(source, "dependency('cglm', version : '>=0.9.2', fallback : ['cglm', 'cglm_dep'])", "dependency('cglm', version : '>=0.9.2', method : 'pkg-config')");
    source = replace(source, "dependency('glew')", "dependency('glew', method : 'pkg-config')");
  } else if (file === "meson_options.txt") {
    source += "\noption('ffmpeg', type : 'feature', value : 'enabled', description : 'Pinned movie decoder profile')\noption('scheme', type : 'feature', value : 'disabled', description : 'Optional Scheme debugger')\noption('readline', type : 'feature', value : 'disabled', description : 'Optional readline debugger')\n";
  } else if (file === "src/meson.build") {
    source = replace(source, "fallback : 'unknown version'", `fallback : '${version}'`);
  } else if (file === "subprojects/libsys4/meson.build") {
    source = replace(source, "dependency('libdeflate', required: false, static : static_libs)", "dependency('libdeflate', required: false, static : static_libs, method : 'pkg-config')");
    for (const name of ["zlib", "libturbojpeg", "libwebp", "libpng"]) source = replace(source,
      `dependency('${name}', static : static_libs)`, `dependency('${name}', static : static_libs, method : 'pkg-config')`);
  } else if (file === "src/video.c") {
    source = replace(source, '"#version 140\\n"', '"#version 150\\n"');
    source = replace(source, "SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 1);", "SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 2);");
    const start = source.indexOf("\tGLchar *source = SDL_LoadFile(path, NULL);"), end = source.indexOf("\treturn source;", start);
    if (start < 0 || end < start) throw new Error("xsystem4 shader adapter differs.");
    source = source.slice(0,start) + "\tchar full_path[PATH_MAX];\n\tGLchar *source = NULL;\n\tif (xsys4_resource_path(full_path, sizeof(full_path), path))\n\t\tsource = SDL_LoadFile(full_path, NULL);\n\tif (!source) source = SDL_LoadFile(path, NULL);\n\tif (!source) ERROR(\"Failed to load shader file %s\", path);\n" + source.slice(end);
  } else if (file === "src/text.c") {
    source = replace(source, "\tstruct font *font;\n\t// user specified font", "\tstruct font *font;\n\tchar runtime_font[4096];\n\t// user specified font");
    source = replace(source, "\tif ((font = ft_font_load(default_font_paths[type])))", "\tif (xsys4_resource_path(runtime_font, sizeof(runtime_font), local_font_paths[type]) && (font = ft_font_load(runtime_font)))\n\t\treturn font;\n\tif ((font = ft_font_load(default_font_paths[type])))");
  } else if (file === "src/util.c") {
    source = replace(source, "#include <ctype.h>\n", "#include <ctype.h>\n#include <limits.h>\n#include <mach-o/dyld.h>\n");
    source = replace(source, "char *unix_path(const char *path)\n", RESOURCE_FUNCTION + "\nchar *unix_path(const char *path)\n");
  } else if (file === "include/xsystem4.h") {
    source = replace(source, "char *savedir_path(const char *path);", "char *savedir_path(const char *path);\nbool xsys4_resource_path(char *output, size_t capacity, const char *relative);");
  }
  return Buffer.from(source);
}

function apply(sourceRoot, { sourceDir = path.resolve(__dirname, "../../external/xsystem4"), version } = {}) {
  if (!path.isAbsolute(sourceRoot || "") || !path.isAbsolute(sourceDir || "")) throw new Error("xsystem4 source directories must be absolute.");
  const output = fs.realpathSync(sourceRoot), original = fs.realpathSync(sourceDir);
  if (output === original || output.startsWith(original + path.sep) || original.startsWith(output + path.sep)) throw new Error("xsystem4 adapters require a separate writable source copy.");
  const changes = [];
  for (const relative of SOURCE_FILES) {
    const file = path.join(output, relative);
    if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(output + path.sep)) throw new Error("xsystem4 adapter inputs must be contained regular files.");
    const bytes = adapt(relative, fs.readFileSync(file), { version });
    changes.push({ file, bytes, relative, sourceSha256: digest(fs.readFileSync(file)) });
  }
  for (const change of changes) fs.writeFileSync(change.file, change.bytes);
  return { version: VERSION, files: changes.map(({relative,sourceSha256})=>({path:relative,sourceSha256})) };
}
module.exports = { VERSION, SOURCE_FILES, RESOURCE_FUNCTION, adapt, apply };
