// SPDX-License-Identifier: GPL-2.0-only
// Runs one function of a real PS5 x86-64 module under FEXCore in an arm64 process. The module's import slot for
// one library export points to a guest thunk stub. The stub is a HLT, which returns from FEXCore to this host; the
// per-signature thunk (SysVThunk.h) calls the arm64 build of that export, puts the result in RAX, and the host performs
// the guest's RET and resumes the guest.
//
// Usage: anyps5-fex-proof <eboot.elf> <function vaddr> <GOT slot vaddr> <bss vaddr> bound|unbound
#include "GuestCpuHost.h"
#include "SysVThunk.h"

#include <array>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <vector>

// AnyPS5 libkernel (core/libs/prx/libkernel/Time/Time.cpp) built for arm64.
extern "C" std::uint64_t sceKernelGetProcessTime();

namespace {
// The module is position independent; the kernel picks where it goes.
std::uint64_t GuestBase = 0;
constexpr std::array<FexGuest::Thunk, 1> Thunks {SysV::Thunk<&sceKernelGetProcessTime>};

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
  GuestBase = reinterpret_cast<std::uint64_t>(FexGuest::MapGuest((End + PageSize - 1) & ~(PageSize - 1)));
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
  // Without a binding the guest jumps through an empty import slot and faults.
  FexGuest::InstallFaultReport();
  FexGuest::InstallGuestCpuHost();
  const std::uint64_t Function = std::strtoull(argv[2], nullptr, 0);
  const std::uint64_t Slot = std::strtoull(argv[3], nullptr, 0);
  const std::uint64_t BaseTimeVariable = std::strtoull(argv[4], nullptr, 0);
  const bool Bound = std::string(argv[5]) == "bound";

  FexGuest::InitConfig();

  MapModule(ReadFile(argv[1]));

  FexGuest::MapStubs(Thunks.size());
  if (Bound) {
    *reinterpret_cast<std::uint64_t*>(GuestBase + Slot) = FexGuest::StubBase + FexGuest::ThunkStubOffset;
  }
  std::printf("module at 0x%llx; import slot 0x%llx -> 0x%llx (%s)\n", static_cast<unsigned long long>(GuestBase), static_cast<unsigned long long>(Slot),
              static_cast<unsigned long long>(*reinterpret_cast<std::uint64_t*>(GuestBase + Slot)), Bound ? "bound" : "unbound");

  // The function returns (now - base) * 35 / 1000000, a 35 Hz tic count, for its base-time variable. The export
  // counts microseconds from process start; half a second in, a base of 1 gives about 17 tics.
  usleep(500000);
  const std::uint64_t BaseTime = 1;
  *reinterpret_cast<std::uint64_t*>(GuestBase + BaseTimeVariable) = BaseTime;
  const std::uint64_t Before = sceKernelGetProcessTime();

  FexGuest::CPUState Initial {};
  Initial.rip = GuestBase + Function;
  Initial.gregs[FexGuest::X86::REG_RSP] = FexGuest::MapStack();
  std::uint64_t ThunkCalls = 0;
  const auto& Final = FexGuest::Run(Initial, Thunks, ThunkCalls);

  const std::uint64_t After = sceKernelGetProcessTime();
  const std::uint64_t Result = Final.gregs[FexGuest::X86::REG_RAX];
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
