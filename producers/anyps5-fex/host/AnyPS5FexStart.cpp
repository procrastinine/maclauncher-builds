// SPDX-License-Identifier: GPL-2.0-only
// Starts a PS5 game under FEXCore in an arm64 process and runs it to its main function. The eboot and its bundled
// sce_module PRX modules are loaded as guest code, imports between them bind by NID, imports of system library
// functions bind to per-signature thunks (SysVThunk.h) of arm64 host functions, and imports that have no host
// function yet bind to a stub that stops the run and names the NID. The PRX modules' DT_INIT functions run first,
// then the eboot entry with the PS5 argument block; a HLT placed at main ends the run there.
//
// Usage: anyps5-fex-start <game directory> <main vaddr> modules|eboot-only
//   eboot-only leaves out the sce_module PRX modules, so their exports stay unbound (expected to stop).
#include "Ps5Module.h"
#include "SysVThunk.h"

#include <dirent.h>
#include <nid/NidCompute.hpp>
#include <string>
#include <unordered_map>
#include <vector>

// AnyPS5 libkernel (core/libs/prx/libkernel/Time/Time.cpp) built for arm64.
extern "C" std::uint64_t sceKernelGetProcessTime();

namespace Kernel {
// The minimum of libkernel that a PS5 libc needs before main, for one guest thread. These are host functions in the
// shared address space, so pointers they return are guest pointers too.
std::uint64_t ProcParam = 0;
std::uint64_t ThreadPointer = 0;
int Errno = 0;
alignas(16) std::uint8_t MainThread[0x400] {};
std::vector<void*> Specific(1);

int Zero() {
  return 0;
}
int* Error() {
  return &Errno;
}
std::uint64_t GetProcParam() {
  return ProcParam;
}
void* TlsGetAddr(const std::uint64_t* Index) {
  const auto* Dtv = reinterpret_cast<const std::uint64_t*>(reinterpret_cast<const std::uint64_t*>(ThreadPointer)[1]);
  return reinterpret_cast<void*>(Dtv[Index[0]] + Index[1]);
}
int MapNamedFlexibleMemory(void** Address, std::uint64_t Length, int, int, const char*) {
  void* Memory = mmap(nullptr, Length, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (Memory == MAP_FAILED) {
    return static_cast<int>(0x8002000c); // SCE_KERNEL_ERROR_ENOMEM
  }
  *Address = Memory;
  return 0;
}
void* PthreadSelf() {
  return MainThread;
}
int KeyCreate(std::uint32_t* Key, void*) {
  *Key = static_cast<std::uint32_t>(Specific.size());
  Specific.push_back(nullptr);
  return 0;
}
void* GetSpecific(std::uint32_t Key) {
  return Key < Specific.size() ? Specific[Key] : nullptr;
}
int SetSpecific(std::uint32_t Key, void* Value) {
  if (Key >= Specific.size()) {
    return static_cast<int>(0x80020016); // SCE_KERNEL_ERROR_EINVAL
  }
  Specific[Key] = Value;
  return 0;
}
long Write(int Descriptor, const void* Buffer, std::uint64_t Length) {
  return write(Descriptor == 1 || Descriptor == 2 ? Descriptor : 2, Buffer, Length);
}
void* Malloc(std::uint64_t Size) {
  return std::malloc(Size);
}
void Free(void* Pointer) {
  std::free(Pointer);
}
int PosixMemalign(void** Result, std::uint64_t Alignment, std::uint64_t Size) {
  return posix_memalign(Result, std::max<std::uint64_t>(Alignment, sizeof(void*)), Size);
}
} // namespace Kernel

namespace {
const std::pair<const char*, FexGuest::Thunk> HostFunctions[] = {
  {"__error", SysV::Thunk<&Kernel::Error>},
  {"__tls_get_addr", SysV::Thunk<&Kernel::TlsGetAddr>},
  {"sceKernelGetProcParam", SysV::Thunk<&Kernel::GetProcParam>},
  {"sceKernelGetProcessTime", SysV::Thunk<&sceKernelGetProcessTime>},
  {"sceKernelMapNamedFlexibleMemory", SysV::Thunk<&Kernel::MapNamedFlexibleMemory>},
  {"_sceKernelRtldSetApplicationHeapAPI", SysV::Thunk<&Kernel::Zero>},
  {"_sceKernelSetThreadAtexitCount", SysV::Thunk<&Kernel::Zero>},
  {"_sceKernelSetThreadAtexitReport", SysV::Thunk<&Kernel::Zero>},
  {"_sceKernelSetThreadDtors", SysV::Thunk<&Kernel::Zero>},
  {"scePthreadSelf", SysV::Thunk<&Kernel::PthreadSelf>},
  {"scePthreadKeyCreate", SysV::Thunk<&Kernel::KeyCreate>},
  {"scePthreadGetspecific", SysV::Thunk<&Kernel::GetSpecific>},
  {"scePthreadSetspecific", SysV::Thunk<&Kernel::SetSpecific>},
  // One guest thread: locks are uncontended.
  {"scePthreadMutexInit", SysV::Thunk<&Kernel::Zero>},
  {"scePthreadMutexDestroy", SysV::Thunk<&Kernel::Zero>},
  {"scePthreadMutexLock", SysV::Thunk<&Kernel::Zero>},
  {"scePthreadMutexTrylock", SysV::Thunk<&Kernel::Zero>},
  {"scePthreadMutexUnlock", SysV::Thunk<&Kernel::Zero>},
  {"scePthreadMutexattrInit", SysV::Thunk<&Kernel::Zero>},
  {"scePthreadMutexattrSettype", SysV::Thunk<&Kernel::Zero>},
  {"scePthreadMutexattrDestroy", SysV::Thunk<&Kernel::Zero>},
  {"pthread_mutex_lock", SysV::Thunk<&Kernel::Zero>},
  {"pthread_mutex_unlock", SysV::Thunk<&Kernel::Zero>},
  {"pthread_rwlock_rdlock", SysV::Thunk<&Kernel::Zero>},
  {"pthread_rwlock_wrlock", SysV::Thunk<&Kernel::Zero>},
  {"pthread_rwlock_unlock", SysV::Thunk<&Kernel::Zero>},
  {"_write", SysV::Thunk<&Kernel::Write>},
  {"malloc", SysV::Thunk<&Kernel::Malloc>},
  {"free", SysV::Thunk<&Kernel::Free>},
  {"posix_memalign", SysV::Thunk<&Kernel::PosixMemalign>},
};

std::vector<FexGuest::Thunk> Table;
std::vector<std::string> TableNids;
std::unordered_map<std::string, std::size_t> HostByNid;
std::unordered_map<std::string, std::string> NameByNid;
std::unordered_map<std::string, std::uint64_t> Objects;
std::vector<Ps5::Module*> Modules;

std::uint64_t StubAddress(std::size_t Index) {
  return FexGuest::StubBase + FexGuest::ThunkStubOffset + Index * FexGuest::ThunkStubSize;
}

// An import with no host function yet: the run stops here and names it.
FexGuest::After Unimplemented(FexGuest::CPUState& State) {
  const std::size_t Index = (State.rip - FexGuest::StubBase - FexGuest::ThunkStubOffset) / FexGuest::ThunkStubSize;
  const std::uint64_t Return = Ps5::Guest<std::uint64_t>(State.gregs[FexGuest::X86::REG_RSP]);
  for (auto* M : Modules) {
    if (Return >= M->Base && Return - M->Base < 0x10000000) {
      std::printf("guest called import %s, which has no host function yet, from %s+0x%llx\nSTOP\n", TableNids[Index].c_str(), M->Name.c_str(),
                  static_cast<unsigned long long>(Return - M->Base));
      std::exit(5);
    }
  }
  std::printf("guest called import %s, which has no host function yet\nSTOP\n", TableNids[Index].c_str());
  std::exit(5);
}

std::uint64_t Resolve(const Ps5::Symbol& S) {
  const std::string Nid = Ps5::NidOf(S.Name);
  for (auto* M : Modules) {
    if (auto Export = M->Exports.find(Nid); Export != M->Exports.end()) {
      return Export->second;
    }
  }
  if (S.IsObject()) {
    // A data import from a system library: zeroed storage, with the values a libc reads before main.
    auto [Object, Inserted] = Objects.try_emplace(Nid, 0);
    if (Inserted) {
      auto* Storage = static_cast<std::uint64_t*>(FexGuest::MapGuest(0x4000));
      const auto Name = NameByNid.contains(Nid) ? NameByNid[Nid] : Nid;
      if (Name == "__stack_chk_guard") {
        Storage[0] = 0x5c9a'31f0'7d24'e6b1ULL;
      } else if (Name == "__progname") {
        std::strcpy(reinterpret_cast<char*>(Storage + 2), "eboot.bin");
        Storage[0] = reinterpret_cast<std::uint64_t>(Storage + 2);
      }
      Object->second = reinterpret_cast<std::uint64_t>(Storage);
      std::printf("data import %s bound to host storage\n", Name.c_str());
    }
    return Object->second;
  }
  if (auto Host = HostByNid.find(Nid); Host != HostByNid.end()) {
    return StubAddress(Host->second);
  }
  HostByNid.emplace(Nid, Table.size());
  Table.push_back(Unimplemented);
  TableNids.push_back(Nid);
  return StubAddress(Table.size() - 1);
}

std::vector<std::string> SceModules(const std::string& Directory) {
  std::vector<std::string> Names;
  if (DIR* Listing = opendir((Directory + "/sce_module").c_str())) {
    while (auto* Entry = readdir(Listing)) {
      const std::string Name = Entry->d_name;
      if (Name.size() > 4 && Name.compare(Name.size() - 4, 4, ".prx") == 0) {
        Names.push_back(Name);
      }
    }
    closedir(Listing);
  }
  std::sort(Names.begin(), Names.end());
  return Names;
}
} // namespace

int main(int argc, char** argv) {
  if (argc != 4 || (std::string(argv[3]) != "modules" && std::string(argv[3]) != "eboot-only")) {
    std::fprintf(stderr, "usage: %s <game directory> <main vaddr> modules|eboot-only\n", argv[0]);
    return 2;
  }
  FexGuest::InstallFaultReport();
  FexGuest::InitConfig();
  const std::string Directory = argv[1];
  const std::uint64_t MainOffset = std::strtoull(argv[2], nullptr, 0);

  for (const auto& [Name, Thunk] : HostFunctions) {
    const auto Nid = Nid::ComputeNid(Name, "");
    NameByNid.emplace(Nid, Name);
    HostByNid.emplace(Nid, Table.size());
    Table.push_back(Thunk);
    TableNids.push_back(Nid);
  }
  for (const char* Name : {"__stack_chk_guard", "__progname"}) {
    NameByNid.emplace(Nid::ComputeNid(Name, ""), Name);
  }
  FexGuest::MapStubs(FexGuest::MaximumThunks);

  auto Eboot = Ps5::Load(Directory + "/eboot.elf", "eboot.elf");
  std::vector<Ps5::Module> Prx;
  if (std::string(argv[3]) == "modules") {
    for (const auto& Name : SceModules(Directory)) {
      Prx.push_back(Ps5::Load(Directory + "/sce_module/" + Name, Name));
    }
  }
  Modules.push_back(&Eboot);
  for (auto& M : Prx) {
    Modules.push_back(&M);
  }
  Kernel::ThreadPointer = Ps5::SetUpStaticTls(Modules);
  Kernel::ProcParam = Eboot.ProcParam;
  for (auto* M : Modules) {
    Ps5::Relocate(*M, Resolve);
  }
  if (Table.size() > FexGuest::MaximumThunks) {
    std::printf("%zu imports exceed the stub page\nFAIL\n", Table.size());
    return 1;
  }
  std::printf("%zu host functions, %zu imports without one\n", std::size(HostFunctions), Table.size() - std::size(HostFunctions));

  const std::uint64_t Main = Eboot.Base + MainOffset;
  *reinterpret_cast<std::uint8_t*>(Main) = 0xF4;
  std::uint64_t ThunkCalls = 0;
  FexGuest::CPUState State {};
  State.fs_cached = Kernel::ThreadPointer;
  for (auto& M : Prx) {
    if (M.Init == 0) {
      continue;
    }
    State.rip = M.Init;
    State.gregs[FexGuest::X86::REG_RSP] = FexGuest::MapStack();
    FexGuest::Run(State, Table, ThunkCalls);
    std::printf("%s DT_INIT returned\n", M.Name.c_str());
  }

  // The PS5 argument block: argc, then argv.
  auto* Arguments = static_cast<std::uint64_t*>(FexGuest::MapGuest(0x4000));
  std::strcpy(reinterpret_cast<char*>(Arguments + 8), "eboot.bin");
  Arguments[0] = 1;
  Arguments[1] = reinterpret_cast<std::uint64_t>(Arguments + 8);
  Arguments[2] = 0;
  FexGuest::CPUState Start {};
  Start.fs_cached = Kernel::ThreadPointer;
  Start.rip = Eboot.Base + Eboot.Entry;
  Start.gregs[FexGuest::X86::REG_RSP] = FexGuest::MapStack();
  Start.gregs[FexGuest::X86::REG_RDI] = reinterpret_cast<std::uint64_t>(Arguments);
  const auto& Final = FexGuest::Run(Start, Table, ThunkCalls, Main);
  if (Final.rip != Main) {
    std::printf("_start returned without reaching main\nFAIL\n");
    return 1;
  }
  const auto Argc = static_cast<std::uint32_t>(Final.gregs[FexGuest::X86::REG_RDI]);
  const auto* Argv = reinterpret_cast<const std::uint64_t*>(Final.gregs[FexGuest::X86::REG_RSI]);
  std::printf("reached main(argc=%u, argv[0]=\"%s\") after %llu host calls\n", Argc, Argc ? reinterpret_cast<const char*>(Argv[0]) : "",
              static_cast<unsigned long long>(ThunkCalls));
  const bool Pass = Argc == 1 && std::strcmp(reinterpret_cast<const char*>(Argv[0]), "eboot.bin") == 0;
  std::printf("%s\n", Pass ? "PASS" : "FAIL");
  return Pass ? 0 : 1;
}
