const fs = require("node:fs");
const path = require("node:path");

const VERSION = "1.5.0-macos-v2";
const LEGACY_VERSION = "1.5.0-macos-v1";
const REVISION = "1dfe835ceff2ecd62aa75ced91f11450dd75d1d2";
const sourcePath = path.resolve(__dirname, "../../../external/ai5-sdl2");

function replace(file, before, after) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Pinned AI5 overlay differs in ${path.basename(file)}.`);
  fs.writeFileSync(file, text.replace(before, after));
}

function adaptSource(root) {
  const savedata = path.join(root, "src/savedata.c"), gfx = path.join(root, "src/gfx.c");
  replace(path.join(root, "src/main.c"), "#include <unistd.h>", "#include <unistd.h>\n#include <limits.h>");
  replace(path.join(root, "src/main.c"), "config->title = sjis_cstring_to_utf8(value, strlen(value));",
    'config->title = getenv("MACLAUNCHER_AI5_INI") ? strdup(value) : sjis_cstring_to_utf8(value, strlen(value));');
  replace(path.join(root, "src/main.c"), "if (ini_parse(ini_name, cfg_handler, &config) < 0)",
    'const char *launcher_ini = getenv("MACLAUNCHER_AI5_INI");\n\tif (ini_parse(launcher_ini && launcher_ini[0] ? launcher_ini : ini_name, cfg_handler, &config) < 0)');
  replace(path.join(root, "src/main.c"), "config.exe_path = path_get_icase(exe_name);",
    'const char *launcher_original_exe = getenv("MACLAUNCHER_AI5_ORIGINAL_EXE");\n\tconfig.exe_path = path_get_icase(launcher_original_exe && launcher_original_exe[0] ? launcher_original_exe : exe_name);');
  // Loose files are tagged <none> by upstream's asset_fs_load. Its debugger
  // classifier otherwise calls strcasecmp(NULL, ...), even in release builds.
  replace(path.join(root, "src/debug.c"), "static enum file_type filename_to_type(const char *filename)\n{",
    "static enum file_type filename_to_type(const char *filename)\n{\n\tif (!filename || !file_extension(filename))\n\t\treturn FILE_OTHER;");
  // A loose CG's extension selects its decoder. Keep the requested name in
  // the same allocation as its synthetic archive_data, so normal release
  // frees both without adding lifetime rules or changing archive data.
  replace(path.join(root, "src/asset.c"),
    'struct archive_data *file = xcalloc(1, sizeof(struct archive_data));\n\tfile->size = size;\n\tfile->name = "<none>";',
    'struct archive_data *file = xcalloc(1, sizeof(struct archive_data) + strlen(_name) + 1);\n\tfile->size = size;\n\tfile->name = (char*)(file + 1);\n\tstrcpy(file->name, _name);');
  const assets = path.join(root, "src/asset.c");
  replace(assets, 'static struct archive *arc[NR_ASSET_TYPES] = {0};',
    'static struct archive *arc[NR_ASSET_TYPES] = {0};\nstatic struct archive *base_arc[NR_ASSET_TYPES] = {0};');
  replace(assets, '\nvoid asset_init(void)\n{', `
struct archive_data *asset_fs_load(const char *name);

static struct archive_data *asset_archive_get(unsigned type, const char *name)
{
	struct archive_data *file = arc[type] ? archive_get(arc[type], name) : NULL;
	if (!file && base_arc[type]) file = archive_get(base_arc[type], name);
	if (!file && (type == ASSET_BG || type == ASSET_MES || type == ASSET_DATA || type == ASSET_BGM || type == ASSET_EFFECT))
		file = asset_fs_load(name);
	return file;
}

void asset_init(void)
{`);
  replace(assets, '\n\tcg_cache_init();\n}', `
	const struct { unsigned type; const char *variable; unsigned flags; } bases[] = {
		{ ASSET_BG, "MACLAUNCHER_AI5_BG_BASE", typ_flags },
		{ ASSET_MES, "MACLAUNCHER_AI5_MES_BASE", mes_flags },
		{ ASSET_DATA, "MACLAUNCHER_AI5_DATA_BASE", data_flags },
		{ ASSET_BGM, "MACLAUNCHER_AI5_BGM_BASE", typ_flags },
		{ ASSET_EFFECT, "MACLAUNCHER_AI5_EFFECT_BASE", typ_flags }
	};
	for (unsigned i = 0; i < sizeof(bases)/sizeof(bases[0]); i++) {
		const char *name = getenv(bases[i].variable);
		if (!name || !*name) continue;
		struct archive *base = open_arc(name, bases[i].flags);
		if (!base) ERROR("Failed to open reviewed base archive %s", name);
		if (arc[bases[i].type]) base_arc[bases[i].type] = base;
		else arc[bases[i].type] = base;
	}
	cg_cache_init();
}`);
  replace(assets, '\n\t\tif (arc[i]) {', '\n\t\tif (base_arc[i]) archive_close(base_arc[i]);\n\t\tif (arc[i]) {');
  let assetText = fs.readFileSync(assets, "utf8");
  if (!assetText.includes("archive_get(arc[ASSET_BG], name)")) throw new Error("Pinned AI5 archive lookup overlay differs.");
  assetText = assetText.replace(/archive_get\(arc\[(ASSET_[A-Z0-9]+|t)\], name\)/g, "asset_archive_get($1, name)");
  fs.writeFileSync(assets, assetText);
  replace(assets, '\nstruct archive_data *asset_fs_load(const char *_name)\n{', `
static char *maclauncher_ai5_asset_path(const char *name)
{
	char *path = path_get_icase(name);
	const char *auxiliary = getenv("MACLAUNCHER_AI5_AUX_ROOT");
	if (!path && auxiliary && auxiliary[0] == '/' && name[0] != '/' && !strstr(name, "..")) {
		char *full = xmalloc(strlen(auxiliary) + strlen(name) + 2);
		sprintf(full, "%s/%s", auxiliary, name);
		path = path_get_icase(full);
		free(full);
	}
	return path;
}

struct archive_data *asset_fs_load(const char *_name)
{`);
  assetText = fs.readFileSync(assets, "utf8");
  const fsStart = assetText.indexOf("struct archive_data *asset_fs_load(const char *_name)"), fsEnd = assetText.indexOf("struct archive_data *asset_mes_load(", fsStart);
  const loose = assetText.slice(fsStart, fsEnd);
  if (loose.split("path_get_icase(name)").length !== 3) throw new Error("Pinned AI5 loose path overlay differs.");
  fs.writeFileSync(assets, assetText.slice(0, fsStart) + loose.replaceAll("path_get_icase(name)", "maclauncher_ai5_asset_path(name)") + assetText.slice(fsEnd));
  replace(assets, 'if (!path && !strcasecmp(file_extension(name), "wav")) {',
    'if (!path && file_extension(name) && !strcasecmp(file_extension(name), "wav")) {');
  const archiveOpen = path.join(root, "subprojects/libai5/src/arc/open.c");
  replace(archiveOpen, '#include "ai5/game.h"', '#include "ai5/game.h"\n#include "../../../../maclauncher-disc.h"');
  replace(archiveOpen, 'if (!(fp = file_open_utf8(path, "rb"))) {',
    'bool virtual_file = false;\n\tif (!(fp = maclauncher_ai5_archive_open(path, &virtual_file))) {');
  replace(archiveOpen, '\n\tbool meta_ok;\n', '\n\tif (virtual_file) flags &= ~ARCHIVE_MMAP;\n\tbool meta_ok;\n');
  replace(path.join(root, "src/main.c"), "if (ini_parse(our_ini_name, cfg_handler, &config) < 0)",
    'if (!getenv("MACLAUNCHER_AI5_INI") && ini_parse(our_ini_name, cfg_handler, &config) < 0)');
  const before = `static FILE *open_save(const char *save_name, const char *mode)
{
	char *path = path_get_icase(save_name);
	if (!path) {
		create_save(save_name);
		path = strdup(save_name);
		WARNING("Save file \\\"%s\\\" doesn't exist", save_name);
	}
	FILE *f = file_open_utf8(path, mode);
	free(path);
	return f;
}`;
  replace(savedata, '#include "vm.h"', '#include "vm.h"\n#include "../maclauncher-paths.h"');
  replace(savedata, before, `static FILE *open_save(const char *save_name, const char *mode)
{
	char *private_path = maclauncher_ai5_path("MACLAUNCHER_AI5_SAVE_DIR", save_name);
	char *existing = path_get_icase(private_path);
	if (!existing) {
		/* Seed an existing portable save once, through a read-only handle.
		 * Game assets are never copied and existing private saves win. */
		char *original = path_get_icase(save_name);
		FILE *input = original ? file_open_utf8(original, "rb") : NULL;
		FILE *output = NULL;
		bool copied = false;
		if (input && !fseek(input, 0, SEEK_END)) {
			long length = ftell(input);
			if (length >= 0 && length <= MEMORY_MEM16_MAX_SIZE && !fseek(input, 0, SEEK_SET)) {
				output = file_open_utf8(private_path, "wb");
				if (output) {
					uint8_t buffer[4096];
					copied = true;
					while (length > 0) {
						size_t count = length < sizeof(buffer) ? length : sizeof(buffer);
						if (fread(buffer, count, 1, input) != 1 || fwrite(buffer, count, 1, output) != 1) { copied = false; break; }
						length -= count;
					}
					if (fclose(output)) copied = false;
				}
			}
		}
		if (input) fclose(input);
		free(original);
		if (!copied) create_save(private_path);
	} else {
		free(private_path);
		private_path = existing;
	}
	FILE *f = file_open_utf8(private_path, mode);
	free(private_path);
	return f;
}`);
  replace(gfx, '#include "vm.h"', '#include "vm.h"\n#include "../maclauncher-paths.h"');
  replace(gfx, 'if (mkdir_p("Screenshots") < 0)', 'if (!getenv("MACLAUNCHER_AI5_OUTPUT_DIR"))');
  replace(gfx, 'FILE *f = file_open_utf8(name, "wb");', 'FILE *f = maclauncher_ai5_graphics_output(name);');
  const graphics = fs.readFileSync(gfx, "utf8");
  if (graphics.split('FILE *f = file_open_utf8(filename, "wb");').length !== 3) throw new Error("Pinned AI5 debugger output overlay differs.");
  fs.writeFileSync(gfx, graphics.replaceAll('FILE *f = file_open_utf8(filename, "wb");', 'FILE *f = maclauncher_ai5_graphics_output(filename);'));
  const textFile = path.join(root, "src/text.c");
  replace(textFile, '#include "gfx_private.h"', '#include "gfx_private.h"\n#include "../maclauncher-paths.h"');
  for (const filename of ["wine_tahoma.ttf", "DotGothic16-Regular.ttf", "Kosugi-Regular.ttf", "NotoSansJP-Thin.ttf"]) {
    replace(textFile, `xstrdup(AI5_DATA_DIR "/fonts/${filename}")`, `maclauncher_ai5_path("MACLAUNCHER_AI5_FONT_DIR", "${filename}")`);
  }
  // INI font settings are parsed after command-line options upstream. Apply the
  // module's chosen packaged/user font once configuration has been read.
  replace(path.join(root, "src/main.c"), '\n\tif (!have_game && !set_game_from_config())', `
	const char *launcher_font = getenv("MACLAUNCHER_AI5_FONT");
	if (launcher_font && launcher_font[0]) {
		config.font_path = strdup(launcher_font);
		config.font_face = 0;
	}
	if (!have_game && !set_game_from_config())`);
  replace(path.join(root, "meson.build"), "fallback : 'unknown'", `fallback : '${VERSION}'`);
  for (const name of ["libavcodec", "libavformat", "libavutil", "libswscale"]) {
    replace(path.join(root, "meson.build"), `dependency('${name}', required: false, static : static_libs)`, `dependency('${name}', required: get_option('ffmpeg'), static : static_libs)`);
  }
  fs.appendFileSync(path.join(root, "meson_options.txt"), "\noption('ffmpeg', type : 'feature', value : 'enabled', description : 'Reviewed profile includes AVI/movie decoding')\n");
  fs.copyFileSync(path.join(__dirname, "macos-paths.h"), path.join(root, "maclauncher-paths.h"));
  fs.copyFileSync(path.join(__dirname, "macos-disc.h"), path.join(root, "maclauncher-disc.h"));
}

module.exports = { VERSION, LEGACY_VERSION, REVISION, sourcePath, adaptSource };
