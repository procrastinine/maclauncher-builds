// SPDX-License-Identifier: GPL-2.0-only
// The FEX route's guest image registry for AnyPS5's libraries. On the Rosetta route the relinker records each guest
// image's load bias and ELF program headers in a Mach-O __APS5DATA,__meta section, and libc's
// specifics/macos/GuestImages.cpp walks those sections in dl_iterate_phdr. Here anyps5-fex-start loads the guest
// images itself and registers them, so the same callers (process parameters, the unwinder) see the same images.

#include "GuestImages.h"

#include "prx/libc/include/specifics/linux/ElfTypes.hpp"

#include <cstdint>
#include <dlfcn.h>
#include <mutex>
#include <vector>

namespace {

std::mutex RegistryMutex;
std::vector<FexGuest::GuestImage>& Registry() {
  static auto* Images = new std::vector<FexGuest::GuestImage>;
  return *Images;
}

} // namespace

void FexGuest::RegisterGuestImage(const GuestImage& Image) {
  std::lock_guard Lock(RegistryMutex);
  Registry().push_back(Image);
}

extern "C" int dl_iterate_phdr(int (*callback)(dl_phdr_info*, std::size_t, void*), void* data) {
  std::vector<FexGuest::GuestImage> Images;
  {
    std::lock_guard Lock(RegistryMutex);
    Images = Registry();
  }
  for (const auto& Image : Images) {
    dl_phdr_info Info {};
    Info.dlpi_addr = static_cast<std::uintptr_t>(Image.LoadBias);
    Info.dlpi_name = Image.Name;
    Info.dlpi_phdr = static_cast<const Elf64_Phdr*>(Image.ProgramHeaders);
    Info.dlpi_phnum = Image.ProgramHeaderCount;
    if (const int Result = callback(&Info, sizeof(Info), data); Result != 0) {
      return Result;
    }
  }
  return 0;
}

// libkernel's flexible memory budget counts the guest images' loaded segments (DarwinModuleInfo's GuestSegmentBytes on
// the Rosetta route): each PT_LOAD with file content that is not read-write-execute, in whole 16 KiB pages.
extern "C" std::uint64_t GuestImageSegmentBytes_nid_no_patch() {
  constexpr std::uint64_t Mask = 0x4000 - 1;
  std::uint64_t Bytes = 0;
  std::lock_guard Lock(RegistryMutex);
  for (const auto& Image : Registry()) {
    const auto* Headers = static_cast<const Elf64_Phdr*>(Image.ProgramHeaders);
    for (std::uint16_t Index = 0; Index < Image.ProgramHeaderCount; ++Index) {
      const auto& Header = Headers[Index];
      if (Header.p_type != 1 || Header.p_offset == 0 || (Header.p_flags & 7) == 7) {
        continue;
      }
      Bytes += ((Header.p_vaddr + Header.p_memsz + Mask) & ~Mask) - (Header.p_vaddr & ~Mask);
    }
  }
  return Bytes;
}

// dyld knows the Rosetta route's guest images, which are Mach-O; here dladdr also answers for an address in a loaded
// segment of a registered guest image, with the image's name and load bias and no symbol. AnyPS5's libc asks it
// whether a thread_local destructor is in a loaded image (libSceLibcInternal's CallThreadDestructor). Fault handlers
// call it too, so the registry is only tried, never waited for.
extern "C" int dladdr(const void* Address, Dl_info* Info) {
  static const auto System = reinterpret_cast<int (*)(const void*, Dl_info*)>(dlsym(RTLD_NEXT, "dladdr"));
  if (System && System(Address, Info)) {
    return 1;
  }
  const auto Value = reinterpret_cast<std::uintptr_t>(Address);
  std::unique_lock Lock(RegistryMutex, std::try_to_lock);
  if (!Lock.owns_lock()) {
    return 0;
  }
  for (const auto& Image : Registry()) {
    const auto* Headers = static_cast<const Elf64_Phdr*>(Image.ProgramHeaders);
    for (std::uint16_t Index = 0; Index < Image.ProgramHeaderCount; ++Index) {
      const auto& Header = Headers[Index];
      const std::uint64_t Start = Image.LoadBias + Header.p_vaddr;
      if (Header.p_type == 1 && Value >= Start && Value - Start < Header.p_memsz) {
        Info->dli_fname = *Image.Name ? Image.Name : "eboot.bin";
        Info->dli_fbase = reinterpret_cast<void*>(Image.LoadBias);
        Info->dli_sname = nullptr;
        Info->dli_saddr = nullptr;
        return 1;
      }
    }
  }
  return 0;
}
