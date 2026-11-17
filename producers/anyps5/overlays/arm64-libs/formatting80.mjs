// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';

export function applyArm64FormattingOverlay(root) {
    const base = 'core/libs/prx/libc/';
    const edit = (relative, transform) => {
        const file = path.join(root, relative);
        let source = fs.readFileSync(file, 'utf8');
        const replace = (before, after) => {
            if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
                throw Error('AnyPS5 arm64 formatting boundary changed: ' + relative);
            source = source.replace(before, after);
        };
        transform(replace, text => { source = text(source); });
        fs.writeFileSync(file, source);
    };
    fs.writeFileSync(path.join(root, base + 'include/GuestLongDoubleArm64.inc'),
        fs.readFileSync(new URL('./GuestLongDoubleArm64.inc', import.meta.url)));
    edit(base + 'include/GuestLongDouble.hpp', replace => {
        replace('#include <cstdint>', '#include <cstdint>\n#include <bit>\n#include <cmath>\n#if defined(__aarch64__)\n#include "GuestFloat80.hpp"\n#endif');
        replace('inline constexpr std::size_t GuestLongDoubleBytes = 16;',
            '#if defined(__aarch64__)\n#include "GuestLongDoubleArm64.inc"\n#else\nusing ExtendedFloat = long double;\n' +
            'inline constexpr std::size_t GuestLongDoubleBytes = 16;');
        replace('\n}\n\n#endif', '\n#endif\n\n}\n\n#endif');
    });
    edit(base + 'include/WindowsFormatting.hpp', (replace, transform) => {
        transform(source => source.replaceAll('long double', 'ExtendedFloat'));
        const hex = '    if (value == 0) return HexDigits(spec, conversion, std::signbit(value), 0, 0, 16, 0, maximumLength);\n' +
            '    int exponent = 0;\n' +
            '    const auto mantissa = static_cast<std::uint64_t>(std::ldexp(std::frexp(std::fabs(value), &exponent), 64));\n' +
            '    return HexDigits(spec, conversion, std::signbit(value), 1, mantissa << 1, 16, exponent - 1, maximumLength);';
        replace(hex, '#if defined(__aarch64__)\n' +
            '    if (value.Zero()) return HexDigits(spec, conversion, value.Negative(), 0, 0, 16, 0, maximumLength);\n' +
            '    const auto parts = FormatDecompose(value);\n' +
            '    return HexDigits(spec, conversion, value.Negative(), 1, parts.mantissa << 1, 16, parts.binary - 1, maximumLength);\n' +
            '#else\n' + hex + '\n#endif');
        const decimal = '    if (value == 0) return result;\n    int binary = 0;\n' +
            '    const auto mantissa = static_cast<std::uint64_t>(std::ldexp(std::frexp(std::fabs(value), &binary), 64));';
        replace(decimal, '#if defined(__aarch64__)\n    if (value.Zero()) return result;\n' +
            '    const auto parts = FormatDecompose(value);\n    int binary = parts.binary;\n' +
            '    const auto mantissa = parts.mantissa;\n#else\n' + decimal + '\n#endif');
        replace('inline std::string PaddedStringSpec(', '#if defined(__aarch64__)\n' +
            'inline std::string DecimalFloat(const std::string& spec, char conversion, double value, std::size_t maximumLength = INT_MAX) {\n' +
            '    return DecimalFloat(spec, conversion, FormatFromDouble(value), maximumLength);\n}\n#endif\n\n' +
            'inline std::string PaddedStringSpec(');
        replace('                    output.Value(spec + "L" + conversion, value);',
            '#if defined(__aarch64__)\n' +
            '                    output.Value(spec + "L" + conversion, FormatNativeInfinity(value));\n' +
            '#else\n                    output.Value(spec + "L" + conversion, value);\n#endif');
        // The non-arm64 branch uses the original builtin type and predicates.
        transform(source => '#if defined(__aarch64__)\n#define ANYPS5_FORMAT_ISNAN LibcDetail::FormatIsNan\n#define ANYPS5_FORMAT_FINITE LibcDetail::FormatFinite\n#define ANYPS5_FORMAT_NEGATIVE LibcDetail::FormatNegative\n#else\n#define ANYPS5_FORMAT_ISNAN std::isnan\n#define ANYPS5_FORMAT_FINITE std::isfinite\n#define ANYPS5_FORMAT_NEGATIVE std::signbit\n#endif\n' +
            source.replaceAll('std::isnan(value)', 'ANYPS5_FORMAT_ISNAN(value)').replaceAll('std::isfinite(value)', 'ANYPS5_FORMAT_FINITE(value)').replaceAll('std::signbit(value)', 'ANYPS5_FORMAT_NEGATIVE(value)'));
    });
    edit(base + 'src/FormattingWide.cpp', (replace, transform) => {
        replace('                const long double value = args.Next<long double>();',
            '                const LibcDetail::ExtendedFloat value = args.Next<LibcDetail::ExtendedFloat>();');
        transform(source => source.replaceAll('std::isnan(value)', 'ANYPS5_FORMAT_ISNAN(value)').replaceAll('std::isfinite(value)', 'ANYPS5_FORMAT_FINITE(value)').replaceAll('std::signbit(value)', 'ANYPS5_FORMAT_NEGATIVE(value)'));
        replace('                    AppendNumber(out, spec + "L" + narrow, value);',
            '#if defined(__aarch64__)\n' +
            '                    AppendNumber(out, spec + "L" + narrow, LibcDetail::FormatNativeInfinity(value));\n' +
            '#else\n                    AppendNumber(out, spec + "L" + narrow, value);\n#endif');
    });
}
