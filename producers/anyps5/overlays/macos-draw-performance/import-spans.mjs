import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 import copy source changed: ' + before.slice(0, 80));
  return source.replace(before, after);
}

export async function applyImportSpansOverlay(root) {
  const base = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics');
  const header = path.join(base, 'include/GuestBufferMemory.hpp');
  let declarations = await fs.readFile(header, 'utf8');
  declarations = replace(declarations, 'class GuestBufferMemory {', `#ifdef __APPLE__
struct GuestCopySpan {
    VkBuffer buffer;
    std::uint64_t base;
    std::uint64_t begin;
    std::uint64_t end;
};
#endif

class GuestBufferMemory {`);
  declarations = replace(declarations, '        std::uint64_t copySourceBase = 0;',
    '        std::uint64_t copySourceBase = 0;\n#ifdef __APPLE__\n        std::vector<GuestCopySpan> copySpans;\n#endif');
  await fs.writeFile(header, declarations);
  const file = path.join(base, 'src/GuestBufferMemory.cpp');
  let source = await fs.readFile(file, 'utf8');
  source = replace(source, 'const HostImport* findImport(HostImports& state, std::uint64_t begin, std::uint64_t end) {', `#ifdef __APPLE__
std::vector<GuestCopySpan> importSpans(const Context& context, HostImports& state, std::uint64_t begin, std::uint64_t end, const GuestAllocations::Lease& lease) {
    const auto epoch = state.epoch;
    std::vector<GuestCopySpan> spans;
    for (auto cursor = begin; cursor < end;) {
        const auto* entry = findImport(state, cursor, cursor + 1);
        if (entry == nullptr && containingRange(lease, cursor, cursor + 1) != nullptr)
            entry = importAllocation(context, state, cursor, lease, ImportRequester::Build, cursor + 1, false);
        if (entry == nullptr) return {};
        const auto last = std::min(end, entry->base + entry->bytes);
        if (last <= cursor) return {};
        spans.push_back({entry->buffer, entry->base - entry->lead, cursor, last});
        cursor = last;
    }
    if (state.epoch != epoch) return {};
    return spans;
}
#endif

const HostImport* findImport(HostImports& state, std::uint64_t begin, std::uint64_t end) {`);
  source = replace(source, '            const bool staged = recorder != nullptr && stagingEligible(region, addressable);', `#ifdef __APPLE__
            region.copySpans.clear();
            if (entry == nullptr && recorder != nullptr && gpuCopiesEnabled() && !region.sparse && (region.hostBacked || region.writable))
                region.copySpans = importSpans(context, state, region.begin, region.end, importRanges());
#endif
            const bool staged = recorder != nullptr && stagingEligible(region, addressable);`);
  source = replace(source, '                region.copySourceBase = entry->base - entry->lead;\n            }',
    '                region.copySourceBase = entry->base - entry->lead;\n#ifdef __APPLE__\n            } else if (!region.copySpans.empty()) {\n                copyOnGpu = true;\n                region.deviceLocal = false;\n                region.copySource = VK_NULL_HANDLE;\n#endif\n            }');
  source = replace(source, '        CopyBuffer(context, commands, copySource, copyOffset, region->buffer->Handle(), 0, bytes);', `#ifdef __APPLE__
        if (inputSnapshot == nullptr && !region->copySpans.empty()) {
            for (const auto& span : region->copySpans)
                CopyBuffer(context, commands, span.buffer, span.begin - span.base, region->buffer->Handle(), span.begin - region->begin, span.end - span.begin);
        } else
#endif
        {
            CopyBuffer(context, commands, copySource, copyOffset, region->buffer->Handle(), 0, bytes);
        }`);
  source = replace(source, '            CopyBuffer(context, commands, region.buffer->Handle(), from - region.begin, region.copySource, from - region.copySourceBase, to - from);', `#ifdef __APPLE__
            if (!region.copySpans.empty()) {
                for (const auto& span : region.copySpans) {
                    const auto first = std::max(from, span.begin);
                    const auto last = std::min(to, span.end);
                    if (first < last) CopyBuffer(context, commands, region.buffer->Handle(), first - region.begin, span.buffer, first - span.base, last - first);
                }
            } else
#endif
            {
                CopyBuffer(context, commands, region.buffer->Handle(), from - region.begin, region.copySource, from - region.copySourceBase, to - from);
            }`);
  await fs.writeFile(file, source);
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * adjacent-import copy spans:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/e10f59a483e247a3f6da67de16e1711e9554b17e
 */
