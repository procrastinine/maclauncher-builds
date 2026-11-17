# SPDX-License-Identifier: GPL-2.0-only
# Generates the per-signature thunk tables for the AnyPS5 exports that the given arm64 objects define.
#
# Each export is an APS5_VABI function declared in the AnyPS5 headers that its source file includes. Each source that
# defines any of them gets its own generated translation unit, <out>-<n>.cpp, which repeats the preprocessor lines at
# the top of that source (its includes, with a header next to the source named by its path, and the conditions and
# definitions around them) before the host's headers. Each thunk is so instantiated from the export's own prototype
# (SysVThunk.h) in the context the source declares it in, and headers that one source never combines (macOS
# <sys/event.h> and libkernel's Equeue.hpp, for example) stay apart. An export whose name ends in _nid_postfix is
# listed under the name without it, which is the name its NID is computed from. An export several sources declare is
# generated once. A variadic export (snprintf) runs as its va_list counterpart, the export named v<name> (vsnprintf)
# whose last parameter is a VaList*, through SysV::VariadicThunkFor; a variadic export without one is left out.
# Prototypes the thunks do not cover yet compile to nullptr through SysV::ThunkFor.
#
# <out> lists the parts in GeneratedThunkParts, and the exported C data objects named X_nid_postfix (libc's standard
# stream objects, for example) in GeneratedData under X, so a guest data import reads the library's own object.
#
# Usage: generate-thunks.py <out.cpp> <include dir>[:<include dir>...] <source.cpp>... -- <arm64 object>...
#   A header is read from the first include directory that has it (generated headers sit in the CMake build).
# Prints the generated files, one per line; the summary goes to stderr.
import re
import subprocess
import sys

import os

out, includes, rest = sys.argv[1], sys.argv[2].split(':'), sys.argv[3:]
sources, objects = rest[:rest.index('--')], rest[rest.index('--') + 1:]

defined, data = set(), []
for obj in objects:
    listing = subprocess.run(['nm', '-gU', obj], check=True, capture_output=True, text=True).stdout
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[1] in 'TtDdSsBb':
            defined.add(parts[2].removeprefix('_'))
        # A C (unmangled) data symbol: Mach-O adds one leading underscore.
        if len(parts) == 3 and parts[1] in 'DdSsBb' and parts[2].endswith('_nid_postfix') and not parts[2].startswith('__Z'):
            data.append(parts[2])

declaration = re.compile(r'\bAPS5_VABI\s+(\w+)\s*\(([^;{]*)\)\s*(?:noexcept\s*)?;', re.S)
generated, variadic, files = set(), set(), []
counterparts = 0
stem = out.removesuffix('.cpp')
class Unit(list):
    """A generated file's lines, written only when they differ from the file there, so Ninja recompiles only the
    units that changed."""
    def __init__(self, path):
        super().__init__()
        self.path = path

    def write(self, text):
        self.append(text)

    def __enter__(self):
        return self

    def __exit__(self, *error):
        if error[0] is None:
            text = ''.join(self)
            if not os.path.isfile(self.path) or open(self.path, encoding='utf-8').read() != text:
                with open(self.path, 'w', encoding='utf-8') as f:
                    f.write(text)


def namespaces(text):
    """The namespace qualifier ("A::B::") in effect at each APS5_VABI declaration of a header, by its match start:
    `namespace A {` and `namespace A::B {` blocks counted by braces, with comments, strings and character literals
    blanked first so their braces do not count. Other blocks (extern "C", classes, function bodies) add nothing."""
    blank = lambda m: re.sub(r'[^\n]', ' ', m.group(0))
    code = re.sub(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'', blank, text, flags=re.S)
    opening = re.compile(r'\bnamespace\s+([A-Za-z_][\w:]*)\s*\{')
    stack, result, at = [], {}, 0
    starts = sorted(m.start() for m in declaration.finditer(code))
    for position, character in ((m.start(), m.group(0)) for m in re.finditer(r'[{}]', code)):
        while starts and starts[0] < position:
            result[starts.pop(0)] = ''.join(name + '::' for name in stack if name)
        if character == '{':
            named = opening.search(code, at, position + 1)
            stack.append(named.group(1) if named and named.end() == position + 1 else None)
        elif stack:
            stack.pop()
        at = position + 1
    for start in starts:
        result[start] = ''.join(name + '::' for name in stack if name)
    return result


def top_lines(source):
    """The preprocessor lines before the source's first line of code, with any condition still open there closed.
    Includes of .inc, .c and .cpp files are left out, since they define things rather than declare them."""
    lines, headers, depth, comment = [], [], 0, False
    for line in open(source, encoding='utf-8').read().splitlines():
        stripped = line.strip()
        if comment:
            comment = '*/' not in stripped
            continue
        if not stripped or stripped.startswith('//'):
            continue
        if stripped.startswith('/*'):
            comment = '*/' not in stripped
            continue
        if not stripped.startswith('#'):
            break
        directive = (re.match(r'#\s*(\w+)', stripped) or [None, ''])[1]
        if directive in ('if', 'ifdef', 'ifndef'):
            depth += 1
            lines.append(line)
        elif directive in ('elif', 'else'):
            lines.append(line)
        elif directive == 'endif':
            depth -= 1
            lines.append(line)
        elif directive == 'include':
            match = re.match(r'#\s*include\s*([<"])([^>"]+)[>"]', stripped)
            if not match or match.group(2).endswith(('.inc', '.c', '.cpp')):
                continue
            kind, name = match.groups()
            local = os.path.normpath(os.path.join(os.path.dirname(source), name))
            if kind == '"' and not name.startswith('prx/') and os.path.isfile(local):
                lines.append(f'#include "{local}"')
                headers.append(local)
            else:
                lines.append(line)
                if kind == '"' and name.startswith('prx/') and name.endswith('.hpp'):
                    headers.append(name)
        elif directive in ('define', 'undef'):
            lines.append(line)
    return lines + ['#endif'] * depth, headers


for source in sources:
    prelude, headers = top_lines(source)
    headers = list(dict.fromkeys(headers))
    names, prototypes, pending = [], {}, []
    for header in headers:
        found = header if os.path.isabs(header) else next((f'{root}/{header}' for root in includes if os.path.isfile(f'{root}/{header}')), None)
        if found is None:
            raise SystemExit(f'{source}: {header} is in no include directory')
        text = open(found, encoding='utf-8').read()
        scope = namespaces(text)
        for match in declaration.finditer(text):
            prototypes.setdefault(match.group(1), (match.group(2), scope.get(match.start(), '')))
        for match in declaration.finditer(text):
            name, parameters = match.group(1), match.group(2)
            if name not in defined or name.endswith('_nid_no_patch') or name in generated:
                continue
            if '...' in parameters:
                pending.append(name)
                continue
            generated.add(name)
            names.append((name, scope.get(match.start(), '') + name, 'ThunkFor'))
    for name in pending:
        counterpart = 'v' + name
        parameters, qualifier = prototypes.get(counterpart, ('', ''))
        if counterpart in defined and 'VaList' in parameters.rsplit(',', 1)[-1]:
            generated.add(name)
            names.append((name, qualifier + counterpart, 'VariadicThunkFor'))
            counterparts += 1
        else:
            variadic.add(name)
    # A source that defines none of the exports its headers declare (most of AgcDriver's) gets no unit.
    if not names:
        continue
    index = len(files)
    part = f'{stem}-{index}.cpp'
    with Unit(part) as f:
        f.write(f'// Generated by producers/anyps5-fex/host/generate-thunks.py from {source.rsplit("/core/libs/", 1)[-1]}; not edited by hand.\n')
        # The source's own lines come first, as in the source: the host headers bring macOS system headers, such as
        # <sys/event.h>, whose macros would replace names those headers declare.
        f.write('\n'.join(prelude) + '\n')
        f.write('#include "SysVThunk.h"\n')
        f.write(f'\nextern const std::pair<const char*, FexGuest::Thunk> GeneratedThunks{index}[] = {{\n')
        for name, export, thunk in sorted(names):
            f.write(f'  {{"{name.removesuffix("_nid_postfix")}", SysV::{thunk}<&::{export}>()}},\n')
        f.write('  {nullptr, nullptr},\n};\n')
        f.write(f'extern const std::size_t GeneratedThunkCount{index} = {len(names)};\n')
    files.append(part)

with Unit(out) as f:
    f.write('// Generated by producers/anyps5-fex/host/generate-thunks.py; not edited by hand.\n')
    f.write('#include "FexGuest.h"\n\n#include <utility>\n\n')
    for index in range(len(files)):
        f.write(f'extern const std::pair<const char*, FexGuest::Thunk> GeneratedThunks{index}[];\n')
        f.write(f'extern const std::size_t GeneratedThunkCount{index};\n')
    f.write('extern const std::pair<const std::pair<const char*, FexGuest::Thunk>*, const std::size_t*> GeneratedThunkParts[] = {\n')
    for index in range(len(files)):
        f.write(f'  {{GeneratedThunks{index}, &GeneratedThunkCount{index}}},\n')
    f.write('};\n')
    f.write(f'extern const std::size_t GeneratedThunkPartCount = {len(files)};\n')
    if variadic:
        f.write('// Variadic exports left out: ' + ', '.join(sorted(variadic)) + '\n')
    symbols = sorted(set(data))
    for i, symbol in enumerate(symbols):
        f.write(f'extern "C" char GeneratedData{i} __asm__("{symbol}");\n')
    f.write('extern const std::pair<const char*, void*> GeneratedData[] = {\n')
    for i, symbol in enumerate(symbols):
        f.write(f'  {{"{symbol[1:].removesuffix("_nid_postfix")}", &GeneratedData{i}}},\n')
    f.write('  {nullptr, nullptr},\n};\n')
    f.write(f'extern const std::size_t GeneratedDataCount = {len(symbols)};\n')
files.insert(0, out)
parts = len(files) - 1
print(f'{len(generated)} generated thunks in {parts} parts from {len(sources)} sources ({counterparts} variadic through their va_list counterparts), '
      f'{len(variadic)} variadic exports left out, '
      f'{len(set(data))} data objects', file=sys.stderr)
print('\n'.join(files))
