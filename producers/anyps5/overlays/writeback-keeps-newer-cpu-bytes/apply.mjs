// SPDX-License-Identifier: GPL-2.0-only
// A storage image write-back never stores GPU results over bytes the CPU wrote after those results became pending.
// StorageTexture::writeBackLayers stored a unit whose layer had no tracking generation whole, and over a drawn
// rectangle it stored the drawn spans over 64 KiB blocks the CPU had written. Inside one registration (a game heap that
// holds both GPU surfaces and allocator blocks) memory the game freed and reallocated after the GPU wrote it then
// received the stale results, allocator headers included. Each block of a stored layer is now checked against the
// layer's pending generation (layerPendingSince): a block with a CPU stamp newer than it keeps the CPU's bytes, on
// every path. APS5_WRITEBACK_LOG=<file> appends every write-back and refresh decision there, uncapped, one write per line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function applyWriteBackKeepsNewerCpuBytes(root) {
  const file = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics/src/Texture.cpp');
  let source = fs.readFileSync(file, 'utf8');
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, 'source boundary changed: ' + before);
    source = source.replace(before, () => after);
  };
  replace('#include <mutex>\n', '#include <mutex>\n#include <cstdarg>\n#include <fcntl.h>\n');
  replace('namespace AgcDriver::Graphics {\n', `namespace AgcDriver::Graphics {\n
// APS5_WRITEBACK_LOG=<file>: every write-back and refresh decision, appended uncapped, one write(2) per line, so the
// lines before a fault are on disk.
void WriteBackLog(const char* format, ...) {
    static const int fd = [] {
        const char* path = std::getenv("APS5_WRITEBACK_LOG");
        return path != nullptr && path[0] != '\\0' ? ::open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644) : -1;
    }();
    if (fd < 0) return;
    char line[2048];
    va_list arguments;
    va_start(arguments, format);
    const int length = std::vsnprintf(line, sizeof(line), format, arguments);
    va_end(arguments);
    if (length > 0) static_cast<void>(::write(fd, line, std::min(static_cast<std::size_t>(length), sizeof(line) - 1)));
}

// Whether the CPU stamped [from, to) (inside one 64 KiB tracker block) after \`since\`, the generation at which the
// layer's GPU results became pending.
bool CpuNewerThanResults(std::uint64_t from, std::uint64_t to, std::uint64_t since) {
    if (since == 0 || to <= from) return false;
    const std::array<std::uint64_t, 1> generations{since};
    std::array<std::uint8_t, 1> changed{};
    std::array<std::uint8_t, 1> cpu{};
    return GuestMemory::ChangedBlocks(from, static_cast<std::size_t>(to - from), generations, changed, cpu) && cpu[0] != 0;
}
`);
  // A layer without a tracking generation is stored whole only when no block of it carries a CPU stamp newer than its
  // results; otherwise it goes through the block walk, which stores every block but those.
  replace('        if (unknown && !drawn.rect) {\n',
    '        bool cpuNewerAny = false;\n' +
    '        if (tracked && layerPendingSince[layer] != 0) {\n' +
    '            for (auto at = begin & ~(block - 1); at < end && !cpuNewerAny; at += block) cpuNewerAny = CpuNewerThanResults(std::max(at, begin), std::min(at + block, end), layerPendingSince[layer]);\n' +
    '        }\n' +
    '        if (unknown && !drawn.rect && !cpuNewerAny) {\n');
  replace('            const bool kept = keptAtUnwatchHolds(from, layer);\n',
    '            if (cpuNewerAny && CpuNewerThanResults(from, to, layerPendingSince[layer])) {\n' +
    '                WriteBackLog("keep-newer-cpu image=0x%llx layer=%u block=0x%llx+0x%llx pendingSince=%llu reason=%s drawnRect=%d unknown=%d\\n", static_cast<unsigned long long>(descriptor.baseAddress), layer,\n' +
    '                    static_cast<unsigned long long>(from), static_cast<unsigned long long>(to - from), static_cast<unsigned long long>(layerPendingSince[layer]), flushReason != nullptr ? flushReason : "?", drawn.rect ? 1 : 0, unknown ? 1 : 0);\n' +
    '                skippedAny = true;\n' +
    '                skippedLayer[layer] = true;\n' +
    '                keptBlocks.emplace_back(from, layer);\n' +
    '                ++skipped;\n' +
    '                continue;\n' +
    '            }\n' +
    '            if (unknown && !drawn.rect) {\n' +
    '                if (!keep.empty() && keep.back().second == from) keep.back().second = to;\n' +
    '                else keep.emplace_back(from, to);\n' +
    '                continue;\n' +
    '            }\n' +
    '            const bool kept = keptAtUnwatchHolds(from, layer);\n');
  replace('    for (std::uint32_t layer = 0; layer < trackedLayers; ++layer) {\n        if (layers[layer]) forgetKeptAtUnwatch(layer);\n    }\n',
    '    {\n' +
    '        std::string ranges;\n' +
    '        for (const auto& [from, to] : keep) ranges += " 0x" + [](std::uint64_t value) { char text[24]; std::snprintf(text, sizeof(text), "%llx", static_cast<unsigned long long>(value)); return std::string(text); }(from) + "+0x" + [](std::uint64_t value) { char text[24]; std::snprintf(text, sizeof(text), "%llx", static_cast<unsigned long long>(value)); return std::string(text); }(to - from);\n' +
    '        WriteBackLog("writeback image=0x%llx bytes=0x%llx reason=%s tracked=%d drawnRect=%d stores=%zu kept=%zu:%s\\n", static_cast<unsigned long long>(descriptor.baseAddress), static_cast<unsigned long long>(guestBytes),\n' +
    '            flushReason != nullptr ? flushReason : "?", tracked ? 1 : 0, drawn.rect ? 1 : 0, keep.size(), skipped, ranges.c_str());\n' +
    '    }\n' +
    '    for (std::uint32_t layer = 0; layer < trackedLayers; ++layer) {\n        if (layers[layer]) forgetKeptAtUnwatch(layer);\n    }\n');
  // The refresh decision per pending layer: dropped (CPU changed it and the unit is droppable) or stored.
  replace('            if (blockUnits && droppable(layer)) {\n',
    '            const bool canDrop = blockUnits && droppable(layer);\n' +
    '            WriteBackLog("refresh image=0x%llx layer=%u changed=1 dropped=%d blockUnits=%d\\n", static_cast<unsigned long long>(descriptor.baseAddress), layer, canDrop ? 1 : 0, blockUnits ? 1 : 0);\n' +
    '            if (canDrop) {\n');
  fs.writeFileSync(file, source);
}
