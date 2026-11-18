// SPDX-License-Identifier: GPL-2.0-only
// Opt-in host events for affected guest ranges, for the Darwin translation host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const apple = text => '#ifdef __APPLE__\n' + text + '#endif\n';
const declaration = apple('extern "C" void MclEventRingNote(const char*, std::uint64_t, std::uint64_t, const char*, std::uint64_t);\n');
const ring = fs.readFileSync(new URL('./EventRing.inc', import.meta.url), 'utf8');
const hooks = fs.readFileSync(new URL('./MapHooks.inc', import.meta.url), 'utf8');

export const ringFiles = [
  'libc/src/GuestArena.cpp', 'libkernel/DirectMemory/DirectMemory.cpp', 'libkernel/File/src/Open.cpp',
  'libkernel/File/src/Stdio.cpp', 'libkernel/Aio/src/Aio.cpp', 'libkernel/Apr/src/Apr.cpp', 'libc/src/Strings.cpp',
];

export function applyEventRing(root) {
  const edit = (relative, change) => {
    const file = path.join(root, 'core/libs/prx', relative);
    let text = fs.readFileSync(file, 'utf8');
    const replace = (before, after) => {
      assert.equal(text.split(before).length, 2, 'event ring source boundary in ' + relative + ': ' + before);
      text = text.replace(before, () => after);
    };
    change(replace);
    fs.writeFileSync(file, text);
  };
  const declare = replace => {
    // The declaration needs integer types and must be outside the source's linkage blocks.
    replace('#include <cstdint>\n', '#include <cstdint>\n' + declaration);
  };
  const note = (kind, address, length, source, detail) =>
    'MclEventRingNote("' + kind + '", reinterpret_cast<std::uintptr_t>(' + address + '), ' + length + ', "' + source + '", ' + detail + ');\n';
  const mapHooks = scope => '#define MCL_RING_FILE "' + scope + '"\n' + hooks;
  edit(ringFiles[0], replace => {
    const scope = '\nnamespace GuestArena {\nnamespace {';
    replace(scope, '\n' + apple('#include <cstring>\n#include <dlfcn.h>\n#include <fcntl.h>\n#include <new>\n#include <pthread.h>\n#include <time.h>\n#include <unistd.h>\n') + mapHooks('GuestArena') + scope);
    const importWrite = 'bool GuestArenaBeginImportWrite_nid_postfix(void* pointer, std::size_t bytes) {\n';
    replace(importWrite, importWrite + '    ' + note('observe', 'pointer', 'bytes', 'import-write-scope', '0'));
    const hostWrite = 'bool GuestArenaBeginHostWrite_nid_postfix(void* pointer, std::size_t bytes) {\n';
    replace(hostWrite, hostWrite + apple('    ' + note('observe', 'pointer', 'bytes', 'host-write-scope', '0')));
    const end = '#ifdef __APPLE__\nbool GuestArenaBeginImportWrite_nid_postfix';
    replace(end, ring + '\n' + end);
  });
  edit(ringFiles[1], replace => {
    const marker = '#include <unistd.h>\n#else\n#include <windows.h>';
    replace(marker, '#include <unistd.h>\n' + mapHooks('DirectMemory') + '#else\n#include <windows.h>');
  });
  edit(ringFiles[2], replace => {
    const header = '#include "prx/libkernel/include/Api.hpp"\n';
    replace(header, header + '#include <cstdint>\n' + declaration);
    const read = '    auto n = destination.Open() ? NativeRead(d, buf, nbytes) : -1;\n';
    replace(read, read + apple('    if (n > 0) ' + note('read', 'buf', 'n', 'Open.sceKernelRead', 'd')));
  });
  const pread = (fd, length, source) => {
    const operation = 'static_cast<std::int64_t>(::pread(' + fd + ', buf, ' + length + ', static_cast<off_t>(offset)))';
    return [
      '    return ' + operation + ';\n',
      '    const auto result = ' + operation + ';\n' +
      apple('    if (result > 0) ' + note('read', 'buf', 'result', source, 'offset')) + '    return result;\n',
    ];
  };
  edit(ringFiles[3], replace => {
    declare(replace);
    replace(...pread('descriptor', 'nbytes', 'Stdio.NativePread'));
    for (const [call, args] of [['readv', ''], ['preadv', ', static_cast<off_t>(offset)']]) {
      const read = '    const auto result = static_cast<std::int64_t>(::' + call + '(d, NativeIovecs(iov), iovcnt' + args + '));\n';
      const observed = '    for (int i = 0; i < iovcnt && remaining > 0; ++i) {\n' +
        '        const auto written = std::min<std::uint64_t>(remaining, iov[i].length);\n' +
        '        ' + note('read', 'iov[i].base', 'written', 'Stdio.' + call, 'd') +
        '        remaining -= written;\n    }\n';
      replace(read, read + apple('    auto remaining = result;\n' + observed));
    }
  });
  edit(ringFiles[4], replace => {
    declare(replace);
    replace(...pread('fd', 'nbyte', 'Aio.pread'));
  });
  edit(ringFiles[5], replace => {
    declare(replace);
    const padding = '    if (read != command.size) std::memset(reinterpret_cast<char*>(command.destination) + read, 0, static_cast<std::size_t>(command.size - read));\n';
    replace(padding,
      apple('    MclEventRingNote("read", command.destination, read, "Apr.read", command.offset);\n') + padding +
      apple('    if (read != command.size) MclEventRingNote("fill", command.destination + read, command.size - read, "Apr.pad", 0);\n'));
  });
  edit(ringFiles[6], replace => {
    declare(replace);
    for (const [call, destination, args, type, length, detail] of [
      ['memset', 's', 'c, n', 'fill', 'n', 'static_cast<unsigned char>(c)'],
      ['memcpy', 'dest', 'src, n', 'copy', 'n', 'reinterpret_cast<std::uintptr_t>(src)'],
      ['memmove', 'dest', 'src, n', 'copy', 'n', 'reinterpret_cast<std::uintptr_t>(src)'],
    ]) {
      const operation = 'std::' + call + '(' + destination + ', ' + args + ')';
      replace('    return ' + operation + ';\n', '    auto* result = ' + operation + ';\n' +
        apple('    ' + note(type, destination, length, 'Strings.' + call, detail)) + '    return result;\n');
    }
    for (const [anchor, type, call, detail] of [
      ['    std::memset(destination, 0, count);\n', 'fill', 'bzero', '0'],
      ['    if (count != 0) std::memmove(destination, source, count);\n', 'copy', 'bcopy', 'reinterpret_cast<std::uintptr_t>(source)'],
    ]) replace(anchor, anchor + apple('    ' + note(type, 'destination', 'count', 'Strings.' + call, detail)));
  });
  edit('libc/src/GuestWriteWatch.cpp', replace => {
    replace('#include "prx/libc/include/GuestWriteWatch.hpp"\n', '#include "prx/libc/include/GuestWriteWatch.hpp"\n' + declaration);
    // The first store to an armed page; the recorded detail is the faulting address (no stack in the fault handler).
    replace('        auto& state = pages[index];\n        if ((state & Protected) != 0) {\n',
      '        auto& state = pages[index];\n        if ((state & Protected) != 0) {\n' +
      '#ifdef __APPLE__\n            MclEventRingNote("cpu-store", page, _page, "cpu-store-fault", address);\n#endif\n');
  });
  edit('libSceAgcDriver/Execution/src/GuestMemory.cpp', replace => {
    replace('namespace AgcDriver::GuestMemory {\nnamespace {\nvoid require(bool condition, const char* reason) {',
      declaration + '\nnamespace AgcDriver::GuestMemory {\nnamespace {\nvoid require(bool condition, const char* reason) {');
    const note = (kind, what, range) => apple('    MclEventRingNote("' + kind + '", ' + range + ', "' + what + '", 0);\n');
    replace('std::uint64_t MarkWritten(std::uint64_t address, std::size_t bytes) {\n',
      'std::uint64_t MarkWritten(std::uint64_t address, std::size_t bytes) {\n' + note('gpu-writeback', 'gpu-or-driver-written', 'address, bytes'));
    replace('std::uint64_t MarkPossiblyWritten(std::uint64_t address, std::size_t bytes) {\n',
      'std::uint64_t MarkPossiblyWritten(std::uint64_t address, std::size_t bytes) {\n' + note('observe', 'gpu-possibly-written', 'address, bytes'));
    replace('std::uint64_t MarkPossiblyWritten(std::uint64_t address, std::size_t bytes, std::uint64_t& order) {\n',
      'std::uint64_t MarkPossiblyWritten(std::uint64_t address, std::size_t bytes, std::uint64_t& order) {\n' + note('observe', 'gpu-possibly-written', 'address, bytes'));
    replace('const std::function<std::pair<std::uint64_t, std::uint64_t>(std::span<std::byte>)>& store, bool complete = true) {\n    if (bytes == 0) return 0;\n',
      'const std::function<std::pair<std::uint64_t, std::uint64_t>(std::span<std::byte>)>& store, bool complete = true) {\n    if (bytes == 0) return 0;\n' + note('observe', 'driver-store-own', 'address, bytes'));
    replace('[[maybe_unused]] std::uint32_t byteStoreLimit, bool keepGuest) {\n    require(current.size() == original.size(), "write-back snapshot sizes differ");\n',
      '[[maybe_unused]] std::uint32_t byteStoreLimit, bool keepGuest) {\n    require(current.size() == original.size(), "write-back snapshot sizes differ");\n' + note('observe', 'driver-write-changed', 'address, current.size()'));
    replace('std::size_t WriteChangedIfHeld(std::uint64_t address, std::span<const std::byte> current, std::span<const std::byte> original, std::uint64_t unchangedSince) {\n',
      'std::size_t WriteChangedIfHeld(std::uint64_t address, std::span<const std::byte> current, std::span<const std::byte> original, std::uint64_t unchangedSince) {\n' + note('observe', 'driver-write-if-held', 'address, current.size()'));
    replace('void Write(std::uint64_t address, std::span<const std::byte> source, std::size_t alignment) {\n    if (source.empty()) return;\n',
      'void Write(std::uint64_t address, std::span<const std::byte> source, std::size_t alignment) {\n    if (source.empty()) return;\n' + note('observe', 'driver-write', 'address, source.size()'));
  });
  const graphics = 'libSceAgcDriver/Graphics/src/';
  edit(graphics + 'Recorder.cpp', replace => {
    replace('#include "prx/libSceAgcDriver/Graphics/include/Recorder.hpp"\n', '#include "prx/libSceAgcDriver/Graphics/include/Recorder.hpp"\n' + declaration);
    // Every GPU write, fill, word fill and reach the recorder notes as pending for its open batch.
    replace('bool Recorder::noteWrite(std::uint64_t address, std::size_t bytes, bool ownLabel, int value, std::int64_t word) {\n',
      'bool Recorder::noteWrite(std::uint64_t address, std::size_t bytes, bool ownLabel, int value, std::int64_t word) {\n' +
      apple('    MclEventRingNote("observe", address, bytes, word >= 0 ? "gpu-pending-word-fill" : value >= 0 ? "gpu-pending-fill" : value == ReachValue ? "gpu-pending-reach" : "gpu-pending-write",\n' +
        '        word >= 0 ? static_cast<std::uint64_t>(word) : value >= 0 ? static_cast<std::uint64_t>(value) : 0);\n'));
    // A write noted on another (already closed) batch; the open batch's case goes through noteWrite.
    replace('void Recorder::noteWriteOn(Batch& batch, std::uint64_t address, std::size_t bytes, bool ownLabel) {\n',
      'void Recorder::noteWriteOn(Batch& batch, std::uint64_t address, std::size_t bytes, bool ownLabel) {\n' +
      apple('    if (&batch != open.get()) MclEventRingNote("observe", address, bytes, "gpu-pending-write-closed-batch", 0);\n'));
  });
  edit(graphics + 'UnitShadow.cpp', replace => {
    replace('#include "prx/libSceAgcDriver/Graphics/include/UnitShadow.hpp"\n', '#include "prx/libSceAgcDriver/Graphics/include/UnitShadow.hpp"\n' + declaration);
    // The guest ranges a publish copies from the slabs into the import (detail: the PublishReason).
    replace('    if (const auto hook = publishSelectedHook.load(std::memory_order_acquire)) hook(ranges.front().first, ranges.front().second);\n',
      apple('    for (const auto& [noteBegin, noteEnd] : ranges) MclEventRingNote("observe", noteBegin, static_cast<std::size_t>(noteEnd - noteBegin), "shadow-publish", static_cast<std::uint64_t>(reason));\n') +
      '    if (const auto hook = publishSelectedHook.load(std::memory_order_acquire)) hook(ranges.front().first, ranges.front().second);\n');
  });
  edit(graphics + 'GuestBufferMemory.cpp', replace => {
    replace('#include "prx/libSceAgcDriver/Graphics/include/GuestBufferMemory.hpp"\n', '#include "prx/libSceAgcDriver/Graphics/include/GuestBufferMemory.hpp"\n' + declaration);
    // Host import lifetimes (detail: the backing serial, or for a retirement whether it is held).
    replace('    const auto [placed, added] = state.imports.emplace(base, entry);\n',
      '    const auto [placed, added] = state.imports.emplace(base, entry);\n' +
      apple('    if (added) MclEventRingNote("import", entry.base, entry.bytes, entry.dmaBuf ? "host-import-created-shared-backing" : "host-import-created", entry.backingSerial);\n'));
    replace('    if (createHostPointerImport(context, entry, failure) != nullptr) return nullptr;\n',
      '    if (createHostPointerImport(context, entry, failure) != nullptr) return nullptr;\n' +
      apple('    MclEventRingNote("import", entry.base, entry.bytes, "host-import-created-unregistered", 0);\n'));
    replace('void retireImport(VkDevice device, HostImports& state, std::map<std::uint64_t, HostImport>::iterator it, const GuestAllocations::Lease& lease, bool hold = true) {\n',
      'void retireImport(VkDevice device, HostImports& state, std::map<std::uint64_t, HostImport>::iterator it, const GuestAllocations::Lease& lease, bool hold = true) {\n' +
      apple('    MclEventRingNote("retire", it->second.base, it->second.bytes, "host-import-retired", hold ? 1 : 0);\n'));
    replace('    ~RetiredImport() {\n        const auto& entry = node.mapped();\n',
      '    ~RetiredImport() {\n        const auto& entry = node.mapped();\n' +
      apple('        MclEventRingNote("retire", entry.base, entry.bytes, "host-import-destroyed-after-retire", 0);\n'));
    replace('void destroyImport(const Context& context, const HostImport& entry) {\n',
      'void destroyImport(const Context& context, const HostImport& entry) {\n' +
      apple('    MclEventRingNote("retire", entry.base, entry.bytes, "host-import-destroyed", 0);\n'));
    // With arm64-shadow-retire-own-registration: a retired unit dropped because a newer registration owns its range.
    const dropped = '    if (ownRegistrationCovers(entry, lease, begin, end)) return true;\n    ++foreign;\n';
    replace(dropped, dropped + apple('    MclEventRingNote("observe", begin, static_cast<std::size_t>(end - begin), "shadow-retire-dropped-foreign-registration", 0);\n'));
  });
}
