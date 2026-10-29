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
    update('dm/host/main.c', (text, file) => once(text,
        'static const char *def[] = DM_GAME_MODULES;',
        'const char **def = nxnative_profile_current()->modules;', file));
    update('dm/host/front_mac.m', (text, file) => once(once(text,
        '@DM_GAME_NAME', '@(DM_GAME_NAME)', file),
        '@"Quit " DM_GAME_NAME', '[NSString stringWithFormat:@"Quit %s", DM_GAME_NAME]', file));
    update('dm/host/hle_sdk16.c', (text, file) => {
        text = once(text, 'static const struct { const char *build, *ver; } k[] = {DM_GAME_DISPLAY_VERSIONS};',
            'const nxnative_version *k = nxnative_profile_current()->versions;', file);
        text = once(text, 'sizeof k / sizeof *k', 'nxnative_profile_current()->version_count', file);
        text = once(text, '#ifdef DM_GAME_SHARED_FONT_TTF', 'if (nxnative_profile_current()->shared_font_present) {', file);
        text = once(text, 'skip = DM_GAME_SHARED_FONT_TTF ? 8 : 0;', 'skip = nxnative_profile_current()->shared_font_ttf ? 8 : 0;', file);
        return text.replace('#else\n        int m = dm_sdk_major(), dec =', '} else {\n        int m = dm_sdk_major(), dec =')
            .replace('#endif\n    }\n    return (size_t)skip;', '}\n    }\n    return (size_t)skip;');
    });
    update('dm/gfx/nvn/hle_nvn.c', (text, file) => {
        text = once(text, '#ifdef DM_GAME_NVN_API_MAJOR', 'if (nxnative_profile_current()->nvn_api_present) {', file);
        text = once(text, 'api[0] = DM_GAME_NVN_API_MAJOR; api[1] = DM_GAME_NVN_API_MINOR;',
            'api[0] = nxnative_profile_current()->nvn_api_major; api[1] = nxnative_profile_current()->nvn_api_minor;', file);
        return text.replace('#else\n    int m = dm_sdk_major(); api[0]', '} else {\n    int m = dm_sdk_major(); api[0]')
            .replace('#endif\n}\nNVN(nvnDeviceGetInteger', '}\n}\nNVN(nvnDeviceGetInteger');
    });
    update('dm/gfx/nvn/nvn_mtl.m', (text, file) => {
        text = include + text;
        text = once(text, 'exe_rel("../games/" DM_GAME_ID "/shader_map.tsv")',
            '[NSString stringWithFormat:@"%s/shader_map.tsv", nxnative_profile_current()->directory]', file);
        text = once(text, '@DM_GAME_ID', '@(DM_GAME_ID)', file);
        text = once(text, 'MLOG("[RED] shader library %s was built for game %s, not " DM_GAME_ID, g_msl_dir.UTF8String, st_game.UTF8String);',
            'MLOG("[RED] shader library %s was built for game %s, not %s", g_msl_dir.UTF8String, st_game.UTF8String, DM_GAME_ID);', file);
        return once(text, 'dispatch_data_t d = dispatch_data_create(m, len, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ munmap(m, len); });\n    return [g_dev newLibraryWithData:d error:err];',
            'NSData *data = [NSData dataWithBytes:m length:len]; munmap(m, len);\n    return nxnative_metal_library_data(g_dev, data, err);', file);
    });
    for (const file of ['dm/gfx/vk/hle_vk.m', 'dm/gfx/gl/hle_gl.m']) update(file, (text, relative) => include + once(text,
        '[g_dev newLibraryWithURL:[NSURL fileURLWithPath:@(p)] error:&err]',
        'nxnative_metal_library(g_dev, @(p), &err)', relative));
    const directory = path.join(root, 'nxnative'); fs.mkdirSync(directory, {recursive:true});
    for (const file of ['game_profile.h', 'profile.c', 'metal_library.h', 'metal_library.m']) fs.copyFileSync(path.join(owned, file), path.join(directory, file));
}
