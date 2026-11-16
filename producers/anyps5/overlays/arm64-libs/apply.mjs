// SPDX-License-Identifier: GPL-2.0-only
// ARM64 build/signing adaptations from AnyTogether/AnyPS5-ARM; see origin.json.
import fs from 'node:fs';
import path from 'node:path';
import {applyArm64ContextsOverlay} from './contexts.mjs';
import {applyArm64TlsOverlay} from './tls.mjs';
import {applyArm64ThreadsOverlay} from './threads.mjs';
export {copyArm64GuestThreadSources} from './threads.mjs';
export {copyArm64GuestContextSources} from './contexts.mjs';

function replace(source, before, after, file) {
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) {
        throw Error('AnyPS5 arm64 library boundary changed: ' + file + ': ' + before.slice(0, 72));
    }
    return source.replace(before, after);
}

export function copyArm64GuestCpuSources(root) {
    const libc = path.join(root, 'core/libs/prx/libc');
    for (const [from, to] of [['GuestCpuArm64.hpp', 'include/GuestCpuArm64.hpp'], ['GuestCpuArm64.cpp', 'src/GuestCpuArm64.cpp']]) {
        const bytes = fs.readFileSync(new URL(from, import.meta.url));
        const destination = path.join(libc, to);
        fs.mkdirSync(path.dirname(destination), {recursive: true});
        if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(bytes)) fs.writeFileSync(destination, bytes);
    }
}

export function copyArm64StandardStreamObjects(root) {
    const destination = path.join(root, 'core/libs/prx/libc/src/StandardStreamObjects.cpp');
    const bytes = fs.readFileSync(new URL('./StandardStreamObjects.cpp', import.meta.url));
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(bytes)) fs.writeFileSync(destination, bytes);
}

export function applyArm64LibrariesOverlay(root) {
    const edit = (relative, transform) => {
        const file = path.join(root, relative);
        fs.writeFileSync(file, transform(fs.readFileSync(file, 'utf8'), relative));
    };
    edit('CMakeLists.txt', (source, file) => {
        source = replace(source,
            '    set(CMAKE_APPLE_SILICON_PROCESSOR x86_64 CACHE STRING "Host processor CMake reports on Apple silicon")',
            '    if(ANYPS5_ARM64_LIBS)\n' +
            '        set(CMAKE_APPLE_SILICON_PROCESSOR arm64)\n' +
            '    else()\n' +
            '        set(CMAKE_APPLE_SILICON_PROCESSOR x86_64 CACHE STRING "Host processor CMake reports on Apple silicon")\n' +
            '    endif()', file);
        source = replace(source,
            'if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64")',
            'option(ANYPS5_ARM64_LIBS "Build PS5 libraries for an arm64 translation host" OFF)\n' +
            'if(ANYPS5_ARM64_LIBS AND (NOT APPLE OR NOT CMAKE_OSX_ARCHITECTURES STREQUAL "arm64"))\n' +
            '    message(FATAL_ERROR "ANYPS5_ARM64_LIBS requires arm64 macOS")\n' +
            'endif()\n\n' +
            'if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64" AND NOT ANYPS5_ARM64_LIBS)', file);
        return replace(source, 'set(ARCHITECTURE x86_64)',
            'if(ANYPS5_ARM64_LIBS)\n    set(ARCHITECTURE arm64)\nelse()\n    set(ARCHITECTURE x86_64)\nendif()', file);
    });
    edit('core/libs/CMakeLists.txt', (source, file) => {
        source = replace(source,
            '        target_link_options(${target} PRIVATE LINKER:-no_compact_unwind)',
            '        if(NOT CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")\n' +
            '            target_link_options(${target} PRIVATE LINKER:-no_compact_unwind)\n        endif()', file);
        source = replace(source, 'set(LIBC_UNPATCHED ${UNPATCHED_DIR}/libc.prx)',
            'if(APPLE AND CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")\n' +
            '    find_program(ANYPS5_CODESIGN codesign REQUIRED)\n' +
            '    set(ANYPS5_NID_UNSIGN "${ANYPS5_CODESIGN}" --remove-signature)\n' +
            '    set(ANYPS5_NID_SIGN "${ANYPS5_CODESIGN}" --force --sign -)\n' +
            'else()\n' +
            '    set(ANYPS5_NID_UNSIGN "${CMAKE_COMMAND}" -E true)\n' +
            '    set(ANYPS5_NID_SIGN "${CMAKE_COMMAND}" -E true)\n' +
            'endif()\n\nset(LIBC_UNPATCHED ${UNPATCHED_DIR}/libc.prx)', file);
        source = replace(source, '        COMMAND $<TARGET_FILE:nid_patcher> libc ${LIBC_PATCHED}',
            '        COMMAND ${ANYPS5_NID_UNSIGN} ${LIBC_PATCHED}\n' +
            '        COMMAND $<TARGET_FILE:nid_patcher> libc ${LIBC_PATCHED}\n' +
            '        COMMAND ${ANYPS5_NID_SIGN} ${LIBC_PATCHED}', file);
        return replace(source,
            '                COMMAND $<TARGET_FILE:nid_patcher> ${LIB_NAME} --preserve-export-list "${LIBC_EXPORT_LIST}" "${PATCHED_FILE}"',
            '                COMMAND ${ANYPS5_NID_UNSIGN} ${PATCHED_FILE}\n' +
            '                COMMAND $<TARGET_FILE:nid_patcher> ${LIB_NAME} --preserve-export-list "${LIBC_EXPORT_LIST}" "${PATCHED_FILE}"\n' +
            '                COMMAND ${ANYPS5_NID_SIGN} ${PATCHED_FILE}', file);
    });
    const libc = 'core/libs/prx/libc/';
    copyArm64GuestCpuSources(root);
    edit(libc + 'include/GuestCpu.hpp', (source, file) => replace(source,
        '#else\n#error "GuestCpu.hpp supports only x86-64 targets"',
        '#elif defined(__aarch64__)\n#include "GuestCpuArm64.hpp"\n#else\n#error "GuestCpu.hpp supports only x86-64 and arm64 targets"', file));
    edit(libc + 'CMakeLists.txt', source => source + '\ntarget_sources(libc PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/GuestCpuArm64.cpp)\n');
    copyArm64StandardStreamObjects(root);
    edit(libc + 'src/RuntimeSupport.cpp', (source, file) => replace(source,
        'FileStream _Stderr_nid_postfix{stderr};\nFileStream _Stdout_nid_postfix{stdout};\nFileStream _Stdin_nid_postfix{stdin};\n', '', file));
    edit(libc + 'src/StandardStreams.cpp', (source, file) => {
        source = replace(source, 'FileStream input{stdin};\n', '', file);
        return replace(source,
            'FileStream* __stdinp_nid_postfix = &input;\nFileStream* __stdoutp_nid_postfix = &_Stdout_nid_postfix;\nFileStream* __stderrp_nid_postfix = &_Stderr_nid_postfix;\n', '', file);
    });
    edit(libc + 'CMakeLists.txt', source => source + '\ntarget_sources(libc PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/StandardStreamObjects.cpp)\n');
    applyArm64ContextsOverlay(root);
    applyArm64TlsOverlay(root);
    applyArm64ThreadsOverlay(root);
    edit('core/libs/prx/libc/src/AtomicBuiltins.cpp', (source, file) => {
        source = replace(source,
        'bool CompareExchange16(Uint128* target, Uint128& expected, Uint128 desired) {',
        'bool CompareExchange16(Uint128* target, Uint128& expected, Uint128 desired) {\n' +
        '#if defined(__aarch64__)\n' +
        '    return __atomic_compare_exchange_n(target, &expected, desired, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);\n' +
        '#else', file);
        source = replace(source, '    return exchanged;\n}', '    return exchanged;\n#endif\n}', file);
        source = replace(source, 'Uint128 ReadHalves(const Uint128* target) {',
            'Uint128 ReadHalves(const Uint128* target) {\n#if defined(__aarch64__)\n' +
            '    return __atomic_load_n(target, __ATOMIC_SEQ_CST);\n#else', file);
        return replace(source, '    return (static_cast<Uint128>(high) << 64) | low;\n}',
            '    return (static_cast<Uint128>(high) << 64) | low;\n#endif\n}', file);
    });
    edit('core/libs/prx/libc/src/Bessel.cpp', (source, file) => {
        source = replace(source, '#include <immintrin.h>',
            '#if defined(__x86_64__)\n#include <immintrin.h>\n#endif', file);
        source = replace(source, 'double SquareRoot(double x) {\n',
            '#if defined(__aarch64__)\n' +
            'double SquareRoot(double x) { return std::sqrt(x); }\n' +
            'constexpr bool HardwareFma = true;\n' +
            'double HardwareFused(double a, double b, double c) { return std::fma(a, b, c); }\n' +
            '#else\ndouble SquareRoot(double x) {\n', file);
        return replace(source, '\ndouble Fused(double a, double b, double c) {',
            '\n#endif\n\ndouble Fused(double a, double b, double c) {', file);
    });
}
