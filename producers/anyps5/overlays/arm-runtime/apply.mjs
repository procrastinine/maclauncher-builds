// SPDX-License-Identifier: GPL-2.0-only
// Runtime adaptations from https://github.com/AnyTogether/AnyPS5-ARM.git.
// Exact origin commits and paths are recorded in source.json.
import fs from 'node:fs';
import path from 'node:path';
import {applyArmPatches} from '../arm-patches.mjs';

export function applyArmRuntimeOverlay(root) {
    applyArmPatches(root, import.meta.dirname, ['20e564c7', 'fcd2c91e', 'b2556b1e', '1347453a']);
    // 763900e97be59a0cb975902faadba7a50a657198, adapted over the existing
    // Darwin environ declaration without changing other environment handling.
    const file = path.join(root, 'core/libs/prx/libSceAgcDriver/Execution/src/VulkanDevice.cpp');
    let source = fs.readFileSync(file, 'utf8');
    const replace = (before, after) => {
        if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw Error('ARM environment boundary changed.');
        source = source.replace(before, after);
    };
    replace('#include <unistd.h>\nextern char** environ;\n#endif', '#include <unistd.h>\n#endif\n#ifdef __APPLE__\n#include <crt_externs.h>\n#endif');
    replace('#ifndef _WIN32\nextern char** environ;\n#endif', '#if !defined(_WIN32) && !defined(__APPLE__)\nextern char** environ;\n#endif');
    replace('char** entries = _environ;\n#else', 'char** entries = _environ;\n#elif defined(__APPLE__)\n                        char** entries = *_NSGetEnviron();\n#else');
    fs.writeFileSync(file, source);
}
