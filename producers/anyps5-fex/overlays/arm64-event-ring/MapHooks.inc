#if defined(__APPLE__)
extern "C" void MclEventRingNote(const char*, std::uint64_t, std::uint64_t, const char*, std::uint64_t);

namespace {
[[maybe_unused]] void* MclRingMmap(const char* source, int line, void* address, std::size_t length, int prot, int flags, int fd, off_t offset) {
    auto* result = ::mmap(address, length, prot, flags, fd, offset);
    if (result != MAP_FAILED) MclEventRingNote("map", reinterpret_cast<std::uintptr_t>(result), length, source, line);
    return result;
}

[[maybe_unused]] int MclRingMunmap(const char* source, int line, void* address, std::size_t length) {
    const int result = ::munmap(address, length);
    if (result == 0) MclEventRingNote("unmap", reinterpret_cast<std::uintptr_t>(address), length, source, line);
    return result;
}

[[maybe_unused]] int MclRingMprotect(const char* source, int line, void* address, std::size_t length, int prot) {
    const int result = ::mprotect(address, length, prot);
    if (result == 0) MclEventRingNote("protect", reinterpret_cast<std::uintptr_t>(address), length, source, line);
    return result;
}

[[maybe_unused]] kern_return_t MclRingMachMap(const char* source, int line, vm_map_t task, mach_vm_address_t* address, mach_vm_size_t length,
    mach_vm_offset_t mask, int flags, mem_entry_name_port_t memory, memory_object_offset_t offset, boolean_t copy,
    vm_prot_t current, vm_prot_t maximum, vm_inherit_t inheritance) {
    const auto result = ::mach_vm_map(task, address, length, mask, flags, memory, offset, copy, current, maximum, inheritance);
    if (result == KERN_SUCCESS && task == mach_task_self()) MclEventRingNote("map", *address, length, source, line);
    return result;
}

[[maybe_unused]] kern_return_t MclRingMachDeallocate(const char* source, int line, vm_map_t task, mach_vm_address_t address, mach_vm_size_t length) {
    const auto result = ::mach_vm_deallocate(task, address, length);
    if (result == KERN_SUCCESS && task == mach_task_self()) MclEventRingNote("unmap", address, length, source, line);
    return result;
}

[[maybe_unused]] kern_return_t MclRingMachProtect(const char* source, int line, vm_map_t task, mach_vm_address_t address,
    mach_vm_size_t length, boolean_t maximum, vm_prot_t prot) {
    const auto result = ::mach_vm_protect(task, address, length, maximum, prot);
    if (result == KERN_SUCCESS && task == mach_task_self()) MclEventRingNote("protect", address, length, source, line);
    return result;
}

[[maybe_unused]] kern_return_t MclRingMachRemap(const char* source, int line, vm_map_t task, mach_vm_address_t* address, mach_vm_size_t length,
    mach_vm_offset_t mask, int flags, vm_map_t fromTask, mach_vm_address_t from, boolean_t copy, vm_prot_t* current,
    vm_prot_t* maximum, vm_inherit_t inheritance) {
    const auto result = ::mach_vm_remap(task, address, length, mask, flags, fromTask, from, copy, current, maximum, inheritance);
    if (result == KERN_SUCCESS && task == mach_task_self()) MclEventRingNote("map", *address, length, source, line);
    return result;
}
}

#define mmap(...) MclRingMmap(MCL_RING_FILE ".mmap", __LINE__, __VA_ARGS__)
#define munmap(...) MclRingMunmap(MCL_RING_FILE ".munmap", __LINE__, __VA_ARGS__)
#define mprotect(...) MclRingMprotect(MCL_RING_FILE ".mprotect", __LINE__, __VA_ARGS__)
#define mach_vm_map(...) MclRingMachMap(MCL_RING_FILE ".mach_vm_map", __LINE__, __VA_ARGS__)
#define mach_vm_deallocate(...) MclRingMachDeallocate(MCL_RING_FILE ".mach_vm_deallocate", __LINE__, __VA_ARGS__)
#define mach_vm_protect(...) MclRingMachProtect(MCL_RING_FILE ".mach_vm_protect", __LINE__, __VA_ARGS__)
#define mach_vm_remap(...) MclRingMachRemap(MCL_RING_FILE ".mach_vm_remap", __LINE__, __VA_ARGS__)
#endif
