// SPDX-License-Identifier: GPL-2.0-only
#ifndef ANYPS5_DARWIN_HOST_MAPPING_HPP
#define ANYPS5_DARWIN_HOST_MAPPING_HPP
#include "VirtualMemory.hpp"
#include <dlfcn.h>
#include <libproc.h>
#include <unistd.h>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace HostMapping {
struct Mapping {
    std::uint64_t start;
    std::uint64_t end;
    std::string path;
    bool readable = false;
    bool writable = false;
    bool executable = false;
    bool shared = false;
    std::uint64_t inode = 0;
};
inline Mapping FromRegion(std::uint64_t address,mach_vm_address_t begin,mach_vm_size_t size,const vm_region_submap_info_data_64_t& region,const char* caller) {
    if (size > std::numeric_limits<std::uint64_t>::max() - begin) throw std::runtime_error(std::string(caller) + ": mapped region address overflows");
    std::string path;
    Dl_info image{};
    if (::dladdr(reinterpret_cast<const void*>(address),&image) && image.dli_fname) path = image.dli_fname;
    else path = DarwinVirtualMemory::BackingPath(address);
    proc_regionwithpathinfo backing{};
    const int result = ::proc_pidinfo(::getpid(),PROC_PIDREGIONPATHINFO,address,&backing,sizeof(backing));
    const bool contains = result == sizeof(backing) && address >= backing.prp_prinfo.pri_address && address - backing.prp_prinfo.pri_address < backing.prp_prinfo.pri_size;
    const auto inode = contains ? backing.prp_vip.vip_vi.vi_stat.vst_ino : 0;
    const bool shared = region.share_mode == SM_SHARED || region.share_mode == SM_TRUESHARED || region.share_mode == SM_SHARED_ALIASED;
    return Mapping{begin,begin + size,std::move(path),bool(region.protection & VM_PROT_READ),bool(region.protection & VM_PROT_WRITE),bool(region.protection & VM_PROT_EXECUTE),shared,inode};
}
inline std::optional<Mapping> Find(std::uint64_t address,const char* caller) {
    mach_vm_address_t begin;
    mach_vm_size_t size;
    vm_region_submap_info_data_64_t region{};
    if (!DarwinVirtualMemory::Region(address,begin,size,region)) return std::nullopt;
    return FromRegion(address,begin,size,region,caller);
}
inline int QueryFd() {return -1;}
inline std::optional<Mapping> ScanMaps(std::uint64_t address,const char* caller) {return Find(address,caller);}
template <typename Visit>
void Walk(std::uint64_t begin,std::uint64_t end,const char* caller,Visit&& visit) {
    for (auto cursor = begin; cursor < end;) {
        mach_vm_address_t regionBegin;
        mach_vm_size_t size;
        vm_region_submap_info_data_64_t region{};
        if (!DarwinVirtualMemory::RegionAtOrAfter(cursor,regionBegin,size,region) || regionBegin >= end) return;
        const auto mapping = FromRegion(std::max<std::uint64_t>(cursor,regionBegin),regionBegin,size,region,caller);
        if (mapping.end <= cursor) throw std::runtime_error(std::string(caller) + ": mapped region query went backwards");
        visit(mapping);
        cursor = mapping.end;
    }
}
}
#endif
