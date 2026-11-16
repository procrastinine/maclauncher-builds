// SPDX-License-Identifier: GPL-2.0-only
// The FEX route's guest image registry for AnyPS5's libraries. On the Rosetta route the relinker records each guest
// image's load bias and ELF program headers in a Mach-O __APS5DATA,__meta section, and libc's
// specifics/macos/GuestImages.cpp walks those sections in dl_iterate_phdr. Here anyps5-fex-start loads the guest
// images itself and registers them, so the same callers (process parameters, the unwinder) see the same images.

#include "GuestImages.h"

#include "prx/libc/include/specifics/linux/ElfTypes.hpp"

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
