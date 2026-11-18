// SPDX-License-Identifier: GPL-2.0-only
// On an arm64 host, a VaList that guest code passes to libc (vsnprintf's last argument, or the one a variadic thunk
// builds from the guest registers) is always the guest's System V va_list, never a host va_list: Apple arm64's
// va_list is a single pointer. libc already formats and scans such a list itself on Windows, where the host ABI differs
// from the guest's too. This overlay selects those in-process paths on arm64 in the non-Windows branches:
// - RequiresGuestFormatting is true for every format, so printf-family exports format through
//   LibcDetail::FormatWindows over the guest list;
// - ScansInProcess and ScansWideInProcess are true for every format, so scanf-family exports scan field by field,
//   taking each target pointer from the guest list.
// The x86-64 builds are unchanged.
import fs from 'node:fs';
import path from 'node:path';

export function applyGuestVaListOverlay(root) {
    const file = path.join(root, 'core/libs/prx/libc/src/Formatting.cpp');
    let source = fs.readFileSync(file, 'utf8');
    const replace = (before, after) => {
        if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw Error('Formatting.cpp guest va_list boundary changed: ' + before.split('\n')[0]);
        source = source.replace(before, after);
    };
    replace('bool RequiresGuestFormatting(const char* format) {\n    if (format == nullptr) return false;\n',
        'bool RequiresGuestFormatting(const char* format) {\n    if (format == nullptr) return false;\n#if defined(__aarch64__)\n    return true;\n#endif\n');
    replace('bool ScansWideInProcess(const char* format) {\n',
        'bool ScansWideInProcess(const char* format) {\n#if defined(__aarch64__)\n    if (format != nullptr) return true;\n#endif\n');
    replace('bool ScansInProcess(const char* format) {\n',
        'bool ScansInProcess(const char* format) {\n#if defined(__aarch64__)\n    if (format != nullptr) return true;\n#endif\n');
    fs.writeFileSync(file, source);
}
