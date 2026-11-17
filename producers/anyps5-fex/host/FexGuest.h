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
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <mutex>
#include <optional>
#include <pthread.h>
#include <signal.h>
#include <span>
#include <sys/mman.h>
#include <sys/sysctl.h>
#include <type_traits>
#include <unistd.h>
#include <vector>

namespace FexGuest {
using FEXCore::Core::CPUState;
namespace X86 = FEXCore::X86State;

// Stub page layout: offset 0 is the HLT that ends the run (the guest entry's return address), offset 8 the HLT that
// ends a guest callback (CallGuest), thunk i is the HLT at ThunkStubOffset + i * ThunkStubSize, X87ReturnStub
// loads st(0) from X87ReturnSlot and returns to the guest caller, and ExceptionReturn is the HLT a guest exception
// handler entered from translated code returns to.
inline std::uint64_t StubBase = 0;
constexpr std::uint64_t StackSize = 1 << 20;
constexpr std::uint64_t CallbackReturnOffset = 8;
constexpr std::uint64_t ThunkStubOffset = 16;
constexpr std::uint64_t ThunkStubSize = 16;
constexpr std::uint64_t StubPageSize = 0x10000;
constexpr std::uint64_t X87ReturnStubOffset = 0xF000;
constexpr std::uint64_t X87ReturnSlotOffset = 0xF100;
constexpr std::uint64_t ExceptionReturnOffset = 0xF080;
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

// Writes "symbol+0xoffset" for a host code address, or the guest module offset for a guest one.
inline void DescribeCode(std::uint64_t Address, char* Text, std::size_t Size) {
  Dl_info Where {};
  if (dladdr(reinterpret_cast<void*>(Address), &Where) && Where.dli_sname) {
    std::snprintf(Text, Size, "%s+0x%llx", Where.dli_sname,
                  static_cast<unsigned long long>(Address - reinterpret_cast<std::uintptr_t>(Where.dli_saddr)));
  } else if (DescribeGuestAddress) {
    DescribeGuestAddress(Address, Text, Size);
  } else {
    std::snprintf(Text, Size, "0x%llx", static_cast<unsigned long long>(Address));
  }
}

// Writes the mapping that holds Address: its range, protection and VM tag (the tag names JIT and allocator memory).
inline int DescribeMapping(const char* Label, std::uint64_t Address, char* Text, std::size_t Size) {
  mach_vm_address_t Start = Address;
  mach_vm_size_t Length = 0;
  vm_region_extended_info_data_t Info {};
  mach_msg_type_number_t Count = VM_REGION_EXTENDED_INFO_COUNT;
  mach_port_t Object = MACH_PORT_NULL;
  if (mach_vm_region(mach_task_self(), &Start, &Length, VM_REGION_EXTENDED_INFO, reinterpret_cast<vm_region_info_t>(&Info), &Count, &Object) !=
        KERN_SUCCESS ||
      Start > Address) {
    return std::snprintf(Text, Size, "  %s 0x%llx: not mapped\n", Label, static_cast<unsigned long long>(Address));
  }
  return std::snprintf(Text, Size, "  %s 0x%llx: mapping 0x%llx-0x%llx %c%c%c tag %u\n", Label, static_cast<unsigned long long>(Address),
                       static_cast<unsigned long long>(Start), static_cast<unsigned long long>(Start + Length), (Info.protection & VM_PROT_READ) ? 'r' : '-',
                       (Info.protection & VM_PROT_WRITE) ? 'w' : '-', (Info.protection & VM_PROT_EXECUTE) ? 'x' : '-', Info.user_tag);
}
// The faulting thread's guest side (defined below, after the thread state it reads).
inline void ReportGuestState(void* Context);

// The host has no guest fault handling yet, so a fault ends the run with its signal number, the faulting host code and
// its callers (the link register, then the frame-pointer chain on this thread's host stack) instead of a crash report.
// It also names the exception syndrome, the thread, the mappings of the pc and the address, and the guest state.
inline void InstallFaultReport() {
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  for (int Signal : {SIGSEGV, SIGBUS, SIGILL, SIGTRAP}) {
    struct sigaction Action {};
    Action.sa_sigaction = [](int Signal, siginfo_t* Info, void* Context) {
      static std::atomic<bool> Reporting {false};
      if (Reporting.exchange(true)) {
        _exit(1);
      }
      const auto* State = &static_cast<ucontext_t*>(Context)->uc_mcontext->__ss;
      const std::uint64_t PC = __darwin_arm_thread_state64_get_pc(*State);
      char Where[128], Text[320];
      DescribeCode(PC, Where, sizeof(Where));
      int Length = std::snprintf(Text, sizeof(Text), "host signal %d at address 0x%llx, pc 0x%llx (%s)\n", Signal,
                                 static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(Info->si_addr)),
                                 static_cast<unsigned long long>(PC), Where);
      write(STDOUT_FILENO, Text, Length);
      char Name[64] = "";
      pthread_getname_np(pthread_self(), Name, sizeof(Name));
      Length = std::snprintf(Text, sizeof(Text), "  esr 0x%x, si_code %d, thread \"%s\"\n", static_cast<ucontext_t*>(Context)->uc_mcontext->__es.__esr,
                             Info->si_code, Name);
      write(STDOUT_FILENO, Text, Length);
      write(STDOUT_FILENO, Text, DescribeMapping("pc", PC, Text, sizeof(Text)));
      write(STDOUT_FILENO, Text, DescribeMapping("address", reinterpret_cast<std::uintptr_t>(Info->si_addr), Text, sizeof(Text)));
      ReportGuestState(Context);
      DescribeCode(__darwin_arm_thread_state64_get_lr(*State), Where, sizeof(Where));
      Length = std::snprintf(Text, sizeof(Text), "  lr %s\n", Where);
      write(STDOUT_FILENO, Text, Length);
      const std::uintptr_t Top = reinterpret_cast<std::uintptr_t>(pthread_get_stackaddr_np(pthread_self()));
      const std::uintptr_t Bottom = Top - pthread_get_stacksize_np(pthread_self());
      std::uintptr_t Frame = __darwin_arm_thread_state64_get_fp(*State);
      for (int Depth = 0; Depth < 24 && Frame >= Bottom && Frame + 16 <= Top && (Frame & 7) == 0; ++Depth) {
        const auto* Record = reinterpret_cast<const std::uint64_t*>(Frame);
        if (!Record[1]) {
          break;
        }
        DescribeCode(Record[1], Where, sizeof(Where));
        Length = std::snprintf(Text, sizeof(Text), "  #%d %s\n", Depth, Where);
        write(STDOUT_FILENO, Text, Length);
        if (Record[0] <= Frame) {
          break;
        }
        Frame = Record[0];
      }
      write(STDOUT_FILENO, "FAIL\n", 5);
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
  Stubs[ExceptionReturnOffset] = 0xF4;
}

// A guest stack whose top holds the return address of the entry function: the HLT at stub offset 0.
inline std::uint64_t MapStack(std::uint64_t Size = StackSize, std::uint64_t* Base = nullptr) {
  const auto Mapped = reinterpret_cast<std::uint64_t>(MapGuest(Size));
  if (Base) {
    *Base = Mapped;
  }
  auto Stack = Mapped + Size - 16;
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
// Calls of each stub slot, for the host's watch output.
inline std::uint64_t SlotCalls[MaximumThunks] {};

// Whether this OS thread is running a thunk, where its guest state is in memory and consistent.
inline thread_local bool InHostCall = false;
inline void FinishTranslatedException(CPUState& Guest);

// Executes this OS thread's guest thread until its rip is StopAt or Breakpoint (0 for none), dispatching thunks on the
// way.
inline void Loop(std::uint64_t StopAt, std::uint64_t Breakpoint) {
  auto& Guest = Thread->CurrentFrame->State;
  for (;;) {
    CTX->ExecuteThread(Thread);
    if (Guest.rip == StopAt || (Breakpoint != 0 && Guest.rip == Breakpoint)) {
      return;
    }
    if (Guest.rip == StubBase + ExceptionReturnOffset) {
      FinishTranslatedException(Guest);
      continue;
    }
    const std::uint64_t Stop = Guest.rip - StubBase;
    if (Guest.rip < StubBase || Stop < ThunkStubOffset || (Stop - ThunkStubOffset) % ThunkStubSize != 0 ||
        (Stop - ThunkStubOffset) / ThunkStubSize >= ActiveThunks.size()) {
      std::printf("guest stopped at 0x%llx outside the thunk stubs\nFAIL\n", static_cast<unsigned long long>(Guest.rip));
      std::exit(1);
    }
    __atomic_fetch_add(ActiveThunkCalls, 1, __ATOMIC_RELAXED);
    __atomic_fetch_add(&SlotCalls[(Stop - ThunkStubOffset) / ThunkStubSize], 1, __ATOMIC_RELAXED);
    InHostCall = true;
    const After Next = ActiveThunks[(Stop - ThunkStubOffset) / ThunkStubSize](Guest);
    InHostCall = false;
    if (Next == After::Return) {
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

// Set by the thread layer (GuestThreads::AdoptHostThread): gives the calling OS thread, which runs no guest yet, a guest
// thread of its own through AdoptCallingThread, so a library's own worker thread can call the game's callbacks.
inline void (*AdoptHostThread)() = nullptr;

// Calls a guest function from inside a host thunk, on the same guest thread: System V integer and float arguments in
// registers, a frame below the caller's red zone, and the callback-return HLT as its return address. The interrupted
// guest state is restored afterwards, so callbacks nest. A host thread without a guest thread gets one first.
inline GuestResult CallGuest(std::uint64_t Function, std::span<const std::uint64_t> Integers, std::span<const double> Floats) {
  static constexpr int Registers[] = {X86::REG_RDI, X86::REG_RSI, X86::REG_RDX, X86::REG_RCX, X86::REG_R8, X86::REG_R9};
  if (Integers.size() > 6 || Floats.size() > 8) {
    std::printf("guest callback with stack arguments is not supported yet\nFAIL\n");
    std::exit(1);
  }
  if (!Thread) {
    if (!AdoptHostThread) {
      std::printf("a host thread calls guest function 0x%llx, and no thread layer gives it a guest thread\nFAIL\n",
                  static_cast<unsigned long long>(Function));
      std::exit(1);
    }
    AdoptHostThread();
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
  const bool OuterHostCall = InHostCall;
  InHostCall = false;
  Loop(StubBase + CallbackReturnOffset, 0);
  InHostCall = OuterHostCall;

  const GuestResult Result {Guest.gregs[X86::REG_RAX], Guest.xmm.sse.data[0][0]};
  std::memcpy(Guest.gregs, SavedGregs, sizeof(SavedGregs));
  std::memcpy(Guest.xmm.sse.data, SavedXmm, sizeof(SavedXmm));
  Guest.rip = SavedRip;
  return Result;
}

// FEX's return-prediction stack (x25 in translated code) has a guard page on each side. Deep call chains and calls
// without returns run into one; FEX's Linux frontend then puts x25 back at the stack's default position and resumes the
// faulting instruction (SyscallsSMCTracking.cpp, HandleSegfault). This handler does the same for the calling thread's
// stack and passes every other SIGBUS or SIGSEGV to the Darwin signal delegator installed before it.
//
// A host that write-protects memory to track writes (AnyPS5's guest write watch, for the GPU's copies of guest memory)
// sets ClaimHostFault: a write fault it claims (it reopens the page) resumes the faulting instruction, from host code
// and from translated guest code alike. An unaligned access stays the delegator's, which rewrites the instruction.
//
// Host code that calls a guest function pointer it read from guest memory (Agc keeps a command buffer's out-of-space
// callback in the guest's buffer struct) jumps into x86-64 code, and the instruction fetch faults (test-sequence 0721:
// SIGBUS at Hollow Knight's eboot+0x3ae140). On a guest thread inside a host call, and on a host thread with or without a
// guest thread of its own (CallGuest adopts it), the handler turns that jump into a call of the host's HostToGuestBridge,
// which runs the function with CallGuest: x16, which a call may clobber, carries the guest function, and the host
// caller's x0-x5, d0-d7, stack pointer and return address stay as they were.
//
// FEX keeps x86's memory order with acquire loads and release stores (LDAPR, STLR) and atomics, which take an alignment
// fault when an unaligned access crosses 16 bytes. The delegator rewrites such an instruction only when the pc is in
// the faulting thread's own code buffers; HandleUnownedUnaligned gives the same rewrite to one outside them that is
// neither host code nor a guest module (another thread's newer shared code buffer, for instance), on a guest thread.
inline void (*HostToGuestBridge)() = nullptr;
inline bool (*IsGuestCode)(std::uint64_t Address) = nullptr;
inline bool HandleUnownedUnaligned(void* Context) {
  auto* Bound = Thread;
  if (!Bound || FEXCore::Darwin::CurrentThread != Bound) {
    return false;
  }
  auto& State = static_cast<ucontext_t*>(Context)->uc_mcontext->__ss;
  const std::uint64_t PC = __darwin_arm_thread_state64_get_pc(State);
  Dl_info Image {};
  if (CTX->IsAddressInCodeBuffer(Bound, PC) || dladdr(reinterpret_cast<void*>(PC), &Image) || (IsGuestCode && IsGuestCode(PC))) {
    return false;
  }
  std::uint64_t GPRs[32];
  for (unsigned Index = 0; Index != 29; ++Index) {
    GPRs[Index] = State.__x[Index];
  }
  GPRs[29] = __darwin_arm_thread_state64_get_fp(State);
  GPRs[30] = __darwin_arm_thread_state64_get_lr(State);
  GPRs[31] = __darwin_arm_thread_state64_get_sp(State);
  std::optional<std::int32_t> Advance;
  {
    FEXCore::Utils::JITWriteScope Write;
    Advance = FEXCore::ArchHelpers::Arm64::HandleUnalignedAccess(Bound, FEXCore::ArchHelpers::Arm64::UnalignedHandlerType::HalfBarrier, PC, GPRs);
  }
  if (!Advance) {
    return false;
  }
  for (unsigned Index = 0; Index != 29; ++Index) {
    State.__x[Index] = GPRs[Index];
  }
  __darwin_arm_thread_state64_set_fp(State, GPRs[29]);
  __darwin_arm_thread_state64_set_lr_fptr(State, reinterpret_cast<void*>(GPRs[30]));
  __darwin_arm_thread_state64_set_sp(State, GPRs[31]);
  __darwin_arm_thread_state64_set_pc_fptr(State, reinterpret_cast<void*>(PC + *Advance));
  static std::atomic<int> Logged {0};
  if (Logged.fetch_add(1, std::memory_order_relaxed) < 8) {
    char Text[160];
    const int Length = std::snprintf(Text, sizeof(Text), "unaligned access at pc 0x%llx, outside this thread's code buffers, rewritten\n",
                                     static_cast<unsigned long long>(PC));
    write(STDOUT_FILENO, Text, Length);
  }
  return true;
}
inline struct sigaction DelegatorActions[2] {};
inline bool (*ClaimHostFault)(siginfo_t* Info, void* Context) = nullptr;
inline void CallRetGuard(int Signal, siginfo_t* Info, void* Context) {
  if (HostToGuestBridge && IsGuestCode && (Thread ? InHostCall : AdoptHostThread != nullptr)) {
    auto* Machine = static_cast<ucontext_t*>(Context)->uc_mcontext;
    const std::uint64_t PC = __darwin_arm_thread_state64_get_pc(Machine->__ss);
    if (PC == reinterpret_cast<std::uintptr_t>(Info->si_addr) && IsGuestCode(PC)) {
      Machine->__ss.__x[16] = PC;
      __darwin_arm_thread_state64_set_pc_fptr(Machine->__ss, reinterpret_cast<void*>(HostToGuestBridge));
      return;
    }
  }
  if (auto* Bound = Thread; Bound && Bound->CallRetStackBase) {
    const std::uintptr_t Base = reinterpret_cast<std::uintptr_t>(Bound->CallRetStackBase), Page = getpagesize();
    const std::uintptr_t Fault = reinterpret_cast<std::uintptr_t>(Info->si_addr);
    constexpr std::uintptr_t Size = FEXCore::Core::InternalThreadState::CALLRET_STACK_SIZE;
    if (Fault >= Base - Page && Fault < Base + Size + Page) {
      static_cast<ucontext_t*>(Context)->uc_mcontext->__ss.__x[25] = Base + Size / 4;
      return;
    }
  }
  const auto ESR = static_cast<ucontext_t*>(Context)->uc_mcontext->__es.__esr;
  const bool Alignment = ((ESR >> 26) == 0x24 || (ESR >> 26) == 0x25) && (ESR & 0x3f) == 0x21;
  if (Alignment && Signal == SIGBUS && HandleUnownedUnaligned(Context)) {
    return;
  }
  if (ClaimHostFault && !Alignment && ClaimHostFault(Info, Context)) {
    return;
  }
  const auto& Next = DelegatorActions[Signal == SIGBUS ? 0 : 1];
  if (Next.sa_flags & SA_SIGINFO) {
    Next.sa_sigaction(Signal, Info, Context);
  } else if (Next.sa_handler != SIG_DFL && Next.sa_handler != SIG_IGN) {
    Next.sa_handler(Signal);
  } else {
    signal(Signal, SIG_DFL);
  }
}
inline void InstallCallRetGuard() {
  for (int Index = 0; Index < 2; ++Index) {
    const int Signal = Index == 0 ? SIGBUS : SIGSEGV;
    sigaction(Signal, nullptr, &DelegatorActions[Index]);
    struct sigaction Action {};
    Action.sa_sigaction = CallRetGuard;
    Action.sa_flags = SA_SIGINFO | SA_ONSTACK;
    sigaction(Signal, &Action, nullptr);
  }
}

// The delegator's handlers run on an alternate signal stack (SA_ONSTACK); each OS thread that runs a guest gets one.
inline void InstallSignalStack() {
  constexpr std::size_t Size = 256 << 10;
  stack_t Stack {};
  Stack.ss_sp = mmap(nullptr, Size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  Stack.ss_size = Size;
  if (Stack.ss_sp != MAP_FAILED) {
    sigaltstack(&Stack, nullptr);
  }
}

// Asynchronous guest exceptions (libkernel's sceKernelRaiseException, which Unity's garbage collector uses to stop
// threads). The raising thread sets the target's PendingException and sends it ExceptionSignal until the target takes
// the exception. The target takes it
// - in translated code: as the Darwin signal delegator does for a guest fault, the guest state is spilled from the
//   host registers (the rip from the block's RIP entries), the handler is entered through the dispatcher with the
//   exception context below the stack's red zone and ExceptionReturn as its return address, and that HLT restores the
//   state, with the handler's edits to the context's general registers, rip and rflags;
// - in a thunk blocked in a wait system call: the handler runs there, nested like a callback, with the thunk's guest
//   state (its return address as rip).
// Anywhere else (FEX's dispatcher or compiler, a FEX section that defers signals, host code between system calls,
// the first instruction of a block) the target leaves the signal and the raiser sends it again.
struct PendingException {
  std::atomic<std::uint64_t> Handler {0};
  int Signal = 0;
};
constexpr int ExceptionSignal = SIGUSR1;
// This OS thread's record, set by the thread layer before its guest runs.
inline thread_local PendingException* ThreadException = nullptr;
// Set by the thread layer: writes the guest's exception context for State (with rip Rip and rflags Eflags) below
// Below, 64-byte aligned, and returns its address; reads the general registers, rip and rflags back from it.
inline std::uint64_t (*WriteExceptionContext)(const CPUState& State, std::uint64_t Rip, std::uint32_t Eflags, std::uint64_t Below) = nullptr;
inline void (*ReadExceptionContext)(std::uint64_t Context, CPUState& State, std::uint32_t& Eflags) = nullptr;
inline FEXCore::Darwin::SignalDelegator* Delegator = nullptr;

// The state a handler entered from translated code returns to.
struct InterruptedState {
  std::uint64_t Gregs[16];
  std::uint64_t Rip, CallRetSp, Context;
  std::uint32_t Eflags, Mxcsr;
  std::uint64_t AvxHigh[16][2];
  decltype(CPUState::xmm) Xmm;
  std::uint64_t Mm[8][2];
};
inline thread_local InterruptedState Interrupted;
inline thread_local int InterruptDepth = 0;
inline thread_local bool InNestedHandler = false;

// The host register file a translated block keeps the guest's general and vector registers in (Darwin signal
// delegator, Spill).
inline void SpillTranslated(FEXCore::Core::InternalThreadState* Bound, std::remove_pointer_t<mcontext_t>& Machine) {
  const auto& Config = Delegator->GetConfig();
  auto& State = Bound->CurrentFrame->State;
  std::uint64_t GPRs[32];
  for (unsigned Index = 0; Index != 29; ++Index) {
    GPRs[Index] = Machine.__ss.__x[Index];
  }
  GPRs[29] = __darwin_arm_thread_state64_get_fp(Machine.__ss);
  GPRs[30] = __darwin_arm_thread_state64_get_lr(Machine.__ss);
  GPRs[31] = __darwin_arm_thread_state64_get_sp(Machine.__ss);
  State.rip = CTX->RestoreRIPFromHostPC(Bound, __darwin_arm_thread_state64_get_pc(Machine.__ss));
  const std::uint32_t Ignore = Bound->CurrentFrame->InSyscallInfo & 0xffff;
  for (std::size_t Index = 0; Index < Config.SRAGPRCount; ++Index) {
    const auto Host = Config.SRAGPRMapping[Index];
    if (!(Ignore & (1U << Host))) {
      State.gregs[Index] = GPRs[Host];
    }
  }
  for (std::size_t Index = 0; Index < Config.SRAFPRCount; ++Index) {
    std::memcpy(&State.xmm.sse.data[Index][0], &Machine.__ns.__v[Config.SRAFPRMapping[Index]], sizeof(__uint128_t));
  }
  State.callret_sp = GPRs[25];
  CTX->SetFlagsFromCompactedEFLAGS(Bound, CTX->ReconstructCompactedEFLAGS(Bound, true, GPRs, Machine.__ss.__cpsr));
}

// Whether PC is inside the block FEX entered last: only there do the block's RIP entries give the guest rip.
inline bool InCurrentBlock(FEXCore::Core::InternalThreadState* Bound, std::uint64_t PC) {
  const std::uint64_t Begin = Bound->CurrentFrame->State.InlineJITBlockHeader;
  if (Begin == 0) {
    return false;
  }
  const std::uint32_t TailOffset = *reinterpret_cast<const std::uint32_t*>(Begin);  // JITCodeHeader::OffsetToBlockTail
  const std::size_t Size = *reinterpret_cast<const std::size_t*>(Begin + TailOffset); // JITCodeTail::Size
  return PC > Begin && PC < Begin + Size;
}

inline void ReportGuestState(void* Context) {
  char Text[320];
  int Length;
  if (!Thread) {
    Length = std::snprintf(Text, sizeof(Text), "  no guest thread on this OS thread\n");
    write(STDOUT_FILENO, Text, Length);
    return;
  }
  const std::uint64_t PC = __darwin_arm_thread_state64_get_pc(static_cast<ucontext_t*>(Context)->uc_mcontext->__ss);
  const bool Translated = CTX->IsAddressInCodeBuffer(Thread, PC);
  const auto* Config = Delegator ? &Delegator->GetConfig() : nullptr;
  const bool Dispatcher = Config && PC >= Config->DispatcherBegin && PC < Config->DispatcherEnd;
  const std::uint64_t Rip = Translated && InCurrentBlock(Thread, PC) ? CTX->RestoreRIPFromHostPC(Thread, PC) : Thread->CurrentFrame->State.rip;
  char Where[96] = "?";
  if (DescribeGuestAddress) {
    DescribeGuestAddress(Rip, Where, sizeof(Where));
  }
  Length = std::snprintf(Text, sizeof(Text),
                         "  guest thread: pc in translated code %d, in the dispatcher %d (0x%llx-0x%llx), in a host call %d, interrupt depth %d, "
                         "bound %d; guest rip 0x%llx (%s)\n",
                         Translated, Dispatcher, Config ? static_cast<unsigned long long>(Config->DispatcherBegin) : 0ULL,
                         Config ? static_cast<unsigned long long>(Config->DispatcherEnd) : 0ULL, InHostCall, InterruptDepth,
                         FEXCore::Darwin::CurrentThread == Thread, static_cast<unsigned long long>(Rip), Where);
  write(STDOUT_FILENO, Text, Length);
}

// Darwin arm64 system calls a blocked thread waits in (x16 at the SVC): reads, polls, kevents, pthread and ulock
// waits, semaphores and sleeps. Nothing else, since a thread in another system call may hold a lock the handler needs
// (the allocator's, while it maps memory).
inline bool BlockedInWait(const std::remove_pointer_t<mcontext_t>& Machine) {
  const std::uint64_t PC = __darwin_arm_thread_state64_get_pc(Machine.__ss);
  constexpr std::uint32_t Svc80 = 0xD4001001;
  if (*reinterpret_cast<const std::uint32_t*>(PC) != Svc80 && *reinterpret_cast<const std::uint32_t*>(PC - 4) != Svc80) {
    return false;
  }
  switch (static_cast<std::int64_t>(Machine.__ss.__x[16])) {
  case 3: case 29: case 93: case 111: case 153: case 230: case 301: case 305: case 306: case 307: case 334: case 363:
  case 369: case 374: case 396: case 403: case 407: case 414: case 417: case 423: case 515: case 544:
  case -36: case -37: case -38: case -39: // semaphore_wait, wait_signal, timedwait, timedwait_signal traps
    return true;
  default:
    return false;
  }
}

// Runs Handler(Signal, context) now, from a thunk (or a wait inside one) of this thread: the context holds the guest
// state of the thunk's caller.
inline void RunExceptionHandlerHere(std::uint64_t Handler, int Signal) {
  auto& Guest = Thread->CurrentFrame->State;
  const std::uint64_t Rsp = Guest.gregs[X86::REG_RSP];
  const std::uint32_t Eflags = CTX->ReconstructCompactedEFLAGS(Thread, false, nullptr, 0);
  const std::uint64_t Context = WriteExceptionContext(Guest, *reinterpret_cast<const std::uint64_t*>(Rsp), Eflags, Rsp - 128);
  // CallGuest puts the handler's frame below the red zone of this stack pointer, so below the context.
  Guest.gregs[X86::REG_RSP] = Context + 128;
  const std::uint64_t Arguments[] = {static_cast<std::uint64_t>(Signal), Context};
  const bool Outer = InNestedHandler;
  InNestedHandler = true;
  CallGuest(Handler, Arguments, {});
  InNestedHandler = Outer;
  Guest.gregs[X86::REG_RSP] = Rsp;
}

inline void TakeException(int, siginfo_t*, void* Opaque) {
  auto* Bound = Thread;
  auto* Record = ThreadException;
  if (!Bound || !Record || !Bound->CurrentFrame || !Delegator || Bound->CurrentFrame->State.DeferredSignalRefCount.Load() != 0) {
    return;
  }
  std::uint64_t Handler = Record->Handler.load(std::memory_order_acquire);
  if (Handler == 0) {
    return;
  }
  const int Error = errno;
  auto& Machine = *static_cast<ucontext_t*>(Opaque)->uc_mcontext;
  const std::uint64_t PC = __darwin_arm_thread_state64_get_pc(Machine.__ss);
  // One exception at a time, as a signal is masked while its handler runs: a raise during a handler waits for its end.
  if (InterruptDepth != 0 || InNestedHandler) {
    return;
  }
  if (!InHostCall && CTX->IsAddressInCodeBuffer(Bound, PC) && InCurrentBlock(Bound, PC)) {
    if (!Record->Handler.compare_exchange_strong(Handler, 0, std::memory_order_acq_rel)) {
      return;
    }
    SpillTranslated(Bound, Machine);
    auto& Guest = Bound->CurrentFrame->State;
    auto& Saved = Interrupted;
    InterruptDepth = 1;
    std::memcpy(Saved.Gregs, Guest.gregs, sizeof(Saved.Gregs));
    Saved.Rip = Guest.rip;
    Saved.CallRetSp = Guest.callret_sp;
    Saved.Eflags = CTX->ReconstructCompactedEFLAGS(Bound, false, nullptr, 0);
    Saved.Mxcsr = Guest.mxcsr;
    std::memcpy(Saved.AvxHigh, Guest.avx_high, sizeof(Saved.AvxHigh));
    std::memcpy(&Saved.Xmm, &Guest.xmm, sizeof(Saved.Xmm));
    std::memcpy(Saved.Mm, Guest.mm, sizeof(Saved.Mm));
    Saved.Context = WriteExceptionContext(Guest, Guest.rip, Saved.Eflags, Guest.gregs[X86::REG_RSP] - 128);
    // The handler's frame: the return address below the context, 16-byte aligned plus 8 at entry.
    const std::uint64_t Frame = Saved.Context - 8;
    *reinterpret_cast<std::uint64_t*>(Frame) = StubBase + ExceptionReturnOffset;
    Guest.gregs[X86::REG_RSP] = Frame;
    Guest.gregs[X86::REG_RDI] = static_cast<std::uint64_t>(Record->Signal);
    Guest.gregs[X86::REG_RSI] = Saved.Context;
    Guest.gregs[X86::REG_RAX] = 0;
    Guest.rip = Handler;
    // Resume at the dispatcher, which fills the host registers from the guest state (Darwin signal delegator,
    // ResumeDispatcher).
    Machine.__ss.__x[28] = reinterpret_cast<std::uintptr_t>(Bound->CurrentFrame);
    Machine.__ss.__x[25] = Guest.callret_sp;
    Machine.__ss.__x[1] = 0;
    Bound->CurrentFrame->InSyscallInfo = 0;
    __darwin_arm_thread_state64_set_pc_fptr(Machine.__ss, reinterpret_cast<void*>(Delegator->GetConfig().AbsoluteLoopTopAddressFillSRA));
  } else if (InHostCall && BlockedInWait(Machine)) {
    if (!Record->Handler.compare_exchange_strong(Handler, 0, std::memory_order_acq_rel)) {
      return;
    }
    RunExceptionHandlerHere(Handler, Record->Signal);
  }
  errno = Error;
}

// The HLT at ExceptionReturn: the handler entered from translated code returned.
inline void FinishTranslatedException(CPUState& Guest) {
  if (InterruptDepth == 0) {
    std::printf("guest returned to the exception return stub with no exception taken\nFAIL\n");
    std::exit(1);
  }
  const auto& Saved = Interrupted;
  InterruptDepth = 0;
  std::memcpy(Guest.gregs, Saved.Gregs, sizeof(Saved.Gregs));
  Guest.rip = Saved.Rip;
  std::uint32_t Eflags = Saved.Eflags;
  ReadExceptionContext(Saved.Context, Guest, Eflags);
  Guest.callret_sp = Saved.CallRetSp;
  Guest.mxcsr = Saved.Mxcsr;
  std::memcpy(Guest.avx_high, Saved.AvxHigh, sizeof(Saved.AvxHigh));
  std::memcpy(&Guest.xmm, &Saved.Xmm, sizeof(Saved.Xmm));
  std::memcpy(Guest.mm, Saved.Mm, sizeof(Saved.Mm));
  CTX->SetFlagsFromCompactedEFLAGS(Thread, Eflags);
}

// Installed once, on the thread's own stack (not the signal stack): a nested handler runs guest code and FEX's
// compiler from here.
inline void InstallExceptionSignal() {
  struct sigaction Action {};
  Action.sa_sigaction = TakeException;
  Action.sa_flags = SA_SIGINFO | SA_RESTART;
  sigemptyset(&Action.sa_mask);
  sigaction(ExceptionSignal, &Action, nullptr);
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

// A host thread's own guest thread (AdoptHostThread): created on its first guest call, bound to the OS thread with
// InHostCall set (the thread runs host code between guest calls), and destroyed when the OS thread exits.
struct AdoptedGuest {
  FEXCore::Darwin::ThreadScope* Scope = nullptr;
  ~AdoptedGuest() {
    if (!Scope) {
      return;
    }
    delete Scope;
    const std::uint64_t PageSize = getpagesize();
    auto* CallRet = static_cast<std::uint8_t*>(Thread->CallRetStackBase) - PageSize;
    CTX->DestroyThread(Thread);
    Thread = nullptr;
    munmap(CallRet, FEXCore::Core::InternalThreadState::CALLRET_STACK_SIZE + 2 * PageSize);
  }
};
inline thread_local AdoptedGuest Adopted;
inline void AdoptCallingThread(std::uint64_t StackTop, std::uint64_t FsBase) {
  CPUState Initial {};
  Initial.rip = StubBase;
  Initial.gregs[X86::REG_RSP] = (StackTop & ~15ULL) - 8;
  Initial.fs_cached = FsBase;
  InstallSignalStack();
  Thread = NewThread(Initial);
  Adopted.Scope = new FEXCore::Darwin::ThreadScope(Thread);
  InHostCall = true;
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
  InstallSignalStack();
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
    InstallCallRetGuard();
    Delegator = &Signals;
    InstallExceptionSignal();
    InstallSignalStack();
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
