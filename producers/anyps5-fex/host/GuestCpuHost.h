// SPDX-License-Identifier: GPL-2.0-only
// Fills AnyPS5's arm64 guest CPU table (prx/libc/include/GuestCpuArm64.hpp) from FEX's guest state accessors
// (FEXCore/Darwin/GuestState.h, MIT) and installs it once, before guest code runs. Each accessor reads the guest bound to
// the calling OS thread by FEXCore::Darwin::ThreadScope.
#pragma once

#include <FEXCore/Darwin/GuestState.h>

#include "prx/libc/include/GuestCpuArm64.hpp"

namespace FexGuest {
inline void InstallGuestCpuHost() {
  static GuestCpu::HostAccessors Host {};
  FEXCore::Darwin::GuestState::InstallHostAccessors(Host);
  GuestCpuInstallHost_nid_no_patch(&Host);
}
} // namespace FexGuest
