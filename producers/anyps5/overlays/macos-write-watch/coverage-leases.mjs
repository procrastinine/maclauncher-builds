import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 allocation snapshot source changed: ' + before.slice(0, 80));
  return source.replace(before, after);
}

export async function applyCoverageLeasesOverlay(root) {
  const base = path.join(root, 'core/libs/prx/libc/src');
  const watchFile = path.join(base, 'GuestWriteWatch.cpp');
  const original = await fs.readFile(watchFile, 'utf8');
  const begin = original.indexOf('#elif defined(__APPLE__)\nclass Watch {');
  if (begin < 0) throw Error('AnyPS5 Apple write-watch source changed');
  let watch = original.slice(begin);
  watch = replace(watch, '        _ranges.emplace(begin, Range{end, std::move(pages)});',
    '        _ranges.emplace(begin, Range{end, std::move(pages)});\n        publishCoverage();');
  watch = replace(watch, '        return erase(begin, end);',
    '        const bool removed = erase(begin, end);\n        if (removed) publishCoverage();\n        return removed;');
  watch = replace(watch, `    bool Covers(std::uintptr_t begin, std::uintptr_t end) {
        if (!_available) return false;
        const Lock lock(_lock);
        return covers(begin, end);
    }`, `    bool Covers(std::uintptr_t begin, std::uintptr_t end) {
        if (!_available) return false;
        const auto coverage = _coverage.load(std::memory_order_acquire);
        if (coverage == nullptr) return false;
        auto it = std::upper_bound(coverage->begin(), coverage->end(), begin, [](std::uintptr_t address, const auto& run) { return address < run.first; });
        if (it == coverage->begin()) return false;
        --it;
        return begin < it->second && end <= it->second;
    }`);
  watch = replace(watch, '    std::uintptr_t pageStart(std::uintptr_t address) const {', `    void publishCoverage() {
        auto built = std::make_shared<std::vector<std::pair<std::uintptr_t, std::uintptr_t>>>();
        built->reserve(_ranges.size());
        for (const auto& [first, range] : _ranges) {
            if (!built->empty() && first <= built->back().second) built->back().second = std::max(built->back().second, range.end);
            else built->emplace_back(first, range.end);
        }
        _coverage.store(std::move(built), std::memory_order_release);
    }

    std::uintptr_t pageStart(std::uintptr_t address) const {`);
  watch = replace(watch, '    std::map<std::uintptr_t, Range> _ranges;',
    '    std::map<std::uintptr_t, Range> _ranges;\n    AtomicSharedPtr<const std::vector<std::pair<std::uintptr_t, std::uintptr_t>>> _coverage;');
  await fs.writeFile(watchFile, '#ifdef __APPLE__\n#include "prx/libc/include/general/AtomicSharedPtr.hpp"\n#endif\n' + original.slice(0, begin) + watch);

  const file = path.join(base, 'GuestAllocations.cpp');
  let source = await fs.readFile(file, 'utf8');
  source = '#ifdef __APPLE__\n#include "prx/libc/include/general/AtomicSharedPtr.hpp"\n#endif\n' + source;
  source = replace(source, '    std::shared_ptr<const Lease::Ranges> readableLease;',
    '#ifdef __APPLE__\n    AtomicSharedPtr<const Lease::Ranges> readableLease;\n#else\n    std::shared_ptr<const Lease::Ranges> readableLease;\n#endif');
  source = replace(source, 'std::uint64_t freshBacking() {', `std::shared_ptr<const Lease::Ranges> heldReadableLease() {
#ifdef __APPLE__
    return registry().readableLease.load(std::memory_order_acquire);
#else
    return registry().readableLease;
#endif
}

void setReadableLease(std::shared_ptr<const Lease::Ranges> lease) {
#ifdef __APPLE__
    registry().readableLease.store(std::move(lease), std::memory_order_release);
#else
    registry().readableLease = std::move(lease);
#endif
}

std::uint64_t freshBacking() {`);
  if (source.split('registry().readableLease.reset();').length !== 4) throw Error('AnyPS5 readable lease invalidation source changed');
  source = source.replaceAll('registry().readableLease.reset();', 'setReadableLease(nullptr);');
  source = replace(source, `Lease GuestAllocationsAcquire_nid_postfix() {
    std::lock_guard lock(registry().mutex);
    if (auto shared = registry().readableLease) return Lease(std::move(shared));`, `Lease GuestAllocationsAcquire_nid_postfix() {
#ifdef __APPLE__
    if (auto shared = heldReadableLease()) return Lease(std::move(shared));
#endif
    std::lock_guard lock(registry().mutex);
    if (auto shared = heldReadableLease()) return Lease(std::move(shared));`);
  source = replace(source, '    registry().readableLease = ranges;', '    setReadableLease(ranges);');
  await fs.writeFile(file, source);
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * published write-watch coverage:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/252aa9e609e84c863bc0444756bb640d975ea75b
 * readable lease acquisition:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/36c55cd1865d8d20d07c8a2d229a0ac038da1a6d
 */
