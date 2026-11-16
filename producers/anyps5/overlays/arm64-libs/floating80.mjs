// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';

export function copyArm64GuestFloatSources(root) {
    const libc = path.join(root, 'core/libs/prx/libc');
    for (const [from, to] of [['GuestFloat80.hpp', 'include/GuestFloat80.hpp'], ['GuestFloat80.cpp', 'src/GuestFloat80.cpp'], ['StringsArm64.inc', 'src/StringsArm64.inc']]) {
        fs.mkdirSync(path.dirname(path.join(libc, to)), {recursive: true});
        fs.writeFileSync(path.join(libc, to), fs.readFileSync(new URL(from, import.meta.url)));
    }
    fs.cpSync(new URL('./gdtoa/', import.meta.url), path.join(libc, 'gdtoa'), {recursive: true});
}

export function applyArm64FloatStringsOverlay(root) {
    const edit = (relative, transform) => {
        const file = path.join(root, relative);
        let source = fs.readFileSync(file, 'utf8');
        const replace = (before, after) => {
            if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
                throw Error('AnyPS5 arm64 raw80 boundary changed: ' + relative);
            source = source.replace(before, after);
        };
        transform(replace);
        fs.writeFileSync(file, source);
    };
    copyArm64GuestFloatSources(root);
    const base = 'core/libs/prx/libc/';
    edit(base + 'include/Api.hpp', replace => {
        replace('#pragma once', '#pragma once\n#if defined(__aarch64__)\n#include "GuestFloat80.hpp"\n#endif');
        for (const declaration of [
            'long double APS5_VABI strtold_nid_postfix(const char* str, char** endptr);',
            'long double APS5_VABI wcstold_nid_postfix(const char16_t* str, char16_t** endptr);',
        ]) replace(declaration, '#if defined(__aarch64__)\n' + declaration.replace('long double', 'GuestFloat::X87') + '\n#else\n' + declaration + '\n#endif');
    });
    edit(base + 'src/Strings.cpp', replace => {
        replace('#include "prx/libc/include/General.hpp"', '#include "prx/libc/include/General.hpp"\n#if defined(__aarch64__)\n' +
            '#include "prx/libc/include/GuestCpu.hpp"\n#include "prx/libc/include/GuestFloat80.hpp"\n#endif');
        replace('template<typename TFloat>\nTFloat ParseFloat(const char* text, char** end, TFloat (*parse)(const char*, char**)) {',
            '#if defined(__aarch64__)\n#include "StringsArm64.inc"\n#endif\n\n' +
            'template<typename TFloat>\nTFloat ParseFloat(const char* text, char** end, TFloat (*parse)(const char*, char**)) {');
        const oldFloatCheck = '            const long double exact = std::strtold(text, nullptr);\n' +
            '            const bool roundedUp = magnitude == std::numeric_limits<float>::denorm_min() && (exact < 0 ? -exact : exact) < magnitude;\n' +
            '            errno = hexadecimal ? (roundedUp ? ERANGE : saved) : (static_cast<long double>(value) != exact ? ERANGE : saved);';
        replace(oldFloatCheck, '#if defined(__aarch64__)\n' +
            '            const auto exact = GuestFloat::Parse(text, nullptr, GuestExtendedRounding()).value;\n' +
            '            const int comparison = CompareGuestExtendedMagnitude(exact, FloatAsGuestExtended(value));\n' +
            '            const bool roundedUp = magnitude == std::numeric_limits<float>::denorm_min() && comparison < 0;\n' +
            '            errno = hexadecimal ? (roundedUp ? ERANGE : saved) : (comparison != 0 ? ERANGE : saved);\n' +
            '#else\n' + oldFloatCheck + '\n#endif');
        const oldNarrow = 'long double APS5_VABI strtold_nid_postfix(const char* str, char** endptr) {\n' +
            '    static_assert(sizeof(long double) == 16, "Guest long double requires x87 extended precision storage");\n' +
            '    return ParseFloat<long double>(str, endptr, std::strtold);\n}';
        replace(oldNarrow, '#if defined(__aarch64__)\n' +
            'GuestFloat::X87 APS5_VABI strtold_nid_postfix(const char* str, char** endptr) {\n' +
            '    static_assert(sizeof(GuestFloat::X87) == 16 && sizeof(GuestFloat::X87::significand) * CHAR_BIT == 64);\n' +
            '    return ParseGuestExtended(str, endptr);\n}\n#else\n' + oldNarrow + '\n#endif');
        const oldWide = 'long double APS5_VABI wcstold_nid_postfix(const char16_t* str, char16_t** endptr) {\n' +
            '#ifndef __EMSCRIPTEN__\n    static_assert(sizeof(long double) == 16);\n' +
            '    static_assert(std::numeric_limits<long double>::digits == 64);\n#endif\n' +
            '    return ParseAsciiPrefix(str, endptr, [](const char* text, char** end) { return ParseFloat<long double>(text, end, std::strtold); });\n}';
        replace(oldWide, '#if defined(__aarch64__)\n' +
            'GuestFloat::X87 APS5_VABI wcstold_nid_postfix(const char16_t* str, char16_t** endptr) {\n' +
            '    static_assert(sizeof(GuestFloat::X87) == 16 && sizeof(GuestFloat::X87::significand) * CHAR_BIT == 64);\n' +
            '    return ParseAsciiPrefix(str, endptr, [](const char* text, char** end) { return ParseGuestExtended(text, end); });\n' +
            '}\n#else\n' + oldWide + '\n#endif');
        replace('#include <cstdint>', '#include <cstdint>\n#include <climits>');
    });
    fs.appendFileSync(path.join(root, base + 'CMakeLists.txt'), '\n' + fs.readFileSync(new URL('./gdtoa/Build.cmake', import.meta.url), 'utf8'));
}
