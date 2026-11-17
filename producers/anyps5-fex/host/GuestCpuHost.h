// SPDX-License-Identifier: GPL-2.0-only
// Fills AnyPS5's arm64 guest CPU table (prx/libc/include/GuestCpuArm64.hpp) from FEX's guest state accessors
// (FEXCore/Darwin/GuestState.h, MIT) and installs it once, before guest code runs. Each state accessor reads the guest
// bound to the calling OS thread by FEXCore::Darwin::ThreadScope.
//
// AnyPS5's libraries also run on host threads with no guest (VideoOut's vblank thread reads the process time counter,
// and so the TSC). There the CPUID, XGETBV and TSC answers come from the FEX context, which needs no thread, and the
// MXCSR and x87 control and status words read as their reset values and ignore writes.
#pragma once

#include "FexGuest.h"

#include <FEXCore/Darwin/GuestState.h>

#include "prx/libc/include/GuestCpuArm64.hpp"

namespace FexGuest {
namespace HostCpu {
inline bool Bound() {
  return FEXCore::Darwin::CurrentThread != nullptr;
}
inline std::array<std::uint32_t, 4> Cpuid(std::uint32_t Leaf, std::uint32_t Subleaf) {
  const auto Result = CTX->RunCPUIDFunction(Leaf, Subleaf);
  return {Result.eax, Result.ebx, Result.ecx, Result.edx};
}
inline std::uint64_t Xgetbv(std::uint32_t Index) {
  const auto Result = CTX->RunXCRFunction(Index);
  return (std::uint64_t {Result.edx} << 32) | Result.eax;
}
// FEX's RDTSC scales CNTVCT by the ratio CPUID leaf 15h advertises (GuestState::ReadTsc).
inline std::uint64_t ReadTsc() {
  static const auto Ratio = CTX->RunCPUIDFunction(0x15, 0);
  if (!Ratio.eax) {
    std::abort();
  }
  std::uint64_t Counter;
  asm volatile("isb\n\tmrs %0, cntvct_el0" : "=r"(Counter));
  return Counter * Ratio.ebx / Ratio.eax;
}
inline std::uint32_t Mxcsr() {
  return Bound() ? FEXCore::Darwin::GuestState::Mxcsr() : 0x1F80;
}
inline void SetMxcsr(std::uint32_t Value) {
  if (Bound()) {
    FEXCore::Darwin::GuestState::SetMxcsr(Value);
  }
}
inline std::uint16_t X87Control() {
  return Bound() ? FEXCore::Darwin::GuestState::X87Control() : 0x37F;
}
inline void SetX87Control(std::uint16_t Value) {
  if (Bound()) {
    FEXCore::Darwin::GuestState::SetX87Control(Value);
  }
}
inline std::uint16_t X87Status() {
  return Bound() ? FEXCore::Darwin::GuestState::X87Status() : 0;
}
inline void SetX87Status(std::uint16_t Value) {
  if (Bound()) {
    FEXCore::Darwin::GuestState::SetX87Status(Value);
  }
}
} // namespace HostCpu

inline void InstallGuestCpuHost() {
  static GuestCpu::HostAccessors Host {};
  FEXCore::Darwin::GuestState::InstallHostAccessors(Host);
  Host.ReadTsc = HostCpu::ReadTsc;
  Host.Cpuid = HostCpu::Cpuid;
  Host.Xgetbv = HostCpu::Xgetbv;
  Host.Mxcsr = HostCpu::Mxcsr;
  Host.SetMxcsr = HostCpu::SetMxcsr;
  Host.X87Control = HostCpu::X87Control;
  Host.SetX87Control = HostCpu::SetX87Control;
  Host.X87Status = HostCpu::X87Status;
  Host.SetX87Status = HostCpu::SetX87Status;
  GuestCpuInstallHost_nid_no_patch(&Host);
}
} // namespace FexGuest
