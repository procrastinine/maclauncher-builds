// SPDX-License-Identifier: GPL-2.0-only
// AgcDriver maps its driver memory (the PS5's 2 MiB at 0xfe0000000, which holds the fetch-shader routine table) at
// 0xee0000000 on macOS, inside the guest arena's system range 0x7FFFFC000-0x1000000000, which the arena leaves to the
// host. In an arm64 process that range lies inside the shared region (0x180000000-0x1000000000 on current macOS), so
// nothing can be mapped there. On arm64 the driver memory goes to 0xFE00000000 instead, above the guest arena's
// application area (which ends at 0xFC00000000). The arm64 start host reserves that window before anything else runs
// (AnyPS5FexStart.cpp, DriverWindow), so the driver maps over its own reservation. The x86-64 builds are unchanged.
import fs from 'node:fs';
import path from 'node:path';

export function applyDriverMemoryWindow(root) {
    const file = path.join(root, 'core/libs/prx/libSceAgcDriver/Execution/src/Driver/Lifecycle.cpp');
    let source = fs.readFileSync(file, 'utf8');
    const edits = [
        ['#ifdef __APPLE__\nconstexpr std::uint64_t DriverMemoryAddress = MacOsDriverMemoryBase;\n',
         '#if defined(__APPLE__) && defined(__aarch64__)\nconstexpr std::uint64_t DriverMemoryAddress = 0xFE00000000ull;\n' +
         'constexpr std::size_t DriverMemoryBytes = DriverMemorySpan;\n' +
         'constexpr std::uint64_t FsTableAddress = DriverMemoryAddress + (0xfe0040000ull - Ps5DriverMemoryBase);\n' +
         '#elif defined(__APPLE__)\nconstexpr std::uint64_t DriverMemoryAddress = MacOsDriverMemoryBase;\n'],
        ['#elif defined(__APPLE__)\n    mapped = mmap(reinterpret_cast<void*>(DriverMemoryAddress), DriverMemoryBytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);\n',
         '#elif defined(__APPLE__) && defined(__aarch64__)\n' +
         '    mapped = mmap(reinterpret_cast<void*>(DriverMemoryAddress), DriverMemoryBytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);\n' +
         '    if (mapped == MAP_FAILED) throw std::system_error(errno, std::generic_category(), "map the AGC driver memory");\n' +
         '#elif defined(__APPLE__)\n    mapped = mmap(reinterpret_cast<void*>(DriverMemoryAddress), DriverMemoryBytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);\n'],
    ];
    for (const [before, after] of edits) {
        if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw Error('Driver memory boundary changed: ' + file);
        source = source.replace(before, after);
    }
    fs.writeFileSync(file, source);
}
