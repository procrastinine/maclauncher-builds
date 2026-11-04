import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const owned = path.dirname(fileURLToPath(import.meta.url));
function once(text, before, after, file) {
    if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw Error('nxnative overlay differs from ' + file);
    return text.replace(before, after);
}
export function applyOverlays(root) {
    const update = (relative, adapt) => {
        const file = path.join(root, relative), before = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, adapt(before, relative));
    };
    const include = '#include "metal_library.h"\n';
    update('dm/host/Makefile', text => {
        text = 'GAME_H := ../../nxnative/game_profile.h\n' + text.slice(text.indexOf('include ../mac/min_os.mk'));
        const start = text.indexOf('.PHONY: game_profile'), end = text.indexOf('dmhost: $(SRC)', start);
        return text.slice(0, start) + 'SRC += ../../nxnative/profile.c ../../nxnative/metal_library.m\n.PHONY: FORCE\nFORCE:\n' + text.slice(end);
    });
    update('dm/host/main.c', (text, file) => {
        text = once(text, 'const char *all[] = DM_GAME_MODULES;', 'const char **all = nxnative_profile_current()->modules;', file);
        text = once(text, 'const struct { const char *build, *mods; } rows[] = {DM_GAME_BUILD_MODULES};', 'const nxnative_version *rows = nxnative_profile_current()->versions;', file);
        return once(text, 'sizeof rows / sizeof *rows', 'nxnative_profile_current()->version_count', file);
    });
    update('dm/host/hle_sdk16.c', (text, file) => {
        text = once(text, 'const struct { const char *build, *ver; } k[] = {DM_GAME_DISPLAY_VERSIONS};',
            'const nxnative_version *k = nxnative_profile_current()->versions;', file);
        text = once(text, 'sizeof k / sizeof *k', 'nxnative_profile_current()->version_count', file);
        text = once(text, '#ifdef DM_GAME_SHARED_FONT_TTF', 'if (nxnative_profile_current()->shared_font_present) {', file);
        text = once(text, 'skip = DM_GAME_SHARED_FONT_TTF ? 8 : 0;', 'skip = nxnative_profile_current()->shared_font_ttf ? 8 : 0;', file);
        return text.replace('#else\n        int m = dm_sdk_major(), dec =', '} else {\n        int m = dm_sdk_major(), dec =')
            .replace('#endif\n    }\n    return (size_t)skip;', '}\n    }\n    return (size_t)skip;');
    });
    update('dm/host/hle_cheats.c', (text, file) => {
        text = once(text, '#ifdef DM_GAME_DISPLAY_VERSIONS\n    const struct { const char *build, *ver; } k[] = {DM_GAME_DISPLAY_VERSIONS};', '    const nxnative_version *k = nxnative_profile_current()->versions;', file);
        text = once(text, 'sizeof k / sizeof *k', 'nxnative_profile_current()->version_count', file);
        return once(text, '#endif\n}\n\n// The anchored sources', '}\n\n// The anchored sources', file);
    });
    update('dm/gfx/nvn/hle_nvn.c', (text, file) => {
        text = once(text, '#ifdef DM_GAME_NVN_API_MAJOR', 'if (nxnative_profile_current()->nvn_api_present) {', file);
        text = once(text, 'api[0] = DM_GAME_NVN_API_MAJOR; api[1] = DM_GAME_NVN_API_MINOR;',
            'api[0] = nxnative_profile_current()->nvn_api_major; api[1] = nxnative_profile_current()->nvn_api_minor;', file);
        return text.replace('#else\n    // The Switch 2', '} else {\n    // The Switch 2')
            .replace('#endif\n}\nNVN(nvnDeviceGetInteger', '}\n}\nNVN(nvnDeviceGetInteger');
    });
    update('dm/gfx/nvn/nvn_mtl.m', (text, file) => {
        text = include + text;
        text = once(text, 'exe_rel([NSString stringWithFormat:@"../games/%s/shader_map.tsv", DM_GAME_ID].UTF8String)',
            '[NSString stringWithFormat:@"%s/shader_map.tsv", nxnative_profile_current()->directory]', file);
        return once(text, 'dispatch_data_t d = dispatch_data_create(m, len, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ munmap(m, len); });\n    return [g_dev newLibraryWithData:d error:err];',
            'NSData *data = [NSData dataWithBytes:m length:len]; munmap(m, len);\n    return nxnative_metal_library_data(g_dev, data, err);', file);
    });
    for (const file of ['dm/gfx/vk/hle_vk.m', 'dm/gfx/gl/hle_gl.m']) update(file, (text, relative) => include + once(text,
        '[g_dev newLibraryWithURL:[NSURL fileURLWithPath:@(p)] error:&err]',
        'nxnative_metal_library(g_dev, @(p), &err)', relative));
    const directory = path.join(root, 'nxnative'); fs.mkdirSync(directory, {recursive:true});
    for (const file of ['game_profile.h', 'profile.c', 'metal_library.h', 'metal_library.m']) fs.copyFileSync(path.join(owned, file), path.join(directory, file));
}
