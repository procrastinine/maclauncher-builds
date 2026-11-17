// SPDX-License-Identifier: GPL-2.0-only
// FEXCore setup shared by the proof hosts: x86-64 guest threads in an arm64 macOS process, each bound to its own OS
// thread. Guest calls into the host arrive at HLT stubs; FEXCore returns to the host at each HLT, the host runs the
// thunk and resumes the guest.
#pragma once

#include <FEXCore/Config/Config.h>
#include <FEXCore/Core/Context.h>
#include <FEXCore/Core/CoreState.h>
#include <FEXCore/Core/HostFeatures.h>
#include <FEXCore/Core/SignalDelegator.h>
#include <FEXCore/Core/X86Enums.h>
#include <FEXCore/Darwin/SignalDelegator.h>
#include <FEXCore/Debug/InternalThreadState.h>
#include <FEXCore/HLE/SyscallHandler.h>
#include <FEXCore/Utils/LogManager.h>
#include <FEXCore/Utils/SignalScopeGuards.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <mutex>
#include <signal.h>
#include <span>
#include <sys/mman.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <vector>

namespace FexGuest {
using FEXCore::Core::CPUState;
namespace X86 = FEXCore::X86State;

// Stub page layout: offset 0 is the HLT that ends the run (the guest entry's return address), offset 8 the HLT that
// ends a guest callback (CallGuest), thunk i is the HLT at ThunkStubOffset + i * ThunkStubSize, and X87ReturnStub
// loads st(0) from X87ReturnSlot and returns to the guest caller.
inline std::uint64_t StubBase = 0;
constexpr std::uint64_t StackSize = 1 << 20;
constexpr std::uint64_t CallbackReturnOffset = 8;
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

// Guest memory the host owns: every MapGuest allocation. The Darwin signal delegator asks for these ranges; faults
// outside them go to the handlers installed before it (InstallFaultReport). No guest page is write-protected for code
// tracking yet, so WriteProtectedForCode stays false. Any thread maps guest memory, and a fault handler on any thread
// reads the table, so entries are only appended: a writer fills the next entry under the mutex, then publishes the
// count.
constexpr std::size_t MaximumOwnedRanges = 1 << 16;
inline FEXCore::Darwin::GuestMemoryRegion OwnedRanges[MaximumOwnedRanges];
inline std::atomic<std::size_t> OwnedRangeCount {0};
inline std::mutex OwnedRangeMutex;
inline void AddOwnedRange(const FEXCore::Darwin::GuestMemoryRegion& Region) {
  std::lock_guard Lock(OwnedRangeMutex);
  const std::size_t Index = OwnedRangeCount.load(std::memory_order_relaxed);
  if (Index == MaximumOwnedRanges) {
    std::printf("more than %zu guest memory ranges\nFAIL\n", MaximumOwnedRanges);
    std::exit(1);
  }
  OwnedRanges[Index] = Region;
  OwnedRangeCount.store(Index + 1, std::memory_order_release);
}

// Set by a host that loads guest modules: writes "module+0xoffset" for a guest address. Runs in signal context.
inline void (*DescribeGuestAddress)(std::uint64_t Address, char* Text, std::size_t Size) = nullptr;

// Drops FEX's translated code for a guest range: the shared code buffers and the host's one guest thread's cache.
// FEX requires its code invalidation mutex held uniquely around both calls. Its check of that, try_lock(), is still
// evaluated with assertions off, so a call without the lock takes the mutex and keeps it, and the thread's next
// compile then waits for it forever (test-sequence 0481: __ulock_wait2 with the guest at main).
inline void InvalidateGuestCode(FEXCore::Core::InternalThreadState* Calling, std::uint64_t Start, std::uint64_t Length) {
  auto Lock = FEXCore::GuardSignalDeferringSection(Calling->CTX->GetCodeInvalidationMutex(), Calling);
  Calling->CTX->InvalidateCodeBuffersCodeRange(Start, Length);
  Calling->CTX->InvalidateThreadCachedCodeRange(Calling, Start, Length);
}

inline FEXCore::Darwin::SignalCallbacks GuestSignalCallbacks() {
  FEXCore::Darwin::SignalCallbacks Callbacks {};
  Callbacks.QueryMemory = [](FEXCore::Core::InternalThreadState*, std::uintptr_t Address, FEXCore::Darwin::GuestMemoryRegion& Region, void*) {
    const std::size_t Count = OwnedRangeCount.load(std::memory_order_acquire);
    for (std::size_t i = 0; i < Count; ++i) {
      const auto& Owned = OwnedRanges[i];
      if (Address >= Owned.Base && Address - Owned.Base < Owned.Size) {
        Region = Owned;
        return true;
      }
    }
    return false;
  };
  Callbacks.InvalidateCode = [](FEXCore::Core::InternalThreadState* Thread, std::uintptr_t Start, std::size_t Length, void*) {
    InvalidateGuestCode(Thread, Start, Length);
    return true;
  };
  // The host has no guest exception handlers yet: report the guest exception, then let the fault report end the run.
  Callbacks.DeliverException = [](FEXCore::Core::InternalThreadState*, const FEXCore::Darwin::GuestException& Exception, void*) {
    char Where[96] = "?";
    if (DescribeGuestAddress) {
      DescribeGuestAddress(Exception.GuestRIP, Where, sizeof(Where));
    }
    char Text[256];
    const int Length = std::snprintf(Text, sizeof(Text), "guest exception: signal %d, trap %u, error 0x%x, address 0x%llx, guest rip 0x%llx (%s)\n",
                                     Exception.Signal, Exception.TrapNo, Exception.ErrorCode,
                                     static_cast<unsigned long long>(Exception.Address), static_cast<unsigned long long>(Exception.GuestRIP), Where);
    write(STDOUT_FILENO, Text, Length);
    return false;
  };
  return Callbacks;
}

// A host that handles SYSCALL itself sets this before the first Run.
inline FEXCore::HLE::SyscallHandler* SyscallHandlerOverride = nullptr;

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
  std::uint64_t DCZID = 0;
  __asm volatile("mrs %0, dczid_el0" : "=r"(DCZID));
  Features.SupportsCLZERO = (DCZID & 0x10) == 0 && (4U << (DCZID & 0xf)) == 64;
  Features.Supports3DNow = true;
  Features.SupportsAES256 = Features.SupportsAES;
  // Process-level features (FEX 2611): an x86-64 guest with AVX and no SVE, on a host that is neither Linux nor Windows.
  Features.ProcessFeatures.HostType = FEXCore::HostFeatures::HostTypeEnum::Unknown;
  Features.ProcessFeatures.Is64BitMode = 1;
  Features.ProcessFeatures.SupportsAVX = 1;
  Features.ProcessFeatures.SupportsSVE128 = 0;
  Features.ProcessFeatures.SupportsSVE256 = 0;
  Features.ProcessPID = getpid();
  return Features;
}

inline void* MapGuest(std::uint64_t Size) {
  void* Result = mmap(nullptr, Size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (Result == MAP_FAILED) {
    std::perror("mmap");
    std::exit(2);
  }
  AddOwnedRange({reinterpret_cast<std::uintptr_t>(Result), Size, true, true, false});
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
  Stubs[CallbackReturnOffset] = 0xF4;
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

inline FEXCore::Context::Context* CTX = nullptr;
// The guest thread bound to this OS thread.
inline thread_local FEXCore::Core::InternalThreadState* Thread = nullptr;
// Set by the first Run, before any other guest thread starts; read by every thread afterwards.
inline std::span<const Thunk> ActiveThunks;
inline std::uint64_t* ActiveThunkCalls = nullptr;

// Executes this OS thread's guest thread until its rip is StopAt or Breakpoint (0 for none), dispatching thunks on the
// way.
inline void Loop(std::uint64_t StopAt, std::uint64_t Breakpoint) {
  auto& Guest = Thread->CurrentFrame->State;
  for (;;) {
    CTX->ExecuteThread(Thread);
    if (Guest.rip == StopAt || (Breakpoint != 0 && Guest.rip == Breakpoint)) {
      return;
    }
    const std::uint64_t Stop = Guest.rip - StubBase;
    if (Guest.rip < StubBase || Stop < ThunkStubOffset || (Stop - ThunkStubOffset) % ThunkStubSize != 0 ||
        (Stop - ThunkStubOffset) / ThunkStubSize >= ActiveThunks.size()) {
      std::printf("guest stopped at 0x%llx outside the thunk stubs\nFAIL\n", static_cast<unsigned long long>(Guest.rip));
      std::exit(1);
    }
    __atomic_fetch_add(ActiveThunkCalls, 1, __ATOMIC_RELAXED);
    if (ActiveThunks[(Stop - ThunkStubOffset) / ThunkStubSize](Guest) == After::Return) {
      auto& RSP = Guest.gregs[X86::REG_RSP];
      Guest.rip = *reinterpret_cast<std::uint64_t*>(RSP);
      RSP += 8;
    }
  }
}

struct GuestResult {
  std::uint64_t Rax;
  std::uint64_t Xmm0;
};

// Calls a guest function from inside a host thunk, on the same guest thread: System V integer and float arguments in
// registers, a frame below the caller's red zone, and the callback-return HLT as its return address. The interrupted
// guest state is restored afterwards, so callbacks nest.
inline GuestResult CallGuest(std::uint64_t Function, std::span<const std::uint64_t> Integers, std::span<const double> Floats) {
  static constexpr int Registers[] = {X86::REG_RDI, X86::REG_RSI, X86::REG_RDX, X86::REG_RCX, X86::REG_R8, X86::REG_R9};
  if (Integers.size() > 6 || Floats.size() > 8) {
    std::printf("guest callback with stack arguments is not supported yet\nFAIL\n");
    std::exit(1);
  }
  auto& Guest = Thread->CurrentFrame->State;
  std::uint64_t SavedGregs[16];
  std::uint64_t SavedXmm[16][2];
  std::memcpy(SavedGregs, Guest.gregs, sizeof(SavedGregs));
  std::memcpy(SavedXmm, Guest.xmm.sse.data, sizeof(SavedXmm));
  const std::uint64_t SavedRip = Guest.rip;

  std::uint64_t RSP = ((Guest.gregs[X86::REG_RSP] - 128) & ~15ULL) - 8;
  *reinterpret_cast<std::uint64_t*>(RSP) = StubBase + CallbackReturnOffset;
  Guest.gregs[X86::REG_RSP] = RSP;
  for (std::size_t i = 0; i < Integers.size(); ++i) {
    Guest.gregs[Registers[i]] = Integers[i];
  }
  for (std::size_t i = 0; i < Floats.size(); ++i) {
    std::memcpy(&Guest.xmm.sse.data[i][0], &Floats[i], 8);
    Guest.xmm.sse.data[i][1] = 0;
  }
  Guest.gregs[X86::REG_RAX] = Floats.size();
  Guest.rip = Function;
  Loop(StubBase + CallbackReturnOffset, 0);

  const GuestResult Result {Guest.gregs[X86::REG_RAX], Guest.xmm.sse.data[0][0]};
  std::memcpy(Guest.gregs, SavedGregs, sizeof(SavedGregs));
  std::memcpy(Guest.xmm.sse.data, SavedXmm, sizeof(SavedXmm));
  Guest.rip = SavedRip;
  return Result;
}

// A FEX guest thread with Initial's state: a flat 64-bit code segment, as FEX's Linux frontend sets up for a new
// thread, and the call-return stack FEXCore uses to predict returns, with a guard page on each side.
inline FEXCore::Core::InternalThreadState* NewThread(CPUState& Initial) {
  static std::mutex CreateMutex;
  std::lock_guard Lock(CreateMutex);
  Initial.mxcsr = 0x1F80;
  auto* Created = CTX->CreateThread(&Initial);
  auto& Guest = Created->CurrentFrame->State;
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
  const std::uint64_t PageSize = getpagesize();
  const std::uint64_t CallRetSize = FEXCore::Core::InternalThreadState::CALLRET_STACK_SIZE;
  auto CallRet = reinterpret_cast<std::uint64_t>(mmap(nullptr, CallRetSize + 2 * PageSize, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0));
  Created->CallRetStackBase = reinterpret_cast<void*>(CallRet + PageSize);
  mprotect(Created->CallRetStackBase, CallRetSize, PROT_READ | PROT_WRITE);
  Guest.callret_sp = CallRet + PageSize + CallRetSize / 4;
  return Created;
}

// Runs a new guest thread on the calling OS thread, which must have none: Entry(Argument) on a guest stack whose top is
// StackTop, with FS base FsBase, until the entry returns to stub 0. Finish (if any) then runs while the guest thread
// still exists. Returns its rax. A thunk that ends the thread (pthread_exit) throws, and the exception leaves through
// here after the guest thread is destroyed.
inline std::uint64_t RunNewThread(std::uint64_t Entry, std::uint64_t Argument, std::uint64_t StackTop, std::uint64_t FsBase,
                                  void (*Finish)() = nullptr) {
  CPUState Initial {};
  StackTop = (StackTop & ~15ULL) - 8;
  *reinterpret_cast<std::uint64_t*>(StackTop) = StubBase;
  Initial.rip = Entry;
  Initial.gregs[X86::REG_RDI] = Argument;
  Initial.gregs[X86::REG_RSP] = StackTop;
  Initial.fs_cached = FsBase;
  Thread = NewThread(Initial);
  struct Release {
    ~Release() {
      const std::uint64_t PageSize = getpagesize();
      auto* CallRet = static_cast<std::uint8_t*>(Thread->CallRetStackBase) - PageSize;
      CTX->DestroyThread(Thread);
      Thread = nullptr;
      munmap(CallRet, FEXCore::Core::InternalThreadState::CALLRET_STACK_SIZE + 2 * PageSize);
    }
  } Destroy;
  FEXCore::Darwin::ThreadScope Bound {Thread};
  Loop(StubBase, 0);
  const std::uint64_t Result = Thread->CurrentFrame->State.gregs[X86::REG_RAX];
  if (Finish) {
    Finish();
  }
  return Result;
}

// Runs the guest from Initial until it returns to stub 0 or reaches Breakpoint (a HLT the caller placed), dispatching
// thunks. The first call creates the FEXCore context and the guest thread; later calls reuse that thread with the rip,
// general registers and FS base of Initial. Returns the guest state, which lives as long as the process.
inline const CPUState& Run(CPUState& Initial, std::span<const Thunk> Thunks, std::uint64_t& ThunkCalls, std::uint64_t Breakpoint = 0) {
  ActiveThunks = Thunks;
  ActiveThunkCalls = &ThunkCalls;
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
    // Installed once, after InstallFaultReport, which stays the handler for faults the delegator does not own.
    static FEXCore::Darwin::SignalDelegator Signals {GuestSignalCallbacks()};
    if (!Signals.Install()) {
      std::printf("Darwin signal delegator install failed\nFAIL\n");
      std::exit(1);
    }
    static SyscallHandler Syscalls;
    CTX->SetSignalDelegator(&Signals);
    CTX->SetSyscallHandler(SyscallHandlerOverride ? SyscallHandlerOverride : &Syscalls);
    CTX->EnableExitOnHLT();
    if (!CTX->InitCore()) {
      std::printf("InitCore failed\nFAIL\n");
      std::exit(1);
    }
    std::printf("FEXCore initialized\n");

    Thread = NewThread(Initial);
    std::printf("guest thread created; running 0x%llx\n", static_cast<unsigned long long>(Thread->CurrentFrame->State.rip));
  }
  // Binds the guest to this OS thread for translated code and for the thunks, which run between HLT exits.
  FEXCore::Darwin::ThreadScope Bound {Thread};
  Loop(StubBase, Breakpoint);
  return Thread->CurrentFrame->State;
}
} // namespace FexGuest
