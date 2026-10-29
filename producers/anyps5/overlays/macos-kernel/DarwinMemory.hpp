#ifndef ANYPS5_DARWIN_MEMORY_HPP
#define ANYPS5_DARWIN_MEMORY_HPP

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <fcntl.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <stdexcept>
#include <sys/mman.h>
#include <system_error>
#include <unistd.h>
#include <utility>
#include <vector>

namespace DarwinMemory {

inline std::vector<std::pair<std::uintptr_t, std::uintptr_t>> Mappings(std::uintptr_t start, std::uintptr_t end) {
    std::vector<std::pair<std::uintptr_t, std::uintptr_t>> mappings;
    mach_vm_address_t address = start;
    while (address < end) {
        mach_vm_size_t bytes = 0;
        vm_region_basic_info_data_64_t info{};
        mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t object = MACH_PORT_NULL;
        const auto result = ::mach_vm_region(::mach_task_self(), &address, &bytes, VM_REGION_BASIC_INFO_64,
            reinterpret_cast<vm_region_info_t>(&info), &count, &object);
        if (object != MACH_PORT_NULL) ::mach_port_deallocate(::mach_task_self(), object);
        if (result == KERN_INVALID_ADDRESS) break;
        if (result != KERN_SUCCESS || bytes == 0 || address + bytes < address)
            throw std::runtime_error("Cannot enumerate guest virtual memory");
        mappings.emplace_back(address, address + bytes);
        address += bytes;
    }
    return mappings;
}

inline void* MapNoReplace(void* wanted, std::size_t bytes, int protection) {
    mach_vm_address_t address = reinterpret_cast<mach_vm_address_t>(wanted);
    const auto result = ::mach_vm_map(::mach_task_self(), &address, bytes, 0, VM_FLAGS_FIXED,
        MEMORY_OBJECT_NULL, 0, FALSE, protection, VM_PROT_ALL, VM_INHERIT_DEFAULT);
    if (result == KERN_SUCCESS) return reinterpret_cast<void*>(address);
    errno = result == KERN_NO_SPACE ? EEXIST : result == KERN_PROTECTION_FAILURE ? EACCES : ENOMEM;
    return MAP_FAILED;
}

inline void* MapAtOrAbove(std::uintptr_t start, std::size_t bytes, int protection, std::size_t alignment) {
    constexpr std::uintptr_t limit = 0x7fff00000000ull;
    if (start >= limit || bytes > limit - start || start > limit - (alignment - 1))
        throw std::invalid_argument("Mapping address hint exceeds the guest address range");
    for (int attempt = 0; attempt < 8; ++attempt) {
        auto candidate = (start + alignment - 1) & ~(static_cast<std::uintptr_t>(alignment) - 1);
        for (const auto& [begin, end] : Mappings(start, limit)) {
            if (end <= candidate) continue;
            if (bytes <= limit - candidate && begin >= candidate + bytes) break;
            if (end > limit - (alignment - 1)) { candidate = limit; break; }
            candidate = (end + alignment - 1) & ~(static_cast<std::uintptr_t>(alignment) - 1);
        }
        if (candidate >= limit || bytes > limit - candidate)
            throw std::runtime_error("No free range above the mapping address hint");
        void* result = MapNoReplace(reinterpret_cast<void*>(candidate), bytes, protection);
        if (result != MAP_FAILED) return result;
        if (errno != EEXIST) throw std::system_error(errno, std::generic_category(), "Hinted memory mapping failed");
    }
    throw std::runtime_error("Hinted memory mapping conflicts with another mapping");
}

inline void MapUnmappedPages(void* pointer, std::size_t bytes) {
    auto cursor = reinterpret_cast<std::uintptr_t>(pointer);
    const auto end = cursor + bytes;
    unsigned conflicts = 0;
    while (cursor < end) {
        const auto regions = Mappings(cursor, end);
        if (!regions.empty() && regions.front().first <= cursor) {
            cursor = std::min(end, regions.front().second);
            continue;
        }
        const auto next = regions.empty() ? end : std::min(end, regions.front().first);
        if (MapNoReplace(reinterpret_cast<void*>(cursor), next - cursor, PROT_READ | PROT_WRITE) == MAP_FAILED) {
            if (errno == EEXIST && ++conflicts < 64) continue;
            throw std::system_error(errno, std::generic_category(), "Mapping guest thread stack pages");
        }
        conflicts = 0;
        cursor = next;
    }
}

inline int PhysicalFile(std::size_t bytes) {
    char path[] = "/tmp/anyps5-direct-XXXXXX";
    const int file = ::mkstemp(path);
    if (file < 0) throw std::system_error(errno, std::generic_category(), "Creating direct memory backing");
    if (::unlink(path) != 0 || ::fcntl(file, F_SETFD, FD_CLOEXEC) != 0 || ::ftruncate(file, static_cast<off_t>(bytes)) != 0) {
        const int error = errno;
        ::close(file);
        ::unlink(path);
        throw std::system_error(error, std::generic_category(), "Sizing direct memory backing");
    }
    return file;
}

}

#endif
