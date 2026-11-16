// SPDX-License-Identifier: GPL-2.0-only
#pragma once

#include <cstdint>

namespace FexGuest {

// A loaded guest image as dl_iterate_phdr reports it: the main image's name is empty, as on the Rosetta route.
struct GuestImage {
  const char* Name;
  std::uint64_t LoadBias;
  const void* ProgramHeaders;
  std::uint16_t ProgramHeaderCount;
};

void RegisterGuestImage(const GuestImage& Image);

} // namespace FexGuest
