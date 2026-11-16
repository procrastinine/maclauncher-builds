// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';

export function applyArm64TlsOverlay(root) {
    const relative = 'core/libs/prx/libkernel/Pthread/src/GuestTlsMacOs.cpp';
    const file = path.join(root, relative);
    let source = fs.readFileSync(file, 'utf8');
    const replace = (before, after) => {
        if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
            throw Error('AnyPS5 arm64 TLS boundary changed: ' + relative);
        source = source.replace(before, after);
    };
    replace('#include <pthread.h>',
        '#include <pthread.h>\n#if defined(__aarch64__)\n#include "prx/libc/include/GuestContextArm64.hpp"\n#endif');
    replace('std::uint8_t Aps5GuestTlsAvx_nid_no_patch = [] {',
        '#if defined(__aarch64__)\n' +
        '// This byte selects the native x86 assembler scratch-save path, not guest CPUID.\n' +
        'std::uint8_t Aps5GuestTlsAvx_nid_no_patch = 0;\n' +
        '#else\nstd::uint8_t Aps5GuestTlsAvx_nid_no_patch = [] {');
    replace('    return __builtin_cpu_supports("avx") ? 1 : 0;\n}();',
        '    return __builtin_cpu_supports("avx") ? 1 : 0;\n}();\n#endif');
    replace('asm(R"(\n    .text',
        '#if defined(__aarch64__)\n#include "GuestTlsArm64.inc"\n#else\nasm(R"(\n    .text');
    replace(')");\n\n#endif', ')");\n#endif\n\n#endif');
    fs.writeFileSync(file, source);
    fs.writeFileSync(path.join(root, 'core/libs/prx/libkernel/Pthread/src/GuestTlsArm64.inc'),
        fs.readFileSync(new URL('./GuestTlsArm64.inc', import.meta.url)));
}
