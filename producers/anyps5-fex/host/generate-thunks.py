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
# A struct an export takes or returns by value gets a SysV::SysVEightbytes specialization in the unit, listing its
# members (SYSV_FIELD), when the AnyPS5 tree defines a struct of that name exactly once and its members are plain
# declarations; nested structs are listed by their own members. SysV::Classify computes the eightbyte classes from the
# list and checks it against the compiled layout, so a list that misses a member leaves the prototype uncovered.
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
structs = struct_index(includes[0])
structs_listed = []
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


def blank_comments(text):
    """text with comments, strings and character literals blanked (newlines kept), so their braces do not count."""
    blank = lambda m: re.sub(r'[^\n]', ' ', m.group(0))
    return re.sub(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'', blank, text, flags=re.S)


def closing(code, opening):
    """The index of the brace that closes the one at opening."""
    depth = 0
    for index in range(opening, len(code)):
        if code[index] == '{':
            depth += 1
        elif code[index] == '}':
            depth -= 1
            if depth == 0:
                return index
    return -1


def struct_index(root):
    """Struct bodies of the AnyPS5 tree by name; a name defined more than once maps to None."""
    index = {}
    head = re.compile(r'\b(?:struct|class)\s+(?:alignas\s*\([^)]*\)\s*)?(\w+)\s*(?:final\s*)?\{')
    anonymous = re.compile(r'\btypedef\s+struct\s*(?:\w+\s*)?\{')
    for directory, _, names in os.walk(root):
        for file in names:
            if not file.endswith(('.hpp', '.h')):
                continue
            code = blank_comments(open(os.path.join(directory, file), encoding='utf-8', errors='replace').read())
            for match in head.finditer(code):
                before = code[max(0, match.start() - 200):match.start()]
                if re.search(r'\benum\s*$', before) or re.search(r'template\s*<[^{};]*>\s*$', before):
                    continue
                end = closing(code, match.end() - 1)
                if end > 0:
                    name = match.group(1)
                    index[name] = None if name in index else code[match.end():end]
            for match in anonymous.finditer(code):
                end = closing(code, match.end() - 1)
                named = re.match(r'\s*(\w+)\s*;', code[end + 1:]) if end > 0 else None
                if named:
                    name = named.group(1)
                    index[name] = None if name in index else code[match.end():end]
    return index


def split_top(text, separator):
    """text split at separator outside (), [], {} and <>."""
    parts, depth, current = [], 0, ''
    for character in text:
        if character in '([{<':
            depth += 1
        elif character in ')]}>':
            depth -= 1
        if character == separator and depth == 0:
            parts.append(current)
            current = ''
        else:
            current += character
    return parts + [current]


def members(body, structs, prefix=''):
    """(member designators, has bit-fields) for a struct body, or None when a declaration is not a plain member: an
    access specifier other than public, a nested type, a template, a virtual function, an array of structs."""
    designators, bitfields = [], False
    statements, depth, current = [], 0, ''
    for character in body:
        current += character
        if character in '({':
            depth += 1
        elif character in ')}':
            depth -= 1
            if character == '}' and depth == 0:
                statements.append(current)
                current = ''
        elif character == ';' and depth == 0:
            statements.append(current[:-1])
            current = ''
    for statement in statements:
        text = ' '.join(statement.split())
        text = re.sub(r'^(public\s*:\s*)+', '', text)
        if not text:
            continue
        if re.match(r'(private|protected)\s*:', text) or text.startswith(('template', 'union', 'class ')) or 'virtual' in text:
            return None
        if text.startswith('struct ') and '{' in text:
            return None
        if text.startswith(('static ', 'static_assert', 'using ', 'typedef ', 'friend ', 'enum ', 'struct ')):
            continue
        if '(' in text:
            pointer = re.search(r'\(\s*\*\s*(\w+)\s*\)\s*\(', text)
            if pointer:
                designators.append(prefix + pointer.group(1))
            continue  # a member function or constructor
        text = re.sub(r'\s*(=.*|\{.*\})$', '', text)
        if re.search(r'(?<!:):(?!:)\s*\w+\s*$', text):
            bitfields = True
            continue
        declarators = split_top(text, ',')
        first = re.match(r'(.*?)([*&\s]*)(\w+)\s*((?:\[[^\]]*\]\s*)*)$', declarators[0])
        if not first:
            return None
        kind = first.group(1).strip()
        kind_name = re.sub(r'\b(const|volatile|mutable|struct)\b', '', kind).strip().split('::')[-1]
        for declarator in declarators:
            parsed = re.match(r'.*?([*&\s]*)(\w+)\s*((?:\[[^\]]*\]\s*)*)$', declarator.strip())
            if not parsed:
                return None
            pointer, name, extent = parsed.groups()
            if kind_name in structs and '*' not in pointer and '&' not in pointer:
                nested = structs[kind_name]
                if nested is None or extent:
                    return None
                inner = members(nested, structs, prefix + name + '.')
                if inner is None:
                    return None
                designators += inner[0]
                bitfields = bitfields or inner[1]
            else:
                designators.append(prefix + name)
    return designators, bitfields


def by_value_struct(type_text, structs):
    """The struct name a parameter or result type names by value, when the tree defines it once; None otherwise."""
    text = re.sub(r'\s*=.*$', '', type_text).strip()
    if not text or any(mark in text for mark in '*&([<'):
        return None
    words = [word for word in re.findall(r'[\w:]+', text) if word not in ('const', 'volatile', 'struct', 'class', 'extern', 'static', 'inline')]
    if len(words) == 2:
        words = words[:1]  # the parameter's name
    if len(words) != 1:
        return None
    name = words[0].split('::')[-1]
    return name if structs.get(name) is not None else None


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
                if kind == '"' and name.startswith('prx/') and name.endswith(('.hpp', '.h')):
                    headers.append(name)
        elif directive in ('define', 'undef'):
            lines.append(line)
    return lines + ['#endif'] * depth, headers


for source in sources:
    prelude, headers = top_lines(source)
    headers = list(dict.fromkeys(headers))
    names, prototypes, pending = [], {}, []
    # The AnyPS5 headers those headers include declare exports too (libSceMsgDialog.native.hpp includes
    # libSceMsgDialog's Api.hpp for everything but sceMsgDialogGetResult).
    for header in headers:
        found = header if os.path.isabs(header) else next((f'{root}/{header}' for root in includes if os.path.isfile(f'{root}/{header}')), None)
        if found is None:
            raise SystemExit(f'{source}: {header} is in no include directory')
        text = open(found, encoding='utf-8').read()
        for nested in re.findall(r'^\s*#\s*include\s*"(prx/[^"]+\.(?:hpp|h))"', text, re.M):
            if nested not in headers:
                headers.append(nested)
        scope = namespaces(text)
        code = blank_comments(text)
        for match in declaration.finditer(text):
            start = max(code.rfind(mark, 0, match.start()) for mark in ';{}')
            result = ' '.join(line for line in code[start + 1:match.start()].split('\n') if not line.strip().startswith('#'))
            result = re.sub(r'^\s*(extern\b\s*(?:"C")?|\[\[[^\]]*\]\]|\s)*', '', result)
            prototypes.setdefault(match.group(1), (match.group(2), scope.get(match.start(), ''), result))
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
        parameters, qualifier, _ = prototypes.get(counterpart, ('', '', ''))
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
        # The structs these exports pass by value, each once: its members for SysV::Classify.
        listed = set()
        for name, export, thunk in sorted(names):
            parameters, _, result = prototypes[export.split('::')[-1]]
            types = [(f'SysV::Result<&::{export}>', result)]
            types += [(f'SysV::Parameter<&::{export}, {i}>', p) for i, p in enumerate(split_top(parameters, ',')) if p.strip() not in ('', 'void')]
            for alias, text in types:
                struct = by_value_struct(text, structs)
                if struct is None or struct in listed:
                    continue
                parsed = members(structs[struct], structs)
                if not parsed or (not parsed[0] and not parsed[1]):
                    continue
                listed.add(struct)
                fields = ', '.join(f'SYSV_FIELD(T, {designator})' for designator in parsed[0]) or 'SysV::Field {0, 0, 1, false, false}'
                f.write(f'template<>\nstruct SysV::SysVEightbytes<{alias}> {{ // {struct}\n'
                        f'  using T = {alias};\n'
                        f'  static constexpr SysV::Field Fields[] = {{{fields}}};\n'
                        f'  static constexpr SysV::Classification Classified = SysV::Classify<T>(Fields, {"true" if parsed[1] else "false"});\n'
                        f'  static constexpr bool Valid = Classified.Valid;\n'
                        f'  static constexpr std::array<char, 2> Classes = Classified.Classes;\n}};\n')
                structs_listed.append(struct)
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
      f'{len(variadic)} variadic exports left out, {len(set(structs_listed))} by-value structs listed, '
      f'{len(set(data))} data objects', file=sys.stderr)
print('\n'.join(files))
