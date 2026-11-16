// SPDX-License-Identifier: GPL-2.0-only
// The arm64 library overlay moves libc's standard stream objects (_Stdin/_Stdout/_Stderr and the __stdinp, __stdoutp
// and __stderrp pointers) into StandardStreamObjects.cpp, which this producer compiles, and removes their previous
// definitions from RuntimeSupport.cpp and StandardStreams.cpp in applyArm64LibrariesOverlay
// (producers/anyps5/overlays/arm64-libs/apply.mjs). The per-source objects take only that overlay's shared-source
// steps, so the same removals are made here: each object then refers to the one set of stream objects, which guest
// data imports also bind to. StandardStreams.cpp uses the three pointers after their definitions (putchar uses
// __stdoutp), so there they become declarations rather than disappear; the removal alone leaves them undeclared.
import fs from 'node:fs';
import path from 'node:path';

export function applyStandardStreamsOverlay(root) {
    const edit = (relative, removals) => {
        const file = path.join(root, relative);
        let source = fs.readFileSync(file, 'utf8');
        for (const removal of removals) {
            const [before, after] = Array.isArray(removal) ? removal : [removal, ''];
            if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw Error('Standard stream boundary changed: ' + relative);
            source = source.replace(before, after);
        }
        fs.writeFileSync(file, source);
    };
    edit('core/libs/prx/libc/src/RuntimeSupport.cpp', ['FileStream _Stderr_nid_postfix{stderr};\nFileStream _Stdout_nid_postfix{stdout};\nFileStream _Stdin_nid_postfix{stdin};\n']);
    edit('core/libs/prx/libc/src/StandardStreams.cpp', ['FileStream input{stdin};\n',
        ['FileStream* __stdinp_nid_postfix = &input;\nFileStream* __stdoutp_nid_postfix = &_Stdout_nid_postfix;\nFileStream* __stderrp_nid_postfix = &_Stderr_nid_postfix;\n',
         'extern FileStream* __stdinp_nid_postfix;\nextern FileStream* __stdoutp_nid_postfix;\nextern FileStream* __stderrp_nid_postfix;\n']]);
}
