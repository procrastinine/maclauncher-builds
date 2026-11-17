// SPDX-License-Identifier: GPL-2.0-only
// libkernel's SyncOnAddress.cpp reads a misaligned guest word with an x86 MOV in inline assembly (LoadAddressValue), so
// the file does not compile for arm64. On arm64 the same single read is a byte copy into the value; aligned words keep
// their atomic load. The x86-64 builds are unchanged.
import fs from 'node:fs';
import path from 'node:path';

export function applySyncOnAddressLoad(root) {
    const file = path.join(root, 'core/libs/prx/libkernel/SyncOnAddress/src/SyncOnAddress.cpp');
    const source = fs.readFileSync(file, 'utf8');
    const before = '    asm volatile("mov %1, %0" : "=r"(value) : "m"(*reinterpret_cast<const unsigned char (*)[sizeof(TValue)]>(address)));\n';
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw Error('SyncOnAddress load boundary changed: ' + file);
    fs.writeFileSync(file, source.replace(before, '#if defined(__aarch64__)\n    __builtin_memcpy(&value, address, sizeof(TValue));\n#else\n' + before + '#endif\n'));
}
