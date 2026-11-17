// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';

export function applyArm64TlsOverlay(root) {
    const edit = (relative, transform) => {
        const file = path.join(root, relative);
        let source = fs.readFileSync(file, 'utf8');
        const replace = (before, after) => {
            if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
                throw Error('AnyPS5 arm64 TLS boundary changed: ' + relative);
            source = source.replace(before, after);
        };
        transform(replace);
        fs.writeFileSync(file, source);
    };
    const base = 'core/libs/prx/libkernel/Pthread/src/';
    edit(base + 'GuestTlsMacOs.cpp', replace => {
        replace('#include <cpuid.h>', '#if defined(__x86_64__)\n#include <cpuid.h>\n#endif');
        replace('#include <pthread.h>', '#include <pthread.h>\n#if defined(__aarch64__)\n' +
            '#include "prx/libc/include/GuestContextArm64.hpp"\n#endif');
        replace('\n\n#endif\n', '\n#if defined(__aarch64__)\n#include "GuestTlsArm64.inc"\n#endif\n\n#endif\n');
    });
    edit(base + 'GuestTlsLifecycle.inc', replace => {
        replace('GuestVectorState VectorState() {', 'GuestVectorState VectorState() {\n#if defined(__aarch64__)\n' +
            '    // Native x86 XSAVE/FXSAVE scratch storage is absent on this host.\n' +
            '    // Guest CPU/vector state is owned by FEX and never read from this object.\n' +
            '    return {0, 0, 0};\n#else');
        replace('    return {enabled & supported, (ebx + 63u) & ~63u, 1};\n}',
            '    return {enabled & supported, (ebx + 63u) & ~63u, 1};\n#endif\n}');
    });
    const startup = path.join(root, base + 'GuestStartup.S');
    fs.writeFileSync(startup, '#if defined(__x86_64__)\n' + fs.readFileSync(startup, 'utf8') + '\n#endif\n');
    fs.writeFileSync(path.join(root, base + 'GuestTlsArm64.inc'), fs.readFileSync(new URL('./GuestTlsArm64.inc', import.meta.url)));
}
