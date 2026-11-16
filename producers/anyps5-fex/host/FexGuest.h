// SPDX-License-Identifier: GPL-2.0-only
// FEXCore setup shared by the proof hosts: one x86-64 guest thread in an arm64 macOS process. Guest calls into the host
// arrive at HLT stubs; FEXCore returns to the host at each HLT, the host runs the thunk and resumes the guest.
#pragma once

#include <FEXCore/Config/Config.h>
#include <FEXCore/Core/Context.h>
#include <FEXCore/Core/CoreState.h>
#include <FEXCore/Core/HostFeatures.h>
#include <FEXCore/Core/SignalDelegator.h>
#include <FEXCore/Core/X86Enums.h>
#include <FEXCore/Debug/InternalThreadState.h>
#include <FEXCore/HLE/SyscallHandler.h>
#include <FEXCore/Utils/LogManager.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <signal.h>
#include <span>
#include <sys/mman.h>
#include <sys/sysctl.h>
#include <unistd.h>

namespace FexGuest {
using FEXCore::Core::CPUState;
namespace X86 = FEXCore::X86State;

// Stub page layout: offset 0 is the HLT that ends the run (the guest entry's return address), thunk i is the HLT at
// ThunkStubOffset + i * ThunkStubSize, X87ReturnStub loads st(0) from X87ReturnSlot and returns to the guest caller.
inline std::uint64_t StubBase = 0;
constexpr std::uint64_t StackSize = 1 << 20;
constexpr std::uint64_t ThunkStubOffset = 16;
constexpr std::uint64_t ThunkStubSize = 16;
constexpr std::uint64_t StubPageSize = 0x10000;
constexpr std::uint64_t X87ReturnStubOffset = 0xF000;
constexpr std::uint64_t X87ReturnSlotOffset = 0xF100;
constexpr std::size_t MaximumThunks = (X87ReturnStubOffset - ThunkStubOffset) / ThunkStubSize;
inline std::uint64_t X87ReturnStub() {
  return StubBase + X87ReturnStubOffset;
}
inline void* X87ReturnSlot() {
  return reinterpret_cast<void*>(StubBase + X87ReturnSlotOffset);
}

// After a thunk the host either performs the guest's RET, or resumes at the RIP the thunk set.
enum class After { Return, Continue };
using Thunk = After (*)(CPUState& State);

// PS5 game code reaches the system only through library imports; a SYSCALL instruction ends the run.
class SyscallHandler final : public FEXCore::HLE::SyscallHandler {
public:
  void HandleSyscall(FEXCore::Core::CpuStateFrame* Frame) override {
    std::printf("guest SYSCALL at 0x%llx\nFAIL\n", static_cast<unsigned long long>(Frame->State.rip));
    std::exit(3);
  }
  FEXCore::HLE::ExecutableRangeInfo QueryGuestExecutableRange(FEXCore::Core::InternalThreadState*, std::uint64_t Address) override {
    return {Address & ~0x3fffULL, 0x4000, false};
  }
  std::optional<FEXCore::ExecutableFileSectionInfo> LookupExecutableFileSection(FEXCore::Core::InternalThreadState*, std::uint64_t) override {
    return std::nullopt;
  }
};

class SignalDelegator final : public FEXCore::SignalDelegator {};

inline bool Sysctl(const char* Name) {
  int Value = 0;
  size_t Size = sizeof(Value);
  return sysctlbyname(Name, &Value, &Size, nullptr, 0) == 0 && Value != 0;
}

// FEX's Linux frontend reads the ID registers, which macOS does not expose to user space; the same facts come from
// sysctl here.
inline FEXCore::HostFeatures DarwinHostFeatures() {
  FEXCore::HostFeatures Features {};
  std::uint64_t LineSize = 64;
  size_t Size = sizeof(LineSize);
  sysctlbyname("hw.cachelinesize", &LineSize, &Size, nullptr, 0);
  Features.DCacheLineLog2 = __builtin_ctzll(LineSize / 4);
  Features.SupportsCacheMaintenanceOps = true;
  Features.SupportsAES = Sysctl("hw.optional.arm.FEAT_AES");
  Features.SupportsCRC = Sysctl("hw.optional.armv8_crc32");
  Features.SupportsSHA = Sysctl("hw.optional.arm.FEAT_SHA1") && Sysctl("hw.optional.arm.FEAT_SHA256");
  Features.SupportsAtomics = Sysctl("hw.optional.arm.FEAT_LSE");
  Features.SupportsRAND = Sysctl("hw.optional.arm.FEAT_RNG");
  Features.SupportsAFP = Sysctl("hw.optional.arm.FEAT_AFP");
  Features.SupportsRCPC = Sysctl("hw.optional.arm.FEAT_LRCPC");
  Features.SupportsTSOImm9 = Sysctl("hw.optional.arm.FEAT_LRCPC2");
  Features.SupportsPMULL_128Bit = Sysctl("hw.optional.arm.FEAT_PMULL");
  Features.SupportsCSSC = Sysctl("hw.optional.arm.FEAT_CSSC");
  Features.SupportsFCMA = Sysctl("hw.optional.arm.FEAT_FCMA");
  Features.SupportsFlagM = Sysctl("hw.optional.arm.FEAT_FlagM");
  Features.SupportsFlagM2 = Sysctl("hw.optional.arm.FEAT_FlagM2");
  Features.SupportsFRINTTS = Sysctl("hw.optional.arm.FEAT_FRINTTS");
  Features.SupportsRPRES = Sysctl("hw.optional.arm.FEAT_RPRES");
  Features.SupportsECV = Sysctl("hw.optional.arm.FEAT_ECV");
  Features.SupportsWFXT = Sysctl("hw.optional.arm.FEAT_WFxT");
  Features.SupportsI8MM = Sysctl("hw.optional.arm.FEAT_I8MM");
  Features.SupportsDotProd = Sysctl("hw.optional.arm.FEAT_DotProd");
  Features.SupportsMOPS = Sysctl("hw.optional.arm.FEAT_MOPS");
  Features.SupportsSVE128 = false;
  Features.SupportsSVE256 = false;
  std::uint64_t DCZID = 0;
  __asm volatile("mrs %0, dczid_el0" : "=r"(DCZID));
  Features.SupportsCLZERO = (DCZID & 0x10) == 0 && (4U << (DCZID & 0xf)) == 64;
  Features.Supports3DNow = true;
  Features.SupportsAVX = true;
  Features.SupportsAES256 = Features.SupportsAES;
  Features.HostType = FEXCore::HostFeatures::HostTypeEnum::Unknown;
  Features.ProcessPID = getpid();
  return Features;
}

inline void* MapGuest(std::uint64_t Size) {
  void* Result = mmap(nullptr, Size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (Result == MAP_FAILED) {
    std::perror("mmap");
    std::exit(2);
  }
  return Result;
}

// The host has no guest fault handling yet, so a fault ends the run with its signal number instead of a crash report.
inline void InstallFaultReport() {
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  for (int Signal : {SIGSEGV, SIGBUS, SIGILL, SIGTRAP}) {
    struct sigaction Action {};
    Action.sa_sigaction = [](int Signal, siginfo_t* Info, void* Context) {
      const auto* State = &static_cast<ucontext_t*>(Context)->uc_mcontext->__ss;
      Dl_info Where {};
      dladdr(reinterpret_cast<void*>(__darwin_arm_thread_state64_get_pc(*State)), &Where);
      char Text[256];
      const int Length = std::snprintf(Text, sizeof(Text), "host signal %d at address 0x%llx, pc 0x%llx (%s)\nFAIL\n", Signal,
                                       static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(Info->si_addr)),
                                       static_cast<unsigned long long>(__darwin_arm_thread_state64_get_pc(*State)),
                                       Where.dli_sname ? Where.dli_sname : "?");
      write(STDOUT_FILENO, Text, Length);
      _exit(1);
    };
    Action.sa_flags = SA_SIGINFO;
    sigaction(Signal, &Action, nullptr);
  }
}

inline void InitConfig() {
  LogMan::Throw::InstallHandler([](const char* Message) {
    std::fprintf(stderr, "FEXCore assertion: %s\n", Message);
    std::exit(4);
  });
  LogMan::Msg::InstallHandler([](LogMan::DebugLevels Level, const char* Message) {
    std::fprintf(stderr, "FEXCore %s: %s\n", LogMan::DebugLevelStr(Level), Message);
  });
  FEXCore::Config::Initialize();
  FEXCore::Config::Load();
  FEXCore::Config::Set(FEXCore::Config::CONFIG_IS64BIT_MODE, "1");
}

// Maps the stub page with HLTs for the final return and ThunkCount thunks, and the x87 return stub.
inline void MapStubs(std::size_t ThunkCount) {
  if (ThunkCount > MaximumThunks) {
    std::printf("%zu thunks exceed the stub page\nFAIL\n", ThunkCount);
    std::exit(1);
  }
  auto* Stubs = static_cast<std::uint8_t*>(MapGuest(StubPageSize));
  StubBase = reinterpret_cast<std::uint64_t>(Stubs);
  Stubs[0] = 0xF4;
  for (std::size_t i = 0; i < ThunkCount; ++i) {
    Stubs[ThunkStubOffset + i * ThunkStubSize] = 0xF4;
  }
  // fld tbyte [rip + disp32]; ret
  auto* X87 = Stubs + X87ReturnStubOffset;
  const std::int32_t Displacement = static_cast<std::int32_t>(X87ReturnSlotOffset - (X87ReturnStubOffset + 6));
  X87[0] = 0xDB;
  X87[1] = 0x2D;
  std::memcpy(X87 + 2, &Displacement, 4);
  X87[6] = 0xC3;
}

// A guest stack whose top holds the return address of the entry function: the HLT at stub offset 0.
inline std::uint64_t MapStack() {
  auto Stack = reinterpret_cast<std::uint64_t>(MapGuest(StackSize)) + StackSize - 16;
  Stack -= 8;
  *reinterpret_cast<std::uint64_t*>(Stack) = StubBase;
  return Stack;
}

// Runs the guest from Initial until it returns to stub 0 or reaches Breakpoint (a HLT the caller placed), dispatching
// thunks. The first call creates the FEXCore context and the guest thread; later calls reuse that thread with the rip,
// general registers and FS base of Initial. Returns the guest state, which lives as long as the process.
inline const CPUState& Run(CPUState& Initial, std::span<const Thunk> Thunks, std::uint64_t& ThunkCalls, std::uint64_t Breakpoint = 0) {
  static FEXCore::Context::Context* CTX = nullptr;
  static FEXCore::Core::InternalThreadState* Thread = nullptr;
  if (CTX) {
    auto& Guest = Thread->CurrentFrame->State;
    Guest.rip = Initial.rip;
    std::memcpy(Guest.gregs, Initial.gregs, sizeof(Guest.gregs));
    Guest.fs_cached = Initial.fs_cached;
    Guest.gs_cached = Initial.gs_cached;
    std::printf("guest thread resumed; running 0x%llx\n", static_cast<unsigned long long>(Guest.rip));
  } else {
    // The context lives for the rest of the process.
    CTX = FEXCore::Context::Context::CreateNewContext(DarwinHostFeatures()).release();
    static SignalDelegator Signals;
    static SyscallHandler Syscalls;
    CTX->SetSignalDelegator(&Signals);
    CTX->SetSyscallHandler(&Syscalls);
    CTX->EnableExitOnHLT();
    if (!CTX->InitCore()) {
      std::printf("InitCore failed\nFAIL\n");
      std::exit(1);
    }
    std::printf("FEXCore initialized\n");

    Initial.mxcsr = 0x1F80;
    Thread = CTX->CreateThread(&Initial);
    auto& Guest = Thread->CurrentFrame->State;

    // A flat 64-bit code segment, as FEX's Linux frontend sets up for a new thread.
    static CPUState::gdt_segment GDT[32] {};
    Guest.segment_arrays[CPUState::SEGMENT_ARRAY_INDEX_GDT] = GDT;
    Guest.segment_arrays[CPUState::SEGMENT_ARRAY_INDEX_LDT] = GDT;
    Guest.cs_idx = CPUState::DEFAULT_USER_CS << 3;
    auto* CodeSegment = CPUState::GetSegmentFromIndex(Guest, Guest.cs_idx);
    CPUState::SetGDTBase(CodeSegment, 0);
    CPUState::SetGDTLimit(CodeSegment, 0xF'FFFFU);
    CodeSegment->L = 1;
    CodeSegment->D = 0;
    Guest.cs_cached = 0;

    // The call-return stack FEXCore uses to predict returns, with a guard page on each side.
    const std::uint64_t PageSize = getpagesize();
    const std::uint64_t CallRetSize = FEXCore::Core::InternalThreadState::CALLRET_STACK_SIZE;
    auto CallRet = reinterpret_cast<std::uint64_t>(mmap(nullptr, CallRetSize + 2 * PageSize, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0));
    Thread->CallRetStackBase = reinterpret_cast<void*>(CallRet + PageSize);
    mprotect(Thread->CallRetStackBase, CallRetSize, PROT_READ | PROT_WRITE);
    Guest.callret_sp = CallRet + PageSize + CallRetSize / 4;
    std::printf("guest thread created; running 0x%llx\n", static_cast<unsigned long long>(Guest.rip));
  }
  auto& Guest = Thread->CurrentFrame->State;

  for (;;) {
    CTX->ExecuteThread(Thread);
    const std::uint64_t Stop = Guest.rip - StubBase;
    if (Stop == 0 || (Breakpoint != 0 && Guest.rip == Breakpoint)) {
      return Guest;
    }
    if (Guest.rip < StubBase || Stop < ThunkStubOffset || (Stop - ThunkStubOffset) % ThunkStubSize != 0 ||
        (Stop - ThunkStubOffset) / ThunkStubSize >= Thunks.size()) {
      std::printf("guest stopped at 0x%llx outside the thunk stubs\nFAIL\n", static_cast<unsigned long long>(Guest.rip));
      std::exit(1);
    }
    ++ThunkCalls;
    if (Thunks[(Stop - ThunkStubOffset) / ThunkStubSize](Guest) == After::Return) {
      auto& RSP = Guest.gregs[X86::REG_RSP];
      Guest.rip = *reinterpret_cast<std::uint64_t*>(RSP);
      RSP += 8;
    }
  }
}
} // namespace FexGuest
