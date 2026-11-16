// SPDX-License-Identifier: GPL-2.0-only
// Runs one function of a real PS5 x86-64 module under FEXCore in an arm64 process. The module's import slot for
// one library export points to a guest thunk stub. The stub is a HLT, which returns from FEXCore to this host; the
// host calls the arm64 build of that export with the guest's argument registers, puts the result in RAX, performs
// the guest's RET and resumes the guest.
//
// Usage: anyps5-fex-proof <eboot.elf> <function vaddr> <GOT slot vaddr> <bss vaddr> bound|unbound
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
#include <fcntl.h>
#include <signal.h>
#include <string>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <vector>

// AnyPS5 libkernel (core/libs/prx/libkernel/Time/Time.cpp) built for arm64.
extern "C" std::uint64_t sceKernelGetProcessTime();

namespace {
// The module is position independent; the kernel picks where it and the stubs go.
std::uint64_t GuestBase = 0;
std::uint64_t StubBase = 0;
constexpr std::uint64_t StackSize = 1 << 20;
constexpr std::uint64_t ThunkStubOffset = 16;
constexpr std::uint64_t ThunkStubSize = 16;

using ThunkFunction = void (*)(FEXCore::Core::CpuStateFrame* Frame);

// x86-64 SysV to arm64 for `uint64_t f(void)`: no arguments, result in RAX.
void ThunkGetProcessTime(FEXCore::Core::CpuStateFrame* Frame) {
  Frame->State.gregs[FEXCore::X86State::REG_RAX] = sceKernelGetProcessTime();
}

const ThunkFunction Thunks[] = {ThunkGetProcessTime};
std::uint64_t ThunkCalls = 0;

// PS5 game code reaches the system only through library imports; a SYSCALL instruction ends the run.
class ProofSyscallHandler final : public FEXCore::HLE::SyscallHandler {
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

class ProofSignalDelegator final : public FEXCore::SignalDelegator {};

bool Sysctl(const char* Name) {
  int Value = 0;
  size_t Size = sizeof(Value);
  return sysctlbyname(Name, &Value, &Size, nullptr, 0) == 0 && Value != 0;
}

// FEX's Linux frontend reads the ID registers, which macOS does not expose to user space; the same facts come
// from sysctl here.
FEXCore::HostFeatures DarwinHostFeatures() {
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

void* MapGuest(std::uint64_t Size) {
  void* Result = mmap(nullptr, Size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (Result == MAP_FAILED) {
    std::perror("mmap");
    std::exit(2);
  }
  return Result;
}

std::vector<std::uint8_t> ReadFile(const char* Path) {
  std::vector<std::uint8_t> Data;
  int FD = open(Path, O_RDONLY);
  struct stat Stat {};
  if (FD < 0 || fstat(FD, &Stat) != 0) {
    std::perror(Path);
    std::exit(2);
  }
  Data.resize(Stat.st_size);
  if (read(FD, Data.data(), Data.size()) != static_cast<ssize_t>(Data.size())) {
    std::perror(Path);
    std::exit(2);
  }
  close(FD);
  return Data;
}

// Maps every PT_LOAD of a PS5 ELF at GuestBase plus its virtual address, zero-filling past the file size.
void MapModule(const std::vector<std::uint8_t>& Elf) {
  auto U16 = [&](size_t O) { std::uint16_t V; std::memcpy(&V, &Elf[O], 2); return V; };
  auto U32 = [&](size_t O) { std::uint32_t V; std::memcpy(&V, &Elf[O], 4); return V; };
  auto U64 = [&](size_t O) { std::uint64_t V; std::memcpy(&V, &Elf[O], 8); return V; };
  if (std::memcmp(Elf.data(), "\x7f" "ELF", 4) != 0 || U16(18) != 62) {
    std::fprintf(stderr, "not an x86-64 ELF\n");
    std::exit(2);
  }
  const std::uint64_t PhOff = U64(32), PhEntSize = U16(54), PhNum = U16(56);
  std::uint64_t End = 0;
  for (unsigned i = 0; i < PhNum; ++i) {
    const auto O = PhOff + i * PhEntSize;
    if (U32(O) == 1) End = std::max(End, U64(O + 16) + U64(O + 40));
  }
  const std::uint64_t PageSize = getpagesize();
  GuestBase = reinterpret_cast<std::uint64_t>(MapGuest((End + PageSize - 1) & ~(PageSize - 1)));
  for (unsigned i = 0; i < PhNum; ++i) {
    const auto O = PhOff + i * PhEntSize;
    if (U32(O) != 1) continue;
    std::memcpy(reinterpret_cast<void*>(GuestBase + U64(O + 16)), &Elf[U64(O + 8)], U64(O + 32));
  }
}
} // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    std::fprintf(stderr, "usage: %s <eboot.elf> <function vaddr> <GOT slot vaddr> <bss vaddr> bound|unbound\n", argv[0]);
    return 2;
  }
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  // Without a binding the guest jumps through an empty import slot. The host has no guest fault handling yet, so a
  // fault ends the run with its signal number instead of a crash report.
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
  const std::uint64_t Function = std::strtoull(argv[2], nullptr, 0);
  const std::uint64_t Slot = std::strtoull(argv[3], nullptr, 0);
  const std::uint64_t BaseTimeVariable = std::strtoull(argv[4], nullptr, 0);
  const bool Bound = std::string(argv[5]) == "bound";

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

  MapModule(ReadFile(argv[1]));

  // Guest stubs, each a HLT: offset 0 is the final return to the host, offset 16 + 16 * i is thunk i.
  auto* Stubs = static_cast<std::uint8_t*>(MapGuest(0x4000));
  StubBase = reinterpret_cast<std::uint64_t>(Stubs);
  Stubs[0] = 0xF4;
  for (size_t i = 0; i < std::size(Thunks); ++i) {
    Stubs[ThunkStubOffset + i * ThunkStubSize] = 0xF4;
  }
  if (Bound) {
    *reinterpret_cast<std::uint64_t*>(GuestBase + Slot) = StubBase + ThunkStubOffset;
  }
  std::printf("module at 0x%llx; import slot 0x%llx -> 0x%llx (%s)\n", static_cast<unsigned long long>(GuestBase), static_cast<unsigned long long>(Slot),
              static_cast<unsigned long long>(*reinterpret_cast<std::uint64_t*>(GuestBase + Slot)), Bound ? "bound" : "unbound");

  // The function returns (now - base) * 35 / 1000000, DOOM's 35 Hz tic count, for its base-time variable. The export
  // counts microseconds from process start; half a second in, a base of 1 gives about 17 tics.
  usleep(500000);
  const std::uint64_t BaseTime = 1;
  *reinterpret_cast<std::uint64_t*>(GuestBase + BaseTimeVariable) = BaseTime;
  const std::uint64_t Before = sceKernelGetProcessTime();

  auto Stack = reinterpret_cast<std::uint64_t>(MapGuest(StackSize)) + StackSize - 16;
  Stack -= 8;
  *reinterpret_cast<std::uint64_t*>(Stack) = StubBase; // return address: HLT

  auto CTX = FEXCore::Context::Context::CreateNewContext(DarwinHostFeatures());
  ProofSignalDelegator SignalDelegation;
  ProofSyscallHandler SyscallHandler;
  CTX->SetSignalDelegator(&SignalDelegation);
  CTX->SetSyscallHandler(&SyscallHandler);
  CTX->EnableExitOnHLT();
  if (!CTX->InitCore()) {
    std::fprintf(stderr, "InitCore failed\n");
    return 1;
  }
  std::printf("FEXCore initialized\n");

  FEXCore::Core::CPUState State {};
  State.rip = GuestBase + Function;
  State.gregs[FEXCore::X86State::REG_RSP] = Stack;
  State.mxcsr = 0x1F80;
  auto* Thread = CTX->CreateThread(&State);
  auto& Guest = Thread->CurrentFrame->State;

  // A flat 64-bit code segment, as FEX's Linux frontend sets up for a new thread.
  static FEXCore::Core::CPUState::gdt_segment GDT[32] {};
  Guest.segment_arrays[FEXCore::Core::CPUState::SEGMENT_ARRAY_INDEX_GDT] = GDT;
  Guest.segment_arrays[FEXCore::Core::CPUState::SEGMENT_ARRAY_INDEX_LDT] = GDT;
  Guest.cs_idx = FEXCore::Core::CPUState::DEFAULT_USER_CS << 3;
  auto* CodeSegment = FEXCore::Core::CPUState::GetSegmentFromIndex(Guest, Guest.cs_idx);
  FEXCore::Core::CPUState::SetGDTBase(CodeSegment, 0);
  FEXCore::Core::CPUState::SetGDTLimit(CodeSegment, 0xF'FFFFU);
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
  for (;;) {
    CTX->ExecuteThread(Thread);
    const std::uint64_t Stop = Guest.rip - StubBase;
    if (Stop == 0) {
      break;
    }
    if (Guest.rip < StubBase || Stop < ThunkStubOffset || (Stop - ThunkStubOffset) % ThunkStubSize != 0 ||
        (Stop - ThunkStubOffset) / ThunkStubSize >= std::size(Thunks)) {
      std::printf("guest stopped at 0x%llx outside the thunk stubs\nFAIL\n", static_cast<unsigned long long>(Guest.rip));
      return 1;
    }
    ++ThunkCalls;
    Thunks[(Stop - ThunkStubOffset) / ThunkStubSize](Thread->CurrentFrame);
    // The guest's RET from the import call.
    auto& RSP = Guest.gregs[FEXCore::X86State::REG_RSP];
    Guest.rip = *reinterpret_cast<std::uint64_t*>(RSP);
    RSP += 8;
  }

  const std::uint64_t After = sceKernelGetProcessTime();
  const std::uint64_t Result = Thread->CurrentFrame->State.gregs[FEXCore::X86State::REG_RAX];
  const std::uint64_t Low = (Before - BaseTime) * 35 / 1000000, High = (After - BaseTime) * 35 / 1000000;
  std::printf("arm64 sceKernelGetProcessTime() before %llu us, after %llu us\n", static_cast<unsigned long long>(Before),
              static_cast<unsigned long long>(After));
  std::printf("guest function 0x%llx returned %llu; thunk calls %llu; expected %llu..%llu from the arm64 export\n",
              static_cast<unsigned long long>(Function), static_cast<unsigned long long>(Result),
              static_cast<unsigned long long>(ThunkCalls), static_cast<unsigned long long>(Low), static_cast<unsigned long long>(High));
  const bool Pass = ThunkCalls == 1 && Low > 0 && Result >= Low && Result <= High;
  std::printf("%s\n", Pass ? "PASS" : "FAIL");
  return Pass ? 0 : 1;
}
