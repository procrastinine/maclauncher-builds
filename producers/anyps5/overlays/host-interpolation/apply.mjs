// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs/promises';
import path from 'node:path';

export async function applyHostInterpolationOverlay(root) {
    const file = path.join(root, 'core/libs/prx/libSceAgcDriver/Execution/include/FragmentBarycentric.hpp');
    const source = await fs.readFile(file, 'utf8');
    const before = '    return driver == VK_DRIVER_ID_MESA_RADV;';
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
        throw Error('AnyPS5 host interpolation boundary changed.');
    // The recompiler retries individual shaders with exact interpolation when required.
    await fs.writeFile(file, source.replace(before,
        '    return driver == VK_DRIVER_ID_MESA_RADV || driver == VK_DRIVER_ID_MESA_KOSMICKRISP;'));
}
