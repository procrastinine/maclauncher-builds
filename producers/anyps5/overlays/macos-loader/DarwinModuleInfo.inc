// SPDX-License-Identifier: GPL-2.0-only
// Darwin image identity uses dyld. Converted images retain their original ELF
// program headers through the upstream GuestImages dl_iterate_phdr interface.
#include "prx/libkernel/include/Api.hpp"
#include "prx/libc/include/specifics/linux/ElfTypes.hpp"
#include "prx/libkernel/Module/DarwinImage.hpp"
#include "prx/libkernel/Module/EhFrame.hpp"
#include "prx/libkernel/DirectMemory/DirectMemory.hpp"
#include "prx/libkernel/KernelErrors.hpp"
#include "SceTypes.hpp"
#include <algorithm>
#include <cstring>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <type_traits>

extern "C" std::int32_t ModuleIdForImage_nid_no_patch(const void* native);
namespace {
constexpr std::uint32_t Load = 1, Dynamic = 2, Tls = 7, EhFrameHeader = 0x6474e550;
constexpr std::int64_t DynamicNull = 0, DynamicInit = 12, DynamicFini = 13;
struct DynamicEntry {
    std::int64_t tag;
    std::uint64_t value;
};
std::uint32_t ToU32(std::uint64_t value,const char* field) {
    if (value > std::numeric_limits<std::uint32_t>::max()) throw std::runtime_error(std::string("module info: ") + field + " exceeds 32 bits");
    return static_cast<std::uint32_t>(value);
}
template<class Info> void Name(Info& info,const DarwinImage::Header* header) {
    auto name = std::filesystem::path(DarwinImage::Path(header)).filename().string();
    constexpr std::string_view suffix = ".guest.prx";
    if (name.size() > suffix.size() && name.ends_with(suffix)) name.resize(name.size() - suffix.size());
    if (name.size() >= sizeof(info.name)) throw std::runtime_error("module info: module name too long: " + name);
    std::memcpy(info.name,name.c_str(),name.size() + 1);
}
bool Contains(const dl_phdr_info& image,std::uintptr_t begin,std::uint64_t size) {
    for (std::uint16_t index = 0; index < image.dlpi_phnum; ++index) {
        const auto& header = image.dlpi_phdr[index];
        if (header.p_type != Load || header.p_vaddr > std::numeric_limits<std::uintptr_t>::max() - image.dlpi_addr) continue;
        const auto start = image.dlpi_addr + header.p_vaddr;
        if (begin >= start && begin - start <= header.p_memsz && size <= header.p_memsz - (begin - start)) return true;
    }
    return false;
}
template<class Info> void FillGuest(const dl_phdr_info& image,const DarwinImage::Header* native,Info& result) {
    Name(result,native);
    constexpr bool extended = std::is_same_v<Info,ModuleInfoEx>;
    if constexpr (extended) result.tls_index = DarwinImage::TlsIndex(native);
    const auto readable = DarwinImage::ReadableSegments(native);
    const auto contains = [&](std::uintptr_t address,std::uint64_t size) {
        if (!Contains(image,address,size)) return false;
        return std::any_of(readable.begin(),readable.end(),[&](const auto& range) {
            return address >= range.address && address - range.address <= range.size && size <= range.size - (address - range.address);
        });
    };
    bool hasLifecycle = false;
    if constexpr (extended) hasLifecycle = DarwinImage::Lifecycle(native,result.init_proc_addr,result.fini_proc_addr);
    for (std::uint16_t index = 0; index < image.dlpi_phnum; ++index) {
        const auto& header = image.dlpi_phdr[index];
        if (header.p_vaddr > std::numeric_limits<std::uintptr_t>::max() - image.dlpi_addr) throw std::runtime_error("module info: program address overflows");
        const auto address = image.dlpi_addr + header.p_vaddr;
        if (header.p_type == Load && result.segment_count < std::size(result.segments)) {
            auto& segment = result.segments[result.segment_count++];
            segment.address = address;
            segment.size = ToU32(header.p_memsz,"segment size");
            segment.prot = ((header.p_flags & 4) ? 1 : 0) | ((header.p_flags & 2) ? 2 : 0) | ((header.p_flags & 1) ? 4 : 0);
        } else if constexpr (extended) {
            if (header.p_type == Tls) {
                result.tls_init_addr = address;
                result.tls_init_size = ToU32(header.p_filesz,"TLS image size");
                result.tls_size = ToU32(header.p_memsz,"TLS size");
                result.tls_align = ToU32(header.p_align,"TLS alignment");
            } else if (header.p_type == EhFrameHeader) {
                const auto tables = EhFrame::ReadTables(contains,address,"sceKernelGetModuleInfoFromAddr");
                result.eh_frame_hdr_addr = address;
                result.eh_frame_hdr_size = ToU32(header.p_memsz,"eh_frame_hdr size");
                result.eh_frame_addr = tables.frames;
                result.eh_frame_size = ToU32(tables.framesSize + 4,"eh_frame size");
            } else if (header.p_type == Dynamic) {
                if (hasLifecycle) continue;
                if (header.p_filesz > header.p_memsz || header.p_filesz % sizeof(DynamicEntry) != 0 || !contains(address,header.p_filesz)) throw std::runtime_error("module info: dynamic table is unreadable or truncated");
                bool terminated = false;
                for (std::uint64_t offset = 0;offset < header.p_filesz;offset += sizeof(DynamicEntry)) {
                    const auto current = address + offset;
                    const auto* entry = reinterpret_cast<const DynamicEntry*>(current);
                    if (entry->tag == DynamicNull) {terminated = true;break;}
                    if (entry->tag == DynamicInit || entry->tag == DynamicFini) {
                        if (entry->value > std::numeric_limits<std::uintptr_t>::max() - image.dlpi_addr) throw std::runtime_error("module info: initializer address overflows");
                        if (entry->tag == DynamicInit) result.init_proc_addr = image.dlpi_addr + entry->value;
                        else result.fini_proc_addr = image.dlpi_addr + entry->value;
                    }
                }
                if (!terminated) throw std::runtime_error("module info: dynamic table has no terminator");
            }
        }
    }
    if constexpr (extended) {result.id = ModuleIdForImage_nid_no_patch(native);result.ref_count = 1;}
}
template<class Info> bool Fill(const DarwinImage::Header* native,Info& result) {
    result.st_size = sizeof(Info);
    dl_phdr_info image{};
    if (DarwinImage::ProgramHeaders(native,image)) {
        FillGuest(image,native,result);
        return result.segment_count != 0;
    }
    Name(result,native);
    for (const auto& source : DarwinImage::Segments(native)) {
        if (result.segment_count >= std::size(result.segments)) break;
        auto& segment = result.segments[result.segment_count++];
        segment.address = source.address;segment.size = ToU32(source.size,"segment size");
        segment.prot = ((source.protection & VM_PROT_READ) ? 1 : 0) | ((source.protection & VM_PROT_WRITE) ? 2 : 0) | ((source.protection & VM_PROT_EXECUTE) ? 4 : 0);
    }
    if constexpr (std::is_same_v<Info,ModuleInfoEx>) {
        std::uint64_t size = 0;
        const auto* frames = DarwinImage::Section(native,"__TEXT","__eh_frame",size);
        if (frames) {result.eh_frame_addr = reinterpret_cast<std::uintptr_t>(frames);result.eh_frame_size = ToU32(size,"eh_frame size");}
        result.id = ModuleIdForImage_nid_no_patch(native);result.ref_count = 1;
    }
    return result.segment_count != 0;
}
template<class Info> int FillModuleInfo(KernelModule handle,Info* output,bool titleOnly) {
    if (!output) return SCE_KERNEL_ERROR_EFAULT;
    if (output->st_size != sizeof(Info)) return SCE_KERNEL_ERROR_EINVAL;
    for (const auto* image : DarwinImage::GuestImages()) {
        if (ModuleIdForImage_nid_no_patch(image) != handle) continue;
        if (titleOnly && DarwinImage::System(image)) return SCE_KERNEL_ERROR_EPERM;
        Info result{};result.st_size = sizeof(Info);
        if (!Fill(image,result)) return SCE_KERNEL_ERROR_ESRCH;
        *output = result;return 0;
    }
    return SCE_KERNEL_ERROR_ESRCH;
}
int FillModuleList(KernelModule* handles,std::size_t count,std::size_t* actual,bool titleOnly) {
    if (!handles) return SCE_KERNEL_ERROR_EFAULT;
    auto images = DarwinImage::GuestImages();
    if (titleOnly) std::erase_if(images,DarwinImage::System);
    for (std::size_t index = 0;index < images.size() && index < count;++index) handles[index] = ModuleIdForImage_nid_no_patch(images[index]);
    if (images.size() > count) return SCE_KERNEL_ERROR_ENOMEM;
    if (!actual) return SCE_KERNEL_ERROR_EFAULT;
    *actual = images.size();return 0;
}
std::uint64_t GuestSegmentBytes() {
    std::uint64_t bytes = 0;
    for (const auto* native : DarwinImage::GuestImages()) {
        if (DarwinImage::System(native)) continue;
        dl_phdr_info image{};
        if (!DarwinImage::ProgramHeaders(native,image)) continue;
        for (std::uint16_t index = 0;index < image.dlpi_phnum;++index) {
            const auto& header = image.dlpi_phdr[index];
            if (header.p_type != Load || header.p_offset == 0 || (header.p_flags & 7) == 7) continue;
            constexpr std::uint64_t mask = PS5_PAGE_SIZE - 1;
            if (header.p_memsz > std::numeric_limits<std::uint64_t>::max() - header.p_vaddr || header.p_vaddr + header.p_memsz > std::numeric_limits<std::uint64_t>::max() - mask) throw std::runtime_error("module info: segment span overflows");
            bytes += ((header.p_vaddr + header.p_memsz + mask) & ~mask) - (header.p_vaddr & ~mask);
        }
    }
    return bytes;
}
}
extern "C" {
int APS5_VABI sceKernelGetModuleInfoFromAddr(std::uint64_t address,int flags,ModuleInfoEx* info) {
    if (flags != 1 && flags != 2) {
        if (!info) throw std::invalid_argument("sceKernelGetModuleInfoFromAddr: null info with flags " + std::to_string(flags));
        *info = {};return SCE_KERNEL_ERROR_EINVAL;
    }
    if (!info) return SCE_KERNEL_ERROR_EFAULT;
    const auto* image = DarwinImage::Containing(reinterpret_cast<const void*>(address));
    ModuleInfoEx result{};
    if (!image || (flags == 2 && DarwinImage::System(image)) || !Fill(image,result)) {*info = {};return SCE_KERNEL_ERROR_ESRCH;}
    *info = result;return 0;
}
int APS5_VABI sceKernelGetModuleList(KernelModule* handles,std::size_t count,std::size_t* actual) {return FillModuleList(handles,count,actual,false);}
int APS5_VABI sceKernelGetModuleList2(KernelModule* handles,std::size_t count,std::size_t* actual) {return FillModuleList(handles,count,actual,true);}
int APS5_VABI sceKernelGetModuleInfo(KernelModule handle,ModuleInfo* info) {return FillModuleInfo(handle,info,false);}
int APS5_VABI sceKernelGetModuleInfo2(KernelModule handle,ModuleInfo* info) {return FillModuleInfo(handle,info,true);}
int GetModuleInfoExByHandle_nid_no_patch(KernelModule handle,ModuleInfoEx* info) {return FillModuleInfo(handle,info,false);}
std::int32_t APS5_VABI sceKernelGetLibkernelTextLocation_nid_postfix(void** address,std::size_t* size) {
    if (!address || !size) throw std::invalid_argument("sceKernelGetLibkernelTextLocation: null argument");
    ModuleInfo info{};
    if (!Fill(DarwinImage::Main(),info) || info.segment_count == 0) throw std::runtime_error("sceKernelGetLibkernelTextLocation: the main program has no segments");
    *address = reinterpret_cast<void*>(static_cast<std::uintptr_t>(info.segments[0].address));*size = info.segments[0].size;return 0;
}
std::int32_t APS5_VABI sceKernelInternalMemoryGetModuleSegmentInfo_nid_postfix(InternalSegmentInfo* result) {
    if (!result) throw std::invalid_argument("sceKernelInternalMemoryGetModuleSegmentInfo: result is null");
    void* address = nullptr;std::size_t size = 0;
    const auto status = sceKernelGetLibkernelTextLocation_nid_postfix(&address,&size);
    if (status != 0) return status;
    *result = {reinterpret_cast<std::uintptr_t>(address),size};return 0;
}
std::uint64_t GuestImageSegmentBytes_nid_no_patch() {return GuestSegmentBytes();}
}
