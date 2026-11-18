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

#include "prx/libc/include/GuestContextArm64.hpp"
#include "prx/libc/include/GuestCpuArm64.hpp"

#include <cstring>

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

// AnyPS5's guest context accessors (prx/libc/include/GuestContextArm64.hpp): setjmp, getcontext and the others capture
// the calling guest thread's registers, and longjmp, setcontext and swapcontext restore them and throw
// GuestContext::Transfer, which FexGuest::Loop takes as "resume at the restored rip". The FXSAVE image carries the x87
// control and status words, the abridged tag word, MXCSR, ST0-ST7 and XMM0-XMM15.
namespace HostContext {
using Frame = GuestContext::RegisterFrame;
constexpr std::uint64_t Frame::* General[16] = {&Frame::rax, &Frame::rbx, &Frame::rcx, &Frame::rdx, &Frame::rsi, &Frame::rdi,
                                                &Frame::rbp, &Frame::rsp, &Frame::r8,  &Frame::r9,  &Frame::r10, &Frame::r11,
                                                &Frame::r12, &Frame::r13, &Frame::r14, &Frame::r15};
constexpr unsigned Numbers[16] = {X86::REG_RAX, X86::REG_RBX, X86::REG_RCX, X86::REG_RDX, X86::REG_RSI, X86::REG_RDI,
                                  X86::REG_RBP, X86::REG_RSP, X86::REG_R8,  X86::REG_R9,  X86::REG_R10, X86::REG_R11,
                                  X86::REG_R12, X86::REG_R13, X86::REG_R14, X86::REG_R15};
constexpr std::size_t ControlWord = 0, StatusWord = 2, TagWord = 4, MxcsrAt = 24, MxcsrMaskAt = 28, X87At = 32, XmmAt = 160;

[[noreturn]] inline void Unbound(const char* What) {
  std::printf("guest context %s on a thread with no guest thread\nFAIL\n", What);
  std::fflush(stdout);
  std::_Exit(1);
}
inline void Capture(Frame* Result) {
  if (!HostCpu::Bound()) {
    Unbound("capture");
  }
  auto& Thread = FEXCore::Darwin::GuestState::Thread();
  auto& State = Thread.CurrentFrame->State;
  *Result = {};
  for (int i = 0; i < 16; ++i) {
    Result->*General[i] = State.gregs[Numbers[i]];
  }
  Result->rip = State.rip;
  Result->rflags = CTX->ReconstructCompactedEFLAGS(&Thread, false, nullptr, 0);
  Result->cs = 0x43;
  Result->ss = 0x3b;
  const std::uint16_t Control = State.FCW, Status = FEXCore::Darwin::GuestState::X87Status();
  const std::uint32_t Mxcsr = State.mxcsr, MxcsrMask = FEXCore::Darwin::GuestState::MxcsrMask();
  std::memcpy(Result->fxsave + ControlWord, &Control, sizeof(Control));
  std::memcpy(Result->fxsave + StatusWord, &Status, sizeof(Status));
  Result->fxsave[TagWord] = State.AbridgedFTW;
  std::memcpy(Result->fxsave + MxcsrAt, &Mxcsr, sizeof(Mxcsr));
  std::memcpy(Result->fxsave + MxcsrMaskAt, &MxcsrMask, sizeof(MxcsrMask));
  for (int i = 0; i < 8; ++i) {
    std::memcpy(Result->fxsave + X87At + 16 * i, State.mm[i], 10);
  }
  for (int i = 0; i < 16; ++i) {
    std::memcpy(Result->fxsave + XmmAt + 16 * i, State.xmm.sse.data[i], 16);
  }
}
inline void Restore(const Frame* Source) {
  if (!HostCpu::Bound()) {
    Unbound("restore");
  }
  auto& Thread = FEXCore::Darwin::GuestState::Thread();
  auto& State = Thread.CurrentFrame->State;
  for (int i = 0; i < 16; ++i) {
    State.gregs[Numbers[i]] = Source->*General[i];
  }
  State.rip = Source->rip;
  CTX->SetFlagsFromCompactedEFLAGS(&Thread, static_cast<std::uint32_t>(Source->rflags));
  std::uint16_t Control, Status;
  std::uint32_t Mxcsr;
  std::memcpy(&Control, Source->fxsave + ControlWord, sizeof(Control));
  std::memcpy(&Status, Source->fxsave + StatusWord, sizeof(Status));
  std::memcpy(&Mxcsr, Source->fxsave + MxcsrAt, sizeof(Mxcsr));
  State.FCW = Control;
  FEXCore::Darwin::GuestState::SetX87Status(Status);
  State.AbridgedFTW = Source->fxsave[TagWord];
  FEXCore::Darwin::GuestState::SetMxcsr(Mxcsr);
  for (int i = 0; i < 8; ++i) {
    std::memcpy(State.mm[i], Source->fxsave + X87At + 16 * i, 10);
  }
  for (int i = 0; i < 16; ++i) {
    std::memcpy(State.xmm.sse.data[i], Source->fxsave + XmmAt + 16 * i, 16);
  }
}
} // namespace HostContext

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
  static const GuestContext::HostAccessors Context {HostContext::Capture, HostContext::Restore};
  GuestContextInstallHost_nid_no_patch(&Context);
  IsGuestTransfer = [](std::exception_ptr Thrown) {
    try {
      std::rethrow_exception(Thrown);
    } catch (const GuestContext::Transfer&) {
      return true;
    } catch (...) {
      return false;
    }
  };
}
} // namespace FexGuest
