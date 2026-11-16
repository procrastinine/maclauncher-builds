// SPDX-License-Identifier: GPL-2.0-only
// SYSCALL entry check: guest code sets rdi, rsi and rdx and calls a stub that sets rax and executes SYSCALL. The
// host's SyscallHandler::HandleSyscall must see those values in the frame, with rcx holding the return RIP. The
// handler writes a result to rax and advances rip past the instruction; the stub returns and the guest stores rax
// and stops at a HLT.
// With a PS5 module, the check also runs one of its functions whose import slot points at the same kind of stub, the
// shape in which RAX was once seen corrupted: DOOM's I_GetTime calls sceKernelGetProcessTime through its GOT, and the
// handler answers with a time from which the function's tic count is known.
//
// Usage: anyps5-fex-syscall [<eboot.elf> <function vaddr> <GOT slot vaddr> <bss vaddr>]
#include "Ps5Module.h"

#include <array>
#include <cinttypes>

namespace {
std::uint64_t Seen[5] {};
std::uint64_t Calls = 0;
std::uint64_t Answer = 0x600DCAFE;

class CheckingHandler final : public FEXCore::HLE::SyscallHandler {
public:
  void HandleSyscall(FEXCore::Core::CpuStateFrame* Frame) override {
    auto& S = Frame->State;
    namespace X86 = FexGuest::X86;
    Seen[0] = S.gregs[X86::REG_RAX];
    Seen[1] = S.gregs[X86::REG_RDI];
    Seen[2] = S.gregs[X86::REG_RSI];
    Seen[3] = S.gregs[X86::REG_RDX];
    Seen[4] = S.gregs[X86::REG_RCX];
    ++Calls;
    S.gregs[X86::REG_RAX] = Answer;
    S.rip += 2;
  }
  FEXCore::HLE::ExecutableRangeInfo QueryGuestExecutableRange(FEXCore::Core::InternalThreadState*, std::uint64_t Address) override {
    return {Address & ~0x3fffULL, 0x4000, false};
  }
  std::optional<FEXCore::ExecutableFileSectionInfo> LookupExecutableFileSection(FEXCore::Core::InternalThreadState*, std::uint64_t) override {
    return std::nullopt;
  }
};
} // namespace

int main(int argc, char** argv) {
  if (argc != 1 && argc != 5) {
    std::fprintf(stderr, "usage: %s [<eboot.elf> <function vaddr> <GOT slot vaddr> <bss vaddr>]\n", argv[0]);
    return 2;
  }
  FexGuest::InstallFaultReport();
  FexGuest::InitConfig();
  FexGuest::MapStubs(0);
  static CheckingHandler Handler;
  FexGuest::SyscallHandlerOverride = &Handler;

  // The import-stub shape: the caller sets the arguments and calls a stub that loads the call number and executes
  // SYSCALL, then returns. Caller at 0: mov edi, 0x11; mov esi, 0x22; mov edx, 0x33; call 0x40; mov [r15], rax; hlt.
  // Stub at 0x40: mov r10, rcx; mov eax, 0x5a000001; syscall; ret.
  const std::uint8_t Caller[] = {0xBF, 0x11, 0x00, 0x00, 0x00, 0xBE, 0x22, 0x00, 0x00, 0x00, 0xBA, 0x33, 0x00, 0x00, 0x00,
                                 0xE8, 0x2C, 0x00, 0x00, 0x00, 0x49, 0x89, 0x07, 0xF4};
  const std::uint8_t Stub[] = {0x49, 0x89, 0xCA, 0xB8, 0x01, 0x00, 0x00, 0x5A, 0x0F, 0x05, 0xC3};
  auto* Page = static_cast<std::uint8_t*>(FexGuest::MapGuest(0x4000));
  std::memcpy(Page, Caller, sizeof(Caller));
  std::memcpy(Page + 0x40, Stub, sizeof(Stub));
  const std::uint64_t SyscallReturn = reinterpret_cast<std::uint64_t>(Page) + 0x40 + 10;
  const std::uint64_t Stop = reinterpret_cast<std::uint64_t>(Page) + sizeof(Caller) - 1;
  auto* Result = static_cast<std::uint64_t*>(FexGuest::MapGuest(0x4000));

  FexGuest::CPUState State {};
  State.rip = reinterpret_cast<std::uint64_t>(Page);
  State.gregs[FexGuest::X86::REG_RSP] = FexGuest::MapStack();
  State.gregs[FexGuest::X86::REG_R15] = reinterpret_cast<std::uint64_t>(Result);
  std::uint64_t ThunkCalls = 0;
  FexGuest::Run(State, std::span<const FexGuest::Thunk> {}, ThunkCalls, Stop);

  std::printf("HandleSyscall saw rax 0x%" PRIx64 " rdi 0x%" PRIx64 " rsi 0x%" PRIx64 " rdx 0x%" PRIx64 " rcx 0x%" PRIx64 "; guest stored 0x%" PRIx64 "\n",
              Seen[0], Seen[1], Seen[2], Seen[3], Seen[4], Result[0]);
  bool Pass = Calls == 1 && Seen[0] == 0x5A000001 && Seen[1] == 0x11 && Seen[2] == 0x22 && Seen[3] == 0x33 && Seen[4] == SyscallReturn &&
              Result[0] == 0x600DCAFE;

  if (argc == 5) {
    auto Module = Ps5::Load(argv[1], "eboot.elf");
    // mov r10, rcx; mov eax, 0x5a000000; syscall; ret
    const std::uint8_t ImportStub[] = {0x49, 0x89, 0xCA, 0xB8, 0x00, 0x00, 0x00, 0x5A, 0x0F, 0x05, 0xC3};
    std::memcpy(Page + 0x100, ImportStub, sizeof(ImportStub));
    *reinterpret_cast<std::uint64_t*>(Module.Base + std::strtoull(argv[3], nullptr, 0)) = reinterpret_cast<std::uint64_t>(Page) + 0x100;
    // The function returns (now - base) * 35 / 1000000; base 1 and now 2000001 microseconds give 70 tics.
    *reinterpret_cast<std::uint64_t*>(Module.Base + std::strtoull(argv[4], nullptr, 0)) = 1;
    Answer = 2000001;
    Calls = 0;
    FexGuest::CPUState Call {};
    Call.rip = Module.Base + std::strtoull(argv[2], nullptr, 0);
    Call.gregs[FexGuest::X86::REG_RSP] = FexGuest::MapStack();
    const auto& Final = FexGuest::Run(Call, std::span<const FexGuest::Thunk> {}, ThunkCalls);
    const std::uint64_t Tics = Final.gregs[FexGuest::X86::REG_RAX];
    std::printf("module function: HandleSyscall saw rax 0x%" PRIx64 "; the function returned %" PRIu64 " tics, want 70\n", Seen[0], Tics);
    Pass = Pass && Calls == 1 && Seen[0] == 0x5A000000 && Tics == 70;
  }
  std::printf("%s\n", Pass ? "PASS" : "FAIL");
  return Pass ? 0 : 1;
}
