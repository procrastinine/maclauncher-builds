// SPDX-License-Identifier: GPL-2.0-only
// A retiring host import publishes its unit shadow only into its own registration. retireImport handed RetireShadow a
// rule that accepted any readable registered range covering a unit, so a unit whose memory a newer allocation had taken
// over (the import's registration released, a new one registered at the same addresses) received the retired surface's
// shadowed results through a GPU copy into the old import buffer, over the new allocation's bytes. A unit is now published
// only where every registered range covering it carries the import's own allocation identity and backing generation;
// the others are dropped and counted on stderr.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function applyShadowRetireOwnRegistration(root) {
  const file = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics/src/GuestBufferMemory.cpp');
  let source = fs.readFileSync(file, 'utf8');
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, 'source boundary changed: ' + before);
    source = source.replace(before, () => after);
  };
  replace('bool joinedCovers(const GuestAllocations::Lease& lease, std::uint64_t begin, std::uint64_t end);\n',
    'bool joinedCovers(const GuestAllocations::Lease& lease, std::uint64_t begin, std::uint64_t end);\n' +
    'bool retirePublishes(const HostImport& entry, const GuestAllocations::Lease& lease, std::uint64_t begin, std::uint64_t end, std::uint64_t& foreign);\n');
  replace('    RetireShadow(device, it->second, [&lease, joined = it->second.joined](std::uint64_t begin, std::uint64_t end) { return runCovers(lease, begin, end) || (joined && joinedCovers(lease, begin, end)); });\n',
    '    std::uint64_t foreign = 0;\n' +
    '    RetireShadow(device, it->second, [&lease, &entry = it->second, &foreign](std::uint64_t begin, std::uint64_t end) { return retirePublishes(entry, lease, begin, end, foreign); });\n' +
    '    if (foreign != 0) {\n' +
    '        static std::atomic<std::uint64_t> total{0};\n' +
    '        static std::atomic<int> reports{0};\n' +
    '        const auto all = total.fetch_add(foreign, std::memory_order_relaxed) + foreign;\n' +
    '        if (reports.fetch_add(1, std::memory_order_relaxed) < 32) std::fprintf(stderr, "[zero-writer] shadow retire of import 0x%llx+0x%llx dropped %llu units that a newer registration owns (%llu in all)\\n",\n' +
    '            static_cast<unsigned long long>(it->second.base), static_cast<unsigned long long>(it->second.bytes), static_cast<unsigned long long>(foreign), static_cast<unsigned long long>(all));\n' +
    '    }\n');
  replace('bool joinedCovers(const GuestAllocations::Lease& lease, std::uint64_t begin, std::uint64_t end) {\n    return !crossedRun(lease, begin, end).ranges.empty();\n}\n',
    'bool joinedCovers(const GuestAllocations::Lease& lease, std::uint64_t begin, std::uint64_t end) {\n    return !crossedRun(lease, begin, end).ranges.empty();\n}\n' + `
// Every registered range covering [begin, end) is one of the import's own registrations: the same allocation identity
// (allocationSerial, kept across protection changes and backing renewal) and the same backing generation (backingSerial),
// readable and contiguous over the whole span.
bool ownRegistrationCovers(const HostImport& entry, const GuestAllocations::Lease& lease, std::uint64_t begin, std::uint64_t end) {
    const auto own = [&entry](const GuestAllocations::Range& range) {
        const auto same = [&range](const std::shared_ptr<const GuestAllocations::Range>& mine) {
            return mine != nullptr && mine->allocationSerial != 0 && mine->allocationSerial == range.allocationSerial && mine->backingSerial == range.backingSerial;
        };
        return same(entry.range) || std::any_of(entry.ranges.begin(), entry.ranges.end(), same);
    };
    auto index = leasedIndexContaining(lease, begin);
    for (auto at = begin; at < end; ++index) {
        if (index >= lease.size()) return false;
        const auto& range = *lease[index];
        if (range.address > at || !range.readable || !own(range)) return false;
        at = range.address + range.bytes;
    }
    return true;
}

// RetireShadow's rule for one unit [begin, end) of a retiring import: published only where a readable registered range
// still covers it and that registration is the import's own. A unit that a newer registration took over belongs to that
// allocation's bytes and is dropped (counted in \`foreign\`).
bool retirePublishes(const HostImport& entry, const GuestAllocations::Lease& lease, std::uint64_t begin, std::uint64_t end, std::uint64_t& foreign) {
    if (!runCovers(lease, begin, end) && !(entry.joined && joinedCovers(lease, begin, end))) return false;
    if (ownRegistrationCovers(entry, lease, begin, end)) return true;
    ++foreign;
    return false;
}
`);
  fs.writeFileSync(file, source);
}
