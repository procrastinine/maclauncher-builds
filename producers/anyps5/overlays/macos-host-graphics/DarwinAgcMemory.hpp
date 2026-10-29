// SPDX-License-Identifier: GPL-2.0-only
#ifndef ANYPS5_DARWIN_AGC_MEMORY_HPP
#define ANYPS5_DARWIN_AGC_MEMORY_HPP
#include "prx/libc/include/specifics/macos/VirtualMemory.hpp"
#include <mach/task_info.h>
#include <mach/vm_statistics.h>
#include <unistd.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace DarwinAgcMemory {
struct Mapping {
    std::uint64_t begin = 0;
    std::uint64_t end = 0;
    bool readable = false;
    bool privateAnonymous = false;
};
inline std::string BackingPath(std::uint64_t address) {
    return DarwinVirtualMemory::BackingPath(address);
}
template<class Visit>
void Regions(std::uint64_t begin, std::uint64_t end, Visit&& visit) {
    for (auto cursor = begin; cursor < end;) {
        mach_vm_address_t first = 0;
        mach_vm_size_t size = 0;
        vm_region_submap_info_data_64_t info{};
        if (!DarwinVirtualMemory::RegionAtOrAfter(cursor, first, size, info) || first >= end) break;
        if (size == 0 || size > std::numeric_limits<std::uint64_t>::max() - first || first + size <= cursor)
            throw std::runtime_error("Invalid macOS GPU memory region");
        const auto next = std::min<std::uint64_t>(end, first + size);
        const auto from = std::max<std::uint64_t>(cursor, first);
        visit(from, next, info);
        cursor = next;
    }
}
inline std::vector<Mapping> Mappings(std::uint64_t begin, std::uint64_t end) {
    std::vector<Mapping> result;
    Regions(begin, end, [&](auto first, auto last, const auto& info) {
        const bool privateMapping = info.share_mode == SM_PRIVATE || info.share_mode == SM_COW || info.share_mode == SM_PRIVATE_ALIASED;
        result.push_back({first, last, (info.protection & VM_PROT_READ) != 0,
            privateMapping && !info.external_pager && BackingPath(first).empty()});
    });
    return result;
}
inline bool HasPageContents(int disposition) {
    return (disposition & (VM_PAGE_QUERY_PAGE_PRESENT | VM_PAGE_QUERY_PAGE_PAGED_OUT)) != 0;
}
template<class Visit>
void PopulatedPages(const Mapping& mapping, Visit&& visit) {
    const long nativePage = sysconf(_SC_PAGESIZE);
    if (nativePage <= 0) throw std::runtime_error("Reading macOS GPU memory page size failed");
    const auto page = static_cast<std::uint64_t>(nativePage);
    auto cursor = mapping.begin - mapping.begin % page;
    std::array<int, 4096> dispositions{};
    while (cursor < mapping.end) {
        const auto remaining = mapping.end - cursor;
        const auto pages = std::min<std::uint64_t>(dispositions.size(), remaining / page + (remaining % page != 0));
        if (pages > (std::numeric_limits<std::uint64_t>::max() - cursor) / page)
            throw std::runtime_error("macOS GPU page range overflow");
        mach_vm_size_t count = pages;
        const auto status = mach_vm_page_range_query(mach_task_self(), cursor, pages * page,
            reinterpret_cast<mach_vm_address_t>(dispositions.data()), &count);
        if (status != KERN_SUCCESS || count != pages) throw std::runtime_error("Reading macOS GPU page state failed");
        for (std::uint64_t index = 0; index < pages; ++index) {
            if (!HasPageContents(dispositions[index])) continue;
            const auto first = cursor + index * page;
            visit(std::max(first, mapping.begin), std::min(first + page, mapping.end));
        }
        cursor += pages * page;
    }
}
inline std::optional<std::uint64_t> PrivateBytes() {
    task_vm_info_data_t info{};
    auto count = static_cast<mach_msg_type_number_t>(TASK_VM_INFO_COUNT);
    if (task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS || count < TASK_VM_INFO_REV1_COUNT)
        return std::nullopt;
    return info.phys_footprint;
}
inline void TraceMappings(std::uint64_t begin, std::uint64_t bytes) {
    if (bytes > std::numeric_limits<std::uint64_t>::max() - begin) throw std::runtime_error("macOS GPU trace range overflow");
    Regions(begin, begin + bytes, [](auto first, auto last, const auto& info) {
        const auto path = BackingPath(first);
        std::fprintf(stderr, "[gpu]   0x%llx+0x%llx protect 0x%x share %u %s\n",
            static_cast<unsigned long long>(first), static_cast<unsigned long long>(last - first),
            info.protection, static_cast<unsigned>(info.share_mode), path.c_str());
    });
}
}
#endif
