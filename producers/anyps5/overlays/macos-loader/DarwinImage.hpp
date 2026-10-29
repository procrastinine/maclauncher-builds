// SPDX-License-Identifier: GPL-2.0-only
#ifndef ANYPS5_DARWIN_IMAGE_HPP
#define ANYPS5_DARWIN_IMAGE_HPP
#ifdef __APPLE__
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <mach-o/getsect.h>
#include <mach-o/loader.h>
#include <mach/vm_prot.h>
#include "prx/libc/include/specifics/macos/VirtualMemory.hpp"
#include "prx/libc/include/specifics/linux/ElfTypes.hpp"
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace DarwinImage {
using Header = mach_header_64;
struct Segment {
    std::uintptr_t address;
    std::uint64_t size;
    std::int32_t protection;
};
using DarwinVirtualMemory::Region;
using DarwinVirtualMemory::MemoryReadable;
inline std::vector<const segment_command_64*> Commands(const Header* header) {
    std::vector<const segment_command_64*> result;
    if (!header || !MemoryReadable(reinterpret_cast<std::uintptr_t>(header),sizeof(Header)) || header->magic != MH_MAGIC_64) return result;
    const auto* current = reinterpret_cast<const std::uint8_t*>(header + 1);
    std::uint64_t remaining = header->sizeofcmds;
    if (!MemoryReadable(reinterpret_cast<std::uintptr_t>(current),remaining)) throw std::runtime_error("module image has unreadable Mach-O commands");
    for (std::uint32_t index = 0; index < header->ncmds; ++index) {
        if (remaining < sizeof(load_command)) throw std::runtime_error("module image has truncated Mach-O commands");
        const auto* command = reinterpret_cast<const load_command*>(current);
        if (command->cmdsize < sizeof(load_command) || command->cmdsize > remaining)
            throw std::runtime_error("module image has invalid Mach-O command sizes");
        if (command->cmd == LC_SEGMENT_64) {
            if (command->cmdsize < sizeof(segment_command_64)) throw std::runtime_error("module image has a truncated Mach-O segment");
            const auto* segment = reinterpret_cast<const segment_command_64*>(current);
            if (segment->nsects > (command->cmdsize - sizeof(segment_command_64)) / sizeof(section_64)) throw std::runtime_error("module image has a truncated Mach-O section table");
            result.push_back(reinterpret_cast<const segment_command_64*>(current));
        }
        current += command->cmdsize;
        remaining -= command->cmdsize;
    }
    return result;
}
inline std::intptr_t Slide(const Header* header) {
    for (const auto* segment : Commands(header)) {
        if (segment->fileoff == 0 && segment->filesize >= sizeof(Header))
            return static_cast<std::intptr_t>(reinterpret_cast<std::uintptr_t>(header) - segment->vmaddr);
    }
    throw std::runtime_error("module image has no file-backed Mach-O header segment");
}
inline std::vector<Segment> Segments(const Header* header) {
    const auto slide = Slide(header);
    std::vector<Segment> result;
    for (const auto* segment : Commands(header)) {
        if (segment->vmsize == 0 || segment->initprot == 0) continue;
        result.push_back({static_cast<std::uintptr_t>(segment->vmaddr + slide), segment->vmsize, segment->initprot});
    }
    return result;
}
inline std::vector<Segment> ReadableSegments(const Header* header) {
    std::vector<Segment> result;
    for (const auto& segment : Segments(header)) {
        auto current = segment.address;
        if (segment.size > std::numeric_limits<std::uintptr_t>::max() - current) throw std::runtime_error("module image segment address overflows");
        const auto end = current + segment.size;
        while (current < end) {
            mach_vm_address_t region;
            mach_vm_size_t length;
            vm_region_submap_info_data_64_t info{};
            if (!Region(current,region,length,info)) break;
            const auto bytes = std::min<std::uint64_t>(end - current,length - (current - region));
            if (info.protection & VM_PROT_READ) {
                if (!result.empty() && result.back().address + result.back().size == current) result.back().size += bytes;
                else result.push_back({current,bytes,info.protection});
            }
            current += bytes;
        }
    }
    return result;
}
inline const std::uint8_t* Section(const Header* header,const char* segmentName,const char* sectionName,std::uint64_t& size) {
    size = 0;
    const auto slide = Slide(header);
    for (const auto* segment : Commands(header)) {
        if (std::strncmp(segment->segname,segmentName,sizeof(segment->segname)) != 0) continue;
        const auto* sections = reinterpret_cast<const section_64*>(segment + 1);
        for (std::uint32_t index = 0;index < segment->nsects;++index) {
            const auto& section = sections[index];
            if (std::strncmp(section.sectname,sectionName,sizeof(section.sectname)) != 0) continue;
            if (section.addr < segment->vmaddr || section.addr - segment->vmaddr > segment->vmsize || section.size > segment->vmsize - (section.addr - segment->vmaddr)) throw std::runtime_error("module image section escapes its segment");
            const auto address = static_cast<std::uintptr_t>(section.addr + slide);
            if (!MemoryReadable(address,section.size)) throw std::runtime_error("module image section is unreadable");
            size = section.size;
            return reinterpret_cast<const std::uint8_t*>(address);
        }
    }
    return nullptr;
}
inline const Header* Containing(const void* address) {
    Dl_info info{};
    if (!address || ::dladdr(address,&info) == 0 || !info.dli_fbase) return nullptr;
    const auto* header = static_cast<const Header*>(info.dli_fbase);
    if (header->magic != MH_MAGIC_64) return nullptr;
    const auto target = reinterpret_cast<std::uintptr_t>(address);
    for (const auto& segment : Segments(header))
        if (target >= segment.address && target - segment.address < segment.size) return header;
    return nullptr;
}
inline const Header* Main() {
    return reinterpret_cast<const Header*>(_dyld_get_image_header(0));
}
inline std::string Path(const Header* header) {
    const auto count = _dyld_image_count();
    for (std::uint32_t index = 0; index < count; ++index) {
        if (reinterpret_cast<const Header*>(_dyld_get_image_header(index)) != header) continue;
        const auto* name = _dyld_get_image_name(index);
        return name ? name : "";
    }
    throw std::runtime_error("module image is no longer loaded");
}
inline std::filesystem::path Canonical(const std::filesystem::path& path) {
    std::error_code error;
    auto result = std::filesystem::weakly_canonical(path,error);
    if (error) throw std::system_error(error,"resolve loaded module path");
    return result;
}
inline const Header* FindPath(const std::filesystem::path& path) {
    const auto requested = Canonical(path);
    const auto count = _dyld_image_count();
    for (std::uint32_t index = 0; index < count; ++index) {
        const auto* name = _dyld_get_image_name(index);
        if (name && Canonical(name) == requested)
            return reinterpret_cast<const Header*>(_dyld_get_image_header(index));
    }
    throw std::runtime_error("dlopen: cannot identify the loaded Mach-O image: " + path.string());
}
inline const std::uint8_t* Metadata(const Header* header) {
    std::uint64_t size = 0;
    const auto* meta = Section(header,"__APS5DATA","__meta",size);
    if (!meta || size < 0x60) return nullptr;
    std::uint64_t version;
    std::memcpy(&version,meta,sizeof(version));
    return version == 2 ? meta : nullptr;
}
inline bool ProgramHeaders(const Header* header,dl_phdr_info& image) {
    std::uint64_t size = 0;
    const auto* meta = Section(header,"__APS5DATA","__meta",size);
    if (!meta || size < 0x60) return false;
    std::uint64_t version,count,bias;
    std::memcpy(&version,meta,8);
    if (version != 2) throw std::runtime_error("module image has unsupported guest metadata");
    std::memcpy(&bias,meta + 8,8);
    std::memcpy(&count,meta + 0x58,8);
    if (count > 0xffff || count > (size - 0x60) / sizeof(Elf64_Phdr)) throw std::runtime_error("module image has truncated guest program headers");
    image = {};
    image.dlpi_addr = bias;
    image.dlpi_phdr = reinterpret_cast<const Elf64_Phdr*>(meta + 0x60);
    image.dlpi_phnum = static_cast<std::uint16_t>(count);
    return true;
}
inline bool Lifecycle(const Header* header,std::uint64_t& init,std::uint64_t& fini) {
    std::uint64_t size = 0;
    const auto* bytes = Section(header,"__APS5DATA","__init_fini",size);
    if (!bytes) return false;
    std::uint64_t version = 0;
    if (size >= 8) std::memcpy(&version,bytes,8);
    if (size != 24 || version != 1) throw std::runtime_error("module image has invalid initializer metadata");
    std::memcpy(&init,bytes + 8,8);
    std::memcpy(&fini,bytes + 16,8);
    const auto segments = Segments(header);
    for (const auto address : {init,fini}) {
        if (address == 0) continue;
        if (!std::any_of(segments.begin(),segments.end(),[&](const auto& segment) {
            return (segment.protection & VM_PROT_EXECUTE) && address >= segment.address && address - segment.address < segment.size;
        })) throw std::runtime_error("module image initializer is outside executable segments");
    }
    return true;
}
inline std::uintptr_t LoadBias(const Header* header) {
    if (const auto* meta = Metadata(header)) {
        std::uint64_t address;
        std::memcpy(&address,meta + 0x08,sizeof(address));
        return address;
    }
    return reinterpret_cast<std::uintptr_t>(header);
}
inline std::uint32_t TlsIndex(const Header* header) {
    const auto* meta = Metadata(header);
    if (!meta) return 0;
    std::uint64_t descriptorVersion;
    std::memcpy(&descriptorVersion,meta + 0x20,sizeof(descriptorVersion));
    if (descriptorVersion != 1) return 0;
    const auto key = std::atomic_ref(*reinterpret_cast<std::uint64_t*>(const_cast<std::uint8_t*>(meta + 0x48))).load(std::memory_order_acquire);
    if (key > std::numeric_limits<std::uint32_t>::max()) throw std::runtime_error("module TLS index exceeds 32 bits");
    return static_cast<std::uint32_t>(key);
}
inline bool System(const Header* header) {
    return header != Main() && !std::string_view(Path(header)).ends_with(".guest.prx");
}
inline bool Guest(const Header* header) {
    return header == Main() || std::string_view(Path(header)).ends_with(".prx");
}
inline std::vector<const Header*> GuestImages() {
    std::vector<const Header*> result;
    const auto count = _dyld_image_count();
    for (std::uint32_t index = 0; index < count; ++index) {
        const auto* header = reinterpret_cast<const Header*>(_dyld_get_image_header(index));
        if (header && header->magic == MH_MAGIC_64 && Guest(header)) result.push_back(header);
    }
    return result;
}
}
#endif
#endif
