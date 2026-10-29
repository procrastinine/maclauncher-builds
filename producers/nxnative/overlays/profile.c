#include "game_profile.h"
#include <ctype.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

typedef struct { char *key, *value; } row;
static nxnative_profile profile;
static pthread_once_t once = PTHREAD_ONCE_INIT;
static row rows[4096];
static size_t row_count;

static void invalid(const char *key) {
    fprintf(stderr, "nxnative: invalid or missing profile field: %s\n", key);
    exit(1);
}
static char *trim(char *value) {
    while (isspace((unsigned char)*value)) ++value;
    size_t n = strlen(value);
    while (n && isspace((unsigned char)value[n - 1])) value[--n] = 0;
    return value;
}
static const char *get(const char *key, const char *fallback) {
    for (size_t i = 0; i < row_count; ++i) if (!strcmp(rows[i].key, key)) return rows[i].value;
    if (!fallback) invalid(key);
    return fallback;
}
static uint64_t number(const char *key, const char *fallback, int base) {
    const char *value = get(key, fallback); char *end = NULL; errno = 0;
    unsigned long long result = strtoull(value, &end, base);
    if (!*value || *value == '-' || errno || !end || *end) invalid(key);
    return result;
}
static int choice(const char *key, const char *fallback, const char *a, const char *b) {
    const char *value = get(key, fallback);
    if (!strcmp(value, a)) return 0;
    if (!strcmp(value, b)) return 1;
    invalid(key); return 0;
}
static void load(void) {
    const char *file = getenv("NXNATIVE_PROFILE");
    if (!file || !*file) invalid("NXNATIVE_PROFILE");
    struct stat st;
    if (stat(file, &st) || !S_ISREG(st.st_mode) || st.st_size < 1 || st.st_size > 4 * 1024 * 1024) invalid("NXNATIVE_PROFILE");
    FILE *input = fopen(file, "r"); if (!input) invalid("NXNATIVE_PROFILE");
    char *line = NULL; size_t capacity = 0;
    while (getline(&line, &capacity, input) >= 0) {
        char *key = trim(line); if (!*key || *key == '#') continue;
        char *tab = strchr(key, '\t'); if (row_count == 4096) invalid("row");
        if (tab) *tab++ = 0; else tab = key + strlen(key);
        rows[row_count++] = (row){strdup(trim(key)), strdup(trim(tab))};
    }
    free(line); fclose(input);
    char *directory = strdup(file), *slash = strrchr(directory, '/');
    if (!slash) invalid("profile directory"); *slash = 0; profile.directory = directory;
    const char *id = strrchr(directory, '/'); id = id ? id + 1 : directory;
    if (strlen(id) != 16) invalid("title id");
    for (size_t i = 0; i < 16; ++i) if (!isxdigit((unsigned char)id[i])) invalid("title id");
    profile.id = strdup(id);
    profile.name = get("name", NULL); profile.romfs_marker = get("romfs_marker", NULL);
    profile.args = get("game_args", ""); profile.env = get("game_env", "");
    profile.feedback_snap = get("feedback_snap", ""); profile.alpha_from_red = get("alpha_from_red", "");
    profile.program_id = number("program_id", NULL, 16);
    profile.mem_reserve = number("mem_reserve", NULL, 0); profile.mem_alias = number("mem_alias", NULL, 0);
    profile.mem_stack = number("mem_stack", NULL, 0); profile.app_pool = number("app_pool", NULL, 0);
    profile.mem_used = number("mem_used", "0x4000000", 0); profile.sys_resource = number("sys_resource", "0x2000000", 0);
    char *modules = strdup(get("modules", NULL)), *state = NULL;
    profile.modules = calloc(64, sizeof(char *));
    for (char *module = strtok_r(modules, " \t", &state); module; module = strtok_r(NULL, " \t", &state)) {
        if (profile.module_count == 64) invalid("modules");
        profile.modules[profile.module_count++] = module;
    }
    if (!profile.module_count) invalid("modules");
    profile.versions = calloc(row_count, sizeof(nxnative_version));
    for (size_t i = 0; i < row_count; ++i) if (!strcmp(rows[i].key, "build")) {
        char *copy = strdup(rows[i].value), *context = NULL;
        strtok_r(copy, "\t", &context); char *version = strtok_r(NULL, "\t", &context);
        if (!version) invalid("build");
        for (char *module = strtok_r(NULL, "\t", &context); module; module = strtok_r(NULL, "\t", &context)) {
            if (!strncmp(module, "main=", 5)) profile.versions[profile.version_count++] = (nxnative_version){module + 5, version};
        }
    }
    profile.stdalloc_cap = number("stdalloc_cap", "0", 0);
    profile.present_display = choice("present_interval", "game", "game", "display");
    profile.mem_map_limit = choice("mem_map_limit", "off", "off", "on");
    profile.core_preempt = choice("core_preempt", "off", "off", "on");
    profile.alloc_big_align = choice("alloc_big_align", "off", "off", "on");
    profile.fps_target = (int)number("fps_target", "0", 0);
    if (profile.fps_target != 0 && profile.fps_target != 30 && profile.fps_target != 60) invalid("fps_target");
    profile.fps_hold = choice("fps_hold", "on", "off", "on");
    profile.present_snap = choice("present_snap", "off", "off", "on");
    profile.pso_mtl4 = choice("pso_mtl4", "off", "off", "on");
    profile.shared_font_present = *get("shared_font", "") != 0;
    profile.shared_font_ttf = choice("shared_font", "bfttf", "bfttf", "ttf");
    const char *pad = get("pad_layout", "simple");
    profile.pad_layout = !strcmp(pad, "simple") ? 0 : !strcmp(pad, "full") ? 1 : !strcmp(pad, "touch") ? 2 : -1;
    if (profile.pad_layout < 0) invalid("pad_layout");
    profile.opmode = choice("op_mode", "console", "handheld", "console");
    if (profile.pad_layout == 2 && profile.opmode) invalid("op_mode");
    profile.perf_boost = choice("perf_mode", "follow", "follow", "boost");
    profile.tex_flush_upload = choice("tex_flush_upload", "off", "off", "on");
    profile.render_cond = choice("render_cond", "off", "off", "on");
    profile.tex_dirty_upload = choice("tex_dirty_upload", "off", "off", "on");
    if (profile.tex_dirty_upload && !profile.tex_flush_upload) invalid("tex_dirty_upload");
    profile.tex_dyn_slots = choice("tex_dyn_slots", "off", "off", "on");
    profile.gpu_ts_segment = choice("gpu_timestamps", "submission", "submission", "segment");
    profile.vconv_range = choice("vconv_range", "off", "off", "on");
    const char *api = get("device_api", ""); profile.nvn_api_present = *api != 0;
    if (*api) { char tail; if (sscanf(api, "%d.%d%c", &profile.nvn_api_major, &profile.nvn_api_minor, &tail) != 2 || profile.nvn_api_major < 0 || profile.nvn_api_minor < 0) invalid("device_api"); }
}
const nxnative_profile *nxnative_profile_current(void) {
    pthread_once(&once, load); return &profile;
}
