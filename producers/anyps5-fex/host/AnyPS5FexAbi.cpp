// SPDX-License-Identifier: GPL-2.0-only
// Per-signature thunk proof: x86-64 guest code (guest-abi.c) runs under FEXCore and calls four arm64 exports through
// slots holding thunk stubs. The exports cover the signature classes a generic register shim gets wrong: a struct over
// 16 bytes returned through a hidden pointer in rdi with 10 integer arguments (5 on the guest stack), long double in and
// out, 10 double arguments (2 on the guest stack), a 16-byte INTEGER+SSE struct return, and a guest function pointer
// that the export calls back twice. Each result the guest stores must equal the result of calling the export directly
// (with the callback computed on the host).
//
// Usage: anyps5-fex-abi <guest-abi.bin> <entry offset> <callback offset> thunks|generic
//   thunks:  SysVThunk<Export> per export.
//   generic: the generic shim (GenericBridge.S); expected to fail.
#include "SysVThunk.h"

#include <array>
#include <cinttypes>
#include <cstddef>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <vector>

struct Big {
  long long a, b, c, d;
};
struct Pair {
  long long tag;
  double value;
};
template<>
struct SysV::SysVEightbytes<Pair> {
  static constexpr char Classes[2] = {'I', 'S'};
};

// arm64 exports with the signature classes under test.
extern "C" {
Big AbiMakeBig(long long a1, long long a2, long long a3, long long a4, long long a5, long long a6, long long a7, long long a8,
               long long a9, long long a10) {
  return {a1 * 1000 + a2 * 100 + a3 * 10 + a4, a5 * 1000 + a6 * 100 + a7 * 10 + a8, a9 * 10 + a10,
          a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8 + a9 + a10};
}
long double AbiScale(long double x, int n) {
  return x * n + 0.25L;
}
double AbiWeigh(double d1, double d2, double d3, double d4, double d5, double d6, double d7, double d8, double d9, double d10) {
  return d1 * 1 + d2 * 2 + d3 * 3 + d4 * 4 + d5 * 5 + d6 * 6 + d7 * 7 + d8 * 8 + d9 * 9 + d10 * 10;
}
Pair AbiPair(long long tag, double value) {
  return {tag * 3, value * 4};
}
int AbiApply(int (*Callback)(int, int), int a, int b) {
  return Callback(a, b) + Callback(b, a);
}
}
int HostCallback(int a, int b) {
  return a * 10 + b;
}

// The guest structures with their x86-64 layout (long double is 16 bytes, 16-byte aligned).
struct GuestSlots {
  std::uint64_t MakeBig, Scale, Weigh, Pair, Apply;
};
struct GuestInputs {
  long long i[10];
  double d[10];
  alignas(16) std::uint8_t x[16];
  int n;
  long long tag;
  double value;
  std::uint64_t callback;
};
static_assert(offsetof(GuestInputs, x) == 160 && offsetof(GuestInputs, n) == 176 && offsetof(GuestInputs, tag) == 184 &&
              offsetof(GuestInputs, value) == 192 && offsetof(GuestInputs, callback) == 200 && sizeof(GuestInputs) == 208);
struct GuestResults {
  Big big;
  alignas(16) std::uint8_t scaled[16];
  double weighed;
  Pair pair;
  int applied;
};
static_assert(offsetof(GuestResults, scaled) == 32 && offsetof(GuestResults, weighed) == 48 && offsetof(GuestResults, pair) == 56 &&
              offsetof(GuestResults, applied) == 72 && sizeof(GuestResults) == 80);

struct BridgeRegisters {
  std::uint64_t X[8];
  double D[8];
  std::uint64_t OutX[2];
  double OutD[2];
};
static_assert(offsetof(BridgeRegisters, D) == 64 && offsetof(BridgeRegisters, OutX) == 128 && offsetof(BridgeRegisters, OutD) == 144);
extern "C" void GenericBridge(BridgeRegisters* Registers, const void* Export, void* Scratch);

template<auto Export>
SysV::After GenericThunk(FexGuest::CPUState& State) {
  namespace X86 = FexGuest::X86;
  BridgeRegisters Registers {};
  const int Order[] = {X86::REG_RDI, X86::REG_RSI, X86::REG_RDX, X86::REG_RCX, X86::REG_R8, X86::REG_R9};
  for (int i = 0; i < 6; ++i) {
    Registers.X[i] = State.gregs[Order[i]];
  }
  const auto* Stack = reinterpret_cast<const std::uint64_t*>(State.gregs[X86::REG_RSP] + 8);
  Registers.X[6] = Stack[0];
  Registers.X[7] = Stack[1];
  for (int i = 0; i < 8; ++i) {
    std::memcpy(&Registers.D[i], &State.xmm.sse.data[i][0], 8);
  }
  alignas(16) std::uint8_t Scratch[256] {};
  GenericBridge(&Registers, reinterpret_cast<const void*>(Export), Scratch);
  State.gregs[X86::REG_RAX] = Registers.OutX[0];
  State.gregs[X86::REG_RDX] = Registers.OutX[1];
  std::memcpy(&State.xmm.sse.data[0][0], &Registers.OutD[0], 8);
  std::memcpy(&State.xmm.sse.data[1][0], &Registers.OutD[1], 8);
  return SysV::After::Return;
}

namespace {
constexpr std::array<FexGuest::Thunk, 5> PerSignature {SysV::ThunkFor<&AbiMakeBig>(), SysV::ThunkFor<&AbiScale>(), SysV::ThunkFor<&AbiWeigh>(),
                                                       SysV::ThunkFor<&AbiPair>(), SysV::ThunkFor<&AbiApply>()};
constexpr std::array<FexGuest::Thunk, 5> Generic {GenericThunk<&AbiMakeBig>, GenericThunk<&AbiScale>, GenericThunk<&AbiWeigh>,
                                                  GenericThunk<&AbiPair>, GenericThunk<&AbiApply>};

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
} // namespace

int main(int argc, char** argv) {
  if (argc != 5 || (std::string(argv[4]) != "thunks" && std::string(argv[4]) != "generic")) {
    std::fprintf(stderr, "usage: %s <guest-abi.bin> <entry offset> <callback offset> thunks|generic\n", argv[0]);
    return 2;
  }
  FexGuest::InstallFaultReport();
  FexGuest::InitConfig();
  const bool PerSignatureThunks = std::string(argv[4]) == "thunks";
  const auto& Thunks = PerSignatureThunks ? PerSignature : Generic;

  const auto Code = ReadFile(argv[1]);
  auto* CodePage = static_cast<std::uint8_t*>(FexGuest::MapGuest((Code.size() + 0x3fff) & ~0x3fffULL));
  std::memcpy(CodePage, Code.data(), Code.size());
  FexGuest::MapStubs(Thunks.size());

  auto* Data = static_cast<std::uint8_t*>(FexGuest::MapGuest(0x4000));
  auto* Slots = reinterpret_cast<GuestSlots*>(Data);
  auto* Inputs = reinterpret_cast<GuestInputs*>(Data + 0x100);
  auto* Results = reinterpret_cast<GuestResults*>(Data + 0x200);
  std::uint64_t* SlotArray = &Slots->MakeBig;
  for (std::size_t i = 0; i < Thunks.size(); ++i) {
    SlotArray[i] = FexGuest::StubBase + FexGuest::ThunkStubOffset + i * FexGuest::ThunkStubSize;
  }
  for (int i = 0; i < 10; ++i) {
    Inputs->i[i] = i + 1;
    Inputs->d[i] = i + 1.5;
  }
  const double X = 1.5;
  SysV::DoubleToX87(X, Inputs->x);
  Inputs->n = 3;
  Inputs->tag = 42;
  Inputs->value = 2.5;
  Inputs->callback = reinterpret_cast<std::uint64_t>(CodePage) + std::strtoull(argv[3], nullptr, 0);

  FexGuest::CPUState Initial {};
  Initial.rip = reinterpret_cast<std::uint64_t>(CodePage) + std::strtoull(argv[2], nullptr, 0);
  Initial.gregs[FexGuest::X86::REG_RSP] = FexGuest::MapStack();
  Initial.gregs[FexGuest::X86::REG_RDI] = reinterpret_cast<std::uint64_t>(Slots);
  Initial.gregs[FexGuest::X86::REG_RSI] = reinterpret_cast<std::uint64_t>(Inputs);
  Initial.gregs[FexGuest::X86::REG_RDX] = reinterpret_cast<std::uint64_t>(Results);
  std::uint64_t ThunkCalls = 0;
  FexGuest::Run(Initial, Thunks, ThunkCalls);

  const Big WantBig = AbiMakeBig(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
  const double WantScaled = AbiScale(X, 3);
  const double WantWeighed = AbiWeigh(1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5);
  const Pair WantPair = AbiPair(42, 2.5);
  const int WantApplied = AbiApply(HostCallback, 3, 4);
  const double GotScaled = SysV::X87ToDouble(Results->scaled);

  const bool BigOk = std::memcmp(&Results->big, &WantBig, sizeof(Big)) == 0;
  const bool ScaledOk = GotScaled == WantScaled;
  const bool WeighedOk = Results->weighed == WantWeighed;
  const bool PairOk = Results->pair.tag == WantPair.tag && Results->pair.value == WantPair.value;
  const bool AppliedOk = Results->applied == WantApplied;
  std::printf("%s thunks, %" PRIu64 " calls\n", PerSignatureThunks ? "per-signature" : "generic", ThunkCalls);
  std::printf("struct over 16 bytes, 10 integer arguments: got {%lld, %lld, %lld, %lld}, want {%lld, %lld, %lld, %lld} %s\n",
              Results->big.a, Results->big.b, Results->big.c, Results->big.d, WantBig.a, WantBig.b, WantBig.c, WantBig.d,
              BigOk ? "ok" : "WRONG");
  std::printf("long double in and out: got %.17g, want %.17g %s\n", GotScaled, WantScaled, ScaledOk ? "ok" : "WRONG");
  std::printf("10 double arguments: got %.17g, want %.17g %s\n", Results->weighed, WantWeighed, WeighedOk ? "ok" : "WRONG");
  std::printf("INTEGER+SSE struct return: got {%lld, %.17g}, want {%lld, %.17g} %s\n", Results->pair.tag, Results->pair.value, WantPair.tag,
              WantPair.value, PairOk ? "ok" : "WRONG");
  std::printf("guest callback called twice by the export: got %d, want %d %s\n", Results->applied, WantApplied, AppliedOk ? "ok" : "WRONG");
  const bool Pass = ThunkCalls == 5 && BigOk && ScaledOk && WeighedOk && PairOk && AppliedOk;
  std::printf("%s\n", Pass ? "PASS" : "FAIL");
  return Pass ? 0 : 1;
}
