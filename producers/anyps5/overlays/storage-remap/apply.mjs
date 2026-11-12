// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 storage image write-back source changed: ' + before.slice(0, 100));
  return source.replace(before, after);
}

// Pending storage results belong to registered allocation ownership, which survives protection and
// backing renewal. A new allocation over an old address invalidates only its overlapping units.
export async function applyStorageRemapOverlay(root) {
  const allocationHeader = path.join(root, 'core/libs/prx/libc/include/GuestAllocations.hpp');
  let allocation = await fs.readFile(allocationHeader, 'utf8');
  allocation = replace(allocation, '    std::uint64_t backingSerial = 0;\n',
    '    std::uint64_t backingSerial = 0;\n    // Stable across protection changes and backing renewal; new registrations get a new identity.\n    std::uint64_t allocationSerial = backingSerial;\n');
  await fs.writeFile(allocationHeader, allocation);
  const allocationSource = path.join(root, 'core/libs/prx/libc/src/GuestAllocations.cpp');
  let registry = await fs.readFile(allocationSource, 'utf8');
  registry = replace(registry, 'range.releasable, gpuMapped, backing}',
    'range.releasable, gpuMapped, backing, range.allocationSerial}');
  await fs.writeFile(allocationSource, registry);
  const base = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics');
  const headerFile = path.join(base, 'include/Texture.hpp');
  let header = await fs.readFile(headerFile, 'utf8');
  header = replace(header, '    std::vector<BaselineMiss> pendingMiss;\n',
    '    std::vector<BaselineMiss> pendingMiss;\n    // Registered allocation spans under each unit when its results became pending.\n    std::vector<std::vector<std::array<std::uint64_t, 3>>> pendingBacking;\n');
  await fs.writeFile(headerFile, header);

  const file = path.join(base, 'src/Texture.cpp');
  let source = await fs.readFile(file, 'utf8');
  source = replace(source, '        pendingMiss.assign(trackedLayers, BaselineMiss::None);\n',
    '        pendingMiss.assign(trackedLayers, BaselineMiss::None);\n        pendingBacking.resize(trackedLayers);\n');
  source = replace(source, 'void StorageTexture::markLayersPending(std::uint32_t first, std::uint32_t count) {\n', `namespace {

// A span records [begin, end) and stable allocation ownership, independently of backing renewal.
using AllocationSpans = std::vector<std::array<std::uint64_t, 3>>;
AllocationSpans UnitBacking(const GuestAllocations::Lease& lease, std::uint64_t begin, std::uint64_t bytes) {
    AllocationSpans result;
    const auto end = begin + bytes;
    auto it = std::upper_bound(lease.begin(), lease.end(), begin, [](std::uint64_t value, const auto& range) { return value < range->address; });
    if (it != lease.begin()) --it;
    for (; it != lease.end(); ++it) {
        const auto& range = *it;
        if (range->address >= end) break;
        const auto first = std::max(begin, range->address);
        const auto last = std::min(end, range->address + range->bytes);
        if (first >= last || range->allocationSerial == 0) continue;
        if (!result.empty() && result.back()[1] == first && result.back()[2] == range->allocationSerial) result.back()[1] = last;
        else result.push_back({first, last, range->allocationSerial});
    }
    return result;
}

bool BackingReallocated(const AllocationSpans& pending, const AllocationSpans& current) {
    std::size_t before = 0, now = 0;
    while (before < pending.size() && now < current.size()) {
        const auto& old = pending[before];
        const auto& next = current[now];
        if (old[0] < next[1] && next[0] < old[1] && old[2] != next[2]) return true;
        if (old[1] <= next[1]) ++before;
        else ++now;
    }
    return false;
}

}

void StorageTexture::markLayersPending(std::uint32_t first, std::uint32_t count) {
`);
  source = replace(source, '        layerPending.SetRange(first, count, true);\n    }\n    const auto pendingSince = GuestMemory::TrackerGeneration();\n', `        {
            const auto lease = GuestAllocations::GuestAllocationsAcquireAll_nid_postfix();
            for (std::uint32_t layer = first; layer < first + count; ++layer) {
                if (!layerPending[layer]) pendingBacking[layer] = UnitBacking(lease, layerBegin(layer), layerBytes(layer));
            }
        }
        layerPending.SetRange(first, count, true);
    }
    const auto pendingSince = GuestMemory::TrackerGeneration();
`);
  source = replace(source, '    if (lastStored <= firstStored) return;\n    struct ReleaseReadTrap {\n', `    if (lastStored <= firstStored) return;
    {
        static const bool unregisteredDrop = std::getenv("APS5_NO_UNREGISTERED_DROP") == nullptr;
        std::size_t moved = 0;
        std::vector<bool> remaining;
        if (unregisteredDrop) {
            const auto lease = GuestAllocations::GuestAllocationsAcquireAll_nid_postfix();
            for (std::uint32_t layer = 0; layer < trackedLayers; ++layer) {
                if (layers[layer] && layerPending[layer] && BackingReallocated(pendingBacking[layer], UnitBacking(lease, layerBegin(layer), layerBytes(layer)))) {
                    if (remaining.empty()) remaining = layers;
                    remaining[layer] = false;
                    ++moved;
                }
            }
        }
        if (moved != 0) {
            static std::atomic<int> reports{0};
            if (reports.fetch_add(1) < 4) std::fprintf(stderr, "[gpu] storage image 0x%llx+0x%llx: memory re-registered under another allocation since %zu units became pending; their results are dropped\\n", static_cast<unsigned long long>(descriptor.baseAddress), static_cast<unsigned long long>(guestBytes), moved);
            unregisteredDropped.fetch_add(1, std::memory_order_relaxed);
            for (std::uint32_t layer = 0; layer < trackedLayers; ++layer) {
                if (!layers[layer] || remaining[layer]) continue;
                layerOriginal[layer] = false;
                cancelStoredSave(layer);
                layerPending[layer] = false;
            }
            if (std::any_of(remaining.begin(), remaining.end(), [](bool selected) { return selected; })) writeBackLayers(remaining);
            else releaseReadTraps(false);
            return;
        }
    }
    struct ReleaseReadTrap {
`);
  source = replace(source, '+ BaselineMissText(pendingMiss[layer]) + ")";',
    '+ BaselineMissText(pendingMiss[layer]) + "; its memory " + (DirectMemoryAliased_nid_postfix(static_cast<std::uintptr_t>(begin), static_cast<std::size_t>(end - begin)) ? "is also mapped at another address" : "has no other mapping") + ", allocation " + (pendingBacking[layer].empty() ? "unregistered when pending" : BackingReallocated(pendingBacking[layer], UnitBacking(GuestAllocations::GuestAllocationsAcquireAll_nid_postfix(), begin, end - begin)) ? "changed" : "unchanged") + ")";');
  await fs.writeFile(file, source);
  return ['core/libs/prx/libc/include/GuestAllocations.hpp', 'core/libs/prx/libc/src/GuestAllocations.cpp', 'core/libs/prx/libSceAgcDriver/Graphics/include/Texture.hpp', 'core/libs/prx/libSceAgcDriver/Graphics/src/Texture.cpp'];
}
