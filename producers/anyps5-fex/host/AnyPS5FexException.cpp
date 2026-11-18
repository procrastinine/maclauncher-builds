// SPDX-License-Identifier: GPL-2.0-only
// Guest exception delivery check: x86-64 guest code (guest_spin in guest-abi.c) runs long chains of dependent integer
// operations between backward branches under FEXCore, while a host thread raises asynchronous guest exceptions on it
// as libkernel's sceKernelRaiseException does (FexGuest's PendingException and ExceptionSignal). The guest handler
// (guest_on_exception) overwrites every caller-saved register. The guest's result must equal the same computation on
// the host, and every raised exception must have been taken.
//
// Usage: anyps5-fex-exception <guest-abi.bin> <spin offset> <handler offset> checks|anywhere
//   checks:   the host's delivery (FexGuest::TakeException): the exception is taken at FEXCore's interrupt checks.
//   anywhere: the exception is taken wherever in the block's translated code the signal lands, with the guest state
//             spilled from the host registers there; expected to fail, since FEXCore's per-block register cache
//             writes guest registers back to their host registers only at branches.
#include "FexGuest.h"

#include <atomic>
#include <chrono>
#include <cinttypes>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <vector>

namespace {
constexpr std::uint64_t Iterations = 40'000'000;
constexpr std::uint64_t Seed = 0x0123456789abcdefULL;
constexpr std::uint64_t MinimumTaken = 500;

// The guest computation, compiled for the host.
std::uint64_t Spin(std::uint64_t Count, std::uint64_t Start) {
  std::uint64_t a = Start, b = Start * 3 + 1, c = Start ^ 0x9e3779b97f4a7c15ULL, d = 7, e = 11, f = 13;
  for (std::uint64_t i = 0; i < Count; ++i) {
    a = a * 6364136223846793005ULL + b;
    b ^= a >> 13;
    c += b * 31;
    d = (d ^ c) + (a >> 7);
    e += d ^ (c << 5);
    f = (f + e) * 2862933555777941757ULL;
    a ^= f >> 17;
    b += e ^ (d >> 3);
    c ^= a + f;
    d += b >> 9;
    e ^= c * 5;
    f -= d ^ a;
  }
  return a ^ b ^ c ^ d ^ e ^ f;
}

// The guest's exception context: its general registers, rip and rflags, 64-byte aligned below Below.
struct Context {
  std::uint64_t Gregs[16];
  std::uint64_t Rip;
  std::uint64_t Eflags;
};
std::uint64_t WriteContext(const FexGuest::CPUState& State, std::uint64_t Rip, std::uint32_t Eflags, std::uint64_t Below) {
  auto* Written = reinterpret_cast<Context*>((Below - sizeof(Context)) & ~63ULL);
  std::memcpy(Written->Gregs, State.gregs, sizeof(Written->Gregs));
  Written->Rip = Rip;
  Written->Eflags = Eflags;
  return reinterpret_cast<std::uint64_t>(Written);
}
void ReadContext(std::uint64_t Address, FexGuest::CPUState& State, std::uint32_t& Eflags) {
  const auto* Read = reinterpret_cast<const Context*>(Address);
  std::memcpy(State.gregs, Read->Gregs, sizeof(Read->Gregs));
  State.rip = Read->Rip;
  Eflags = static_cast<std::uint32_t>(Read->Eflags);
}

FexGuest::PendingException Record;

// The anywhere mode's signal handler: the exception is entered at the signal's host pc in the current block.
void TakeAnywhere(int, siginfo_t*, void* Opaque) {
  auto* Bound = FexGuest::Thread;
  auto& Machine = *static_cast<ucontext_t*>(Opaque)->uc_mcontext;
  const std::uint64_t PC = __darwin_arm_thread_state64_get_pc(Machine.__ss);
  if (!Bound || FexGuest::InHostCall || FexGuest::InterruptDepth != 0 || Bound->CurrentFrame->State.DeferredSignalRefCount.Load() != 0 ||
      !FexGuest::CTX->IsAddressInCodeBuffer(Bound, PC) || !FexGuest::InCurrentBlock(Bound, PC)) {
    return;
  }
  std::uint64_t Handler = Record.Handler.load(std::memory_order_acquire);
  if (Handler != 0 && Record.Handler.compare_exchange_strong(Handler, 0, std::memory_order_acq_rel)) {
    FexGuest::EnterHandlerAtCheck(Bound, Machine, Record, Handler);
  }
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
} // namespace

int main(int argc, char** argv) {
  if (argc != 5 || (std::string(argv[4]) != "checks" && std::string(argv[4]) != "anywhere")) {
    std::fprintf(stderr, "usage: %s <guest-abi.bin> <spin offset> <handler offset> checks|anywhere\n", argv[0]);
    return 2;
  }
  FexGuest::InstallFaultReport();
  FexGuest::InitConfig();
  const bool Anywhere = std::string(argv[4]) == "anywhere";

  const auto Code = ReadFile(argv[1]);
  auto* CodePage = static_cast<std::uint8_t*>(FexGuest::MapGuest((Code.size() + 0x3fff) & ~0x3fffULL));
  std::memcpy(CodePage, Code.data(), Code.size());
  FexGuest::MapStubs(0);
  FexGuest::WriteExceptionContext = WriteContext;
  FexGuest::ReadExceptionContext = ReadContext;
  FexGuest::ThreadException = &Record;
  Record.Signal = 30;
  const std::uint64_t Handler = reinterpret_cast<std::uint64_t>(CodePage) + std::strtoull(argv[3], nullptr, 0);

  // The raiser: once the guest runs, one exception at a time, signalled every 20 microseconds until taken.
  std::atomic<bool> Done {false};
  std::atomic<std::uint64_t> Raised {0}, Taken {0}, Abandoned {0};
  const pthread_t Guest = pthread_self();
  std::thread Raiser([&] {
    while (!FexGuest::CTX && !Done.load()) {
      std::this_thread::sleep_for(std::chrono::microseconds(100));
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    if (Anywhere) {
      struct sigaction Action {};
      Action.sa_sigaction = TakeAnywhere;
      Action.sa_flags = SA_SIGINFO | SA_RESTART;
      sigemptyset(&Action.sa_mask);
      sigaction(FexGuest::ExceptionSignal, &Action, nullptr);
    }
    while (!Done.load()) {
      Raised.fetch_add(1);
      Record.Handler.store(Handler, std::memory_order_release);
      const auto Deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
      while (Record.Handler.load(std::memory_order_acquire) != 0 && !Done.load() && std::chrono::steady_clock::now() < Deadline) {
        pthread_kill(Guest, FexGuest::ExceptionSignal);
        std::this_thread::sleep_for(std::chrono::microseconds(20));
      }
      std::uint64_t Pending = Handler;
      if (Record.Handler.compare_exchange_strong(Pending, 0)) {
        Abandoned.fetch_add(Done.load() ? 0 : 1);
      } else {
        Taken.fetch_add(1);
      }
      std::this_thread::sleep_for(std::chrono::microseconds(200));
    }
  });

  FexGuest::CPUState Initial {};
  Initial.rip = reinterpret_cast<std::uint64_t>(CodePage) + std::strtoull(argv[2], nullptr, 0);
  Initial.gregs[FexGuest::X86::REG_RSP] = FexGuest::MapStack();
  Initial.gregs[FexGuest::X86::REG_RDI] = Iterations;
  Initial.gregs[FexGuest::X86::REG_RSI] = Seed;
  std::uint64_t ThunkCalls = 0;
  const std::uint64_t Got = FexGuest::Run(Initial, {}, ThunkCalls).gregs[FexGuest::X86::REG_RAX];
  Done.store(true);
  Raiser.join();

  const std::uint64_t Want = Spin(Iterations, Seed);
  std::printf("%s delivery: %" PRIu64 " exceptions raised, %" PRIu64 " taken, %" PRIu64 " not taken within 2 s; %" PRIu64
              " taken at interrupt checks\n",
              Anywhere ? "anywhere" : "interrupt-check", Raised.load(), Taken.load(), Abandoned.load(),
              FexGuest::ExceptionsAtChecks.load());
  std::printf("guest result 0x%016" PRIx64 ", host result 0x%016" PRIx64 " %s\n", Got, Want, Got == Want ? "ok" : "WRONG");
  const bool Pass = Got == Want && Taken.load() >= MinimumTaken && Abandoned.load() == 0;
  std::printf("%s\n", Pass ? "PASS" : "FAIL");
  return Pass ? 0 : 1;
}
