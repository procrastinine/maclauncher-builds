// SPDX-License-Identifier: GPL-2.0-only
#ifndef ANYPS5_DARWIN_VIRTUAL_MEMORY_HPP
#define ANYPS5_DARWIN_VIRTUAL_MEMORY_HPP
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <cstdint>
#include <algorithm>
#include <limits>
#include <libproc.h>
#include <sys/proc_info.h>
#include <unistd.h>
#include <cstring>
#include <string>

namespace DarwinVirtualMemory {
inline std::string BackingPath(std::uintptr_t address) {
    proc_regionwithpathinfo region{};
    const int size = ::proc_pidinfo(::getpid(),PROC_PIDREGIONPATHINFO,address,&region,sizeof(region));
    if (size != sizeof(region) || address < region.prp_prinfo.pri_address || address - region.prp_prinfo.pri_address >= region.prp_prinfo.pri_size) return {};
    const auto* path = region.prp_vip.vip_path;
    return std::string(path,strnlen(path,sizeof(region.prp_vip.vip_path)));
}
inline bool RegionAtOrAfter(std::uintptr_t address,mach_vm_address_t& begin,mach_vm_size_t& size,vm_region_submap_info_data_64_t& info) {
    mach_vm_address_t cursor = address;
    natural_t depth = 0;
    for (;;) {
        begin = cursor;
        auto count = static_cast<mach_msg_type_number_t>(VM_REGION_SUBMAP_INFO_COUNT_64);
        const auto status = mach_vm_region_recurse(mach_task_self(),&begin,&size,&depth,reinterpret_cast<vm_region_recurse_info_t>(&info),&count);
        if (status != KERN_SUCCESS || size == 0) return false;
        if (!info.is_submap) return true;
        if (begin > cursor) cursor = begin;
        ++depth;
    }
}
inline bool Region(std::uintptr_t address,mach_vm_address_t& begin,mach_vm_size_t& size,vm_region_submap_info_data_64_t& info) {
    return RegionAtOrAfter(address,begin,size,info) && begin <= address && address - begin < size;
}
inline bool MemoryReadable(std::uintptr_t begin,std::uint64_t size) {
    if (size > std::numeric_limits<std::uintptr_t>::max() - begin) return false;
    const auto end = begin + size;
    while (begin < end) {
        mach_vm_address_t region;
        mach_vm_size_t length;
        vm_region_submap_info_data_64_t info{};
        if (!Region(begin,region,length,info) || !(info.protection & VM_PROT_READ)) return false;
        begin += std::min<std::uint64_t>(end - begin,length - (begin - region));
    }
    return true;
}

}
#endif
