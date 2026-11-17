// SPDX-License-Identifier: GPL-2.0-only
// Guest threads for the FEX route. Each guest thread runs on its own OS thread with its own FEX thread state
// (FexGuest::RunNewThread), guest stack and static TLS copy (Ps5::AllocateStaticTls). libkernel's thread code
// (prx/libkernel/Pthread) starts guest code through the Rosetta route's relinked entry and TLS conventions, so the
// start host implements the thread, mutex, condition variable, read-write lock, once and thread-specific data exports
// itself, on Darwin's pthreads, with FreeBSD's semantics:
// - a pthread_t, pthread_mutex_t, pthread_cond_t, pthread_rwlock_t or attribute object is a pointer-sized guest slot
//   that holds a host record; NULL (and 1, the adaptive mutex initializer) in a mutex, condition variable or read-write
//   lock slot is a static initializer, replaced by a record on first use;
// - the default mutex type is error-checking, as FreeBSD's PTHREAD_MUTEX_DEFAULT;
// - POSIX functions return an errno value, SCE functions SCE_KERNEL_ERROR_* (0x80020000 + errno). FreeBSD's and
//   Darwin's errno values agree for every value returned here;
// - pthread_exit and a thread entry's return run the thread-specific data destructors on the exiting guest thread.
#include "GuestThreads.h"

#include "Ps5Module.h"
#include "SysVThunk.h"
#include "prx/libkernel/System/include/UserContext.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <pthread.h>
#include <sched.h>
#include <string>
#include <string_view>
#include <thread>
#include <time.h>
#include <vector>

namespace {
int Sce(int Error) {
  return Error == 0 ? 0 : static_cast<int>(0x8002'0000U | static_cast<unsigned>(Error));
}

constexpr std::size_t KeyCount = 256; // PTHREAD_KEYS_MAX
constexpr int DestructorIterations = 4; // PTHREAD_DESTRUCTOR_ITERATIONS
constexpr std::uint64_t MinimumStackSize = 256 << 10;
std::atomic<std::uint64_t> DefaultStackSize {2 << 20};
// Host stacks run the thunks and the native libraries they call (shader compilers among them).
constexpr std::size_t HostStackSize = 16 << 20;

// FreeBSD values.
constexpr int CreateDetached = 1;
constexpr int InheritScheduling = 4;
constexpr int MutexErrorCheck = 1, MutexRecursive = 2, MutexNormal = 3, MutexAdaptive = 4;
constexpr int ClockMonotonic = 4;

struct Attributes {
  // A running thread's attributes (scePthreadAttrGet) hold its guest stack; Unity's garbage collector scans from it.
  std::uint64_t StackAddr = 0;
  std::uint64_t StackSize = DefaultStackSize.load();
  std::uint64_t GuardSize = 0x1000;
  int DetachState = 0;
  int Inherit = InheritScheduling;
  int Policy = 2; // SCHED_OTHER
  int Priority = 700;
  std::uint64_t Affinity = 0x7f;
};

struct Thread {
  // A game treats a pthread_t as an opaque pointer; these bytes keep it pointing at readable memory.
  std::uint8_t Opaque[0x100] {};
  std::uint64_t Entry = 0, Argument = 0, Result = 0, ThreadPointer = 0;
  Attributes Settings;
  std::string Name;
  int Id = 0;
  std::mutex Lock;
  std::condition_variable Done;
  bool Finished = false, Detached = false;
  // Under Lock: the OS thread, once it runs the guest, for sceKernelRaiseException's signal.
  bool Started = false;
  // Created by AnyPS5's own arm64 code with a host entry (scePthreadCreate called from a host library): the entry runs
  // natively, and the thread gets a guest thread only if it calls guest code (AdoptHostThread).
  bool HostEntry = false;
  pthread_t Host {};
  FexGuest::PendingException Exception;
  std::array<std::uint64_t, KeyCount> Specific {};
};
// Thread records stay allocated: a handle can outlive its thread.
thread_local Thread* Self = nullptr;
Thread InitialThread;
std::atomic<int> NextThreadId {1};

struct Key {
  bool Used = false;
  std::uint64_t Destructor = 0;
};
std::mutex KeyMutex;
std::array<Key, KeyCount> Keys;

// pthread_exit unwinds the host frames of the exiting thread up to its start function.
struct ExitRequest {
  std::uint64_t Value;
};

// The host function libSceLibcInternal registers for C++ thread_local destructors (sceKernelSetThreadDtors). It runs at
// a guest thread's exit, before the thread-specific data destructors, as FreeBSD's libthr calls its thread dtors first.
std::atomic<void (*)()> ThreadDtors {nullptr};

void RunKeyDestructors() {
  if (!Self) {
    return;
  }
  if (auto* Dtors = ThreadDtors.load(std::memory_order_acquire)) {
    Dtors();
  }
  for (int Iteration = 0; Iteration < DestructorIterations; ++Iteration) {
    bool Called = false;
    for (std::size_t Index = 0; Index < KeyCount; ++Index) {
      std::uint64_t Destructor;
      {
        std::lock_guard Lock(KeyMutex);
        Destructor = Keys[Index].Used ? Keys[Index].Destructor : 0;
      }
      const std::uint64_t Value = Self->Specific[Index];
      if (Destructor == 0 || Value == 0) {
        continue;
      }
      Self->Specific[Index] = 0;
      const std::uint64_t Arguments[] = {Value};
      FexGuest::CallGuest(Destructor, Arguments, {});
      Called = true;
    }
    if (!Called) {
      return;
    }
  }
}

// Guest stacks are reused rather than unmapped: an unmapped range would stay in the host's owned guest ranges.
std::mutex StackMutex;
std::vector<std::pair<std::uint64_t, std::uint64_t>> FreeStacks; // base, size
std::vector<std::pair<std::uint64_t, std::uint64_t>> AllStacks;  // every guest thread stack mapped so far
std::pair<std::uint64_t, std::uint64_t> TakeStack(std::uint64_t Size) {
  Size = (Size + 0x3fff) & ~0x3fffULL;
  {
    std::lock_guard Lock(StackMutex);
    for (auto Stack = FreeStacks.begin(); Stack != FreeStacks.end(); ++Stack) {
      if (Stack->second >= Size) {
        const auto Found = *Stack;
        FreeStacks.erase(Stack);
        return Found;
      }
    }
  }
  const std::pair<std::uint64_t, std::uint64_t> Stack {reinterpret_cast<std::uint64_t>(FexGuest::MapGuest(Size)), Size};
  std::lock_guard Lock(StackMutex);
  AllStacks.push_back(Stack);
  return Stack;
}
void ReturnStack(std::pair<std::uint64_t, std::uint64_t> Stack) {
  std::lock_guard Lock(StackMutex);
  FreeStacks.push_back(Stack);
}

void* Start(void* Opaque) {
  auto* T = static_cast<Thread*>(Opaque);
  Self = T;
  if (!T->Name.empty()) {
    pthread_setname_np(T->Name.substr(0, 63).c_str());
  }
  FexGuest::ThreadException = &T->Exception;
  {
    std::lock_guard Lock(T->Lock);
    T->Host = pthread_self();
    T->Started = true;
  }
  std::uint64_t Result;
  if (T->HostEntry) {
    try {
      Result = reinterpret_cast<std::uint64_t>(reinterpret_cast<void* (*)(void*)>(T->Entry)(reinterpret_cast<void*>(T->Argument)));
      RunKeyDestructors();
    } catch (const ExitRequest& Exit) {
      Result = Exit.Value;
    }
  } else {
    const auto Stack = TakeStack(T->Settings.StackSize);
    T->Settings.StackAddr = Stack.first;
    T->Settings.StackSize = Stack.second;
    try {
      Result = FexGuest::RunNewThread(T->Entry, T->Argument, Stack.first + Stack.second, T->ThreadPointer, RunKeyDestructors);
    } catch (const ExitRequest& Exit) {
      Result = Exit.Value;
    }
    ReturnStack(Stack);
  }
  FexGuest::ThreadException = nullptr;
  {
    std::lock_guard Lock(T->Lock);
    T->Result = Result;
    T->Finished = true;
  }
  T->Done.notify_all();
  return nullptr;
}

Thread* ThreadOf(std::uint64_t Handle) {
  return reinterpret_cast<Thread*>(Handle);
}

int Create(std::uint64_t* Out, const std::uint64_t* AttributeSlot, std::uint64_t Entry, std::uint64_t Argument, const char* Name,
           bool HostEntry = false) {
  if (!Out || Entry == 0) {
    return EINVAL;
  }
  auto* T = new Thread;
  T->HostEntry = HostEntry;
  if (AttributeSlot && *AttributeSlot) {
    T->Settings = *reinterpret_cast<const Attributes*>(*AttributeSlot);
  }
  T->Settings.StackSize = std::max(T->Settings.StackSize, MinimumStackSize);
  T->Entry = Entry;
  T->Argument = Argument;
  T->Detached = T->Settings.DetachState == CreateDetached;
  T->Name = Name ? Name : "";
  T->Id = NextThreadId.fetch_add(1);
  T->ThreadPointer = Ps5::AllocateStaticTls();
  reinterpret_cast<std::uint64_t*>(T->ThreadPointer)[2] = reinterpret_cast<std::uint64_t>(T);
  *Out = reinterpret_cast<std::uint64_t>(T);
  pthread_attr_t Host;
  pthread_attr_init(&Host);
  pthread_attr_setstacksize(&Host, HostStackSize);
  pthread_attr_setdetachstate(&Host, PTHREAD_CREATE_DETACHED);
  pthread_t Created;
  const int Error = pthread_create(&Created, &Host, Start, T);
  pthread_attr_destroy(&Host);
  return Error == 0 ? 0 : EAGAIN;
}

int Join(std::uint64_t Handle, std::uint64_t* Value) {
  auto* T = ThreadOf(Handle);
  if (!T) {
    return ESRCH;
  }
  if (T == Self) {
    return EDEADLK;
  }
  std::unique_lock Lock(T->Lock);
  if (T->Detached) {
    return EINVAL;
  }
  T->Done.wait(Lock, [T] { return T->Finished; });
  T->Detached = true;
  if (Value) {
    *Value = T->Result;
  }
  return 0;
}

int Detach(std::uint64_t Handle) {
  auto* T = ThreadOf(Handle);
  if (!T) {
    return ESRCH;
  }
  std::lock_guard Lock(T->Lock);
  if (T->Detached) {
    return EINVAL;
  }
  T->Detached = true;
  return 0;
}

std::uint64_t SelfHandle() {
  return reinterpret_cast<std::uint64_t>(Self ? Self : &InitialThread);
}

int Exit(std::uint64_t Value) {
  if (Self == &InitialThread || !Self) {
    // FreeBSD ends the process when the initial thread exits and no other thread remains; this host ends it at once,
    // without waiting for the other threads.
    std::printf("guest pthread_exit on the initial thread\n");
    std::fflush(stdout);
    std::_Exit(0);
  }
  RunKeyDestructors();
  throw ExitRequest {Value};
}

// Mutexes.
struct MutexAttributes {
  int Type = MutexErrorCheck;
  int Protocol = 0;
};
struct Mutex {
  pthread_mutex_t Host;
  int Type;
  // The holding thread and its lock depth, which only the holder writes (pthread_mutex_isowned_np reads the owner).
  std::atomic<pthread_t> Owner {nullptr};
  int Depth = 0;
};
void Acquired(Mutex* M) {
  if (M->Owner.load(std::memory_order_relaxed) == pthread_self()) {
    ++M->Depth;
  } else {
    M->Owner.store(pthread_self(), std::memory_order_relaxed);
    M->Depth = 1;
  }
}
// Before the host unlock, so the next holder's Acquired comes after.
void Releasing(Mutex* M) {
  if (M->Owner.load(std::memory_order_relaxed) == pthread_self() && --M->Depth == 0) {
    M->Owner.store(nullptr, std::memory_order_relaxed);
  }
}
Mutex* NewMutex(int Type) {
  auto* M = new Mutex;
  M->Type = Type;
  pthread_mutexattr_t Attributes;
  pthread_mutexattr_init(&Attributes);
  pthread_mutexattr_settype(&Attributes, Type == MutexRecursive ? PTHREAD_MUTEX_RECURSIVE :
                                         Type == MutexNormal || Type == MutexAdaptive ? PTHREAD_MUTEX_NORMAL : PTHREAD_MUTEX_ERRORCHECK);
  pthread_mutex_init(&M->Host, &Attributes);
  pthread_mutexattr_destroy(&Attributes);
  return M;
}
// The record a guest slot names, created on first use for a static initializer.
template<class Record, class Make>
Record* RecordOf(std::uint64_t* Slot, Make Create) {
  std::uint64_t Value = __atomic_load_n(Slot, __ATOMIC_ACQUIRE);
  if (Value > 1) {
    return reinterpret_cast<Record*>(Value);
  }
  auto* Created = Create(Value);
  if (__atomic_compare_exchange_n(Slot, &Value, reinterpret_cast<std::uint64_t>(Created), false, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) {
    return Created;
  }
  delete Created;
  return reinterpret_cast<Record*>(Value);
}
Mutex* MutexOf(std::uint64_t* Slot) {
  return RecordOf<Mutex>(Slot, [](std::uint64_t Initializer) { return NewMutex(Initializer == 1 ? MutexAdaptive : MutexErrorCheck); });
}

int MutexInit(std::uint64_t* Slot, const std::uint64_t* AttributeSlot) {
  if (!Slot) {
    return EINVAL;
  }
  const int Type = AttributeSlot && *AttributeSlot ? reinterpret_cast<const MutexAttributes*>(*AttributeSlot)->Type : MutexErrorCheck;
  *Slot = reinterpret_cast<std::uint64_t>(NewMutex(Type));
  return 0;
}
int MutexDestroy(std::uint64_t* Slot) {
  if (!Slot) {
    return EINVAL;
  }
  if (*Slot > 1) {
    auto* M = reinterpret_cast<Mutex*>(*Slot);
    if (pthread_mutex_destroy(&M->Host) == EBUSY) {
      return EBUSY;
    }
    delete M;
  }
  *Slot = 0;
  return 0;
}
int MutexLock(std::uint64_t* Slot) {
  if (!Slot) {
    return EINVAL;
  }
  auto* M = MutexOf(Slot);
  const int Error = pthread_mutex_lock(&M->Host);
  if (Error == 0) {
    Acquired(M);
  }
  return Error;
}
int MutexTrylock(std::uint64_t* Slot) {
  if (!Slot) {
    return EINVAL;
  }
  auto* M = MutexOf(Slot);
  const int Error = pthread_mutex_trylock(&M->Host);
  if (Error == 0) {
    Acquired(M);
  }
  return Error;
}
int MutexUnlock(std::uint64_t* Slot) {
  if (!Slot) {
    return EINVAL;
  }
  auto* M = MutexOf(Slot);
  Releasing(M);
  return pthread_mutex_unlock(&M->Host);
}
bool MutexIsOwned(std::uint64_t* Slot) {
  return Slot && __atomic_load_n(Slot, __ATOMIC_ACQUIRE) > 1 &&
         reinterpret_cast<Mutex*>(*Slot)->Owner.load(std::memory_order_relaxed) == pthread_self();
}
int PosixMutexIsowned(std::uint64_t* Slot) {
  return MutexIsOwned(Slot) ? 1 : 0;
}
// libkernel_sys's form: SceKernelError(1) when the calling thread holds it, 0 when it does not.
int SceMutexIsowned(std::uint64_t* Slot) {
  return MutexIsOwned(Slot) ? static_cast<int>(0x80020001) : 0;
}
// Darwin has no pthread_mutex_timedlock: try until the deadline.
int MutexLockFor(std::uint64_t* Slot, std::chrono::steady_clock::time_point Deadline) {
  if (!Slot) {
    return EINVAL;
  }
  auto* M = MutexOf(Slot);
  for (;;) {
    const int Error = pthread_mutex_trylock(&M->Host);
    if (Error == 0) {
      Acquired(M);
    }
    if (Error != EBUSY) {
      return Error;
    }
    if (std::chrono::steady_clock::now() >= Deadline) {
      return ETIMEDOUT;
    }
    std::this_thread::sleep_for(std::chrono::microseconds(200));
  }
}

// The steady-clock point of a guest absolute time on a FreeBSD clock.
struct GuestTimespec {
  std::int64_t Seconds;
  std::int64_t Nanoseconds;
};
std::chrono::steady_clock::time_point DeadlineOf(const GuestTimespec* Time, int Clock) {
  timespec Now;
  clock_gettime(Clock == ClockMonotonic || Clock == 5 || Clock == 7 || Clock == 8 || Clock == 11 || Clock == 12 ? CLOCK_MONOTONIC : CLOCK_REALTIME, &Now);
  const std::int64_t Remaining = (Time->Seconds - Now.tv_sec) * 1'000'000'000LL + (Time->Nanoseconds - Now.tv_nsec);
  return std::chrono::steady_clock::now() + std::chrono::nanoseconds(std::max<std::int64_t>(Remaining, 0));
}
std::chrono::steady_clock::time_point DeadlineAfter(std::uint32_t Microseconds) {
  return std::chrono::steady_clock::now() + std::chrono::microseconds(Microseconds);
}

int MutexTimedlock(std::uint64_t* Slot, const GuestTimespec* Time) {
  return Time ? MutexLockFor(Slot, DeadlineOf(Time, 0)) : EINVAL;
}

int MutexattrInit(std::uint64_t* Slot) {
  if (!Slot) {
    return EINVAL;
  }
  *Slot = reinterpret_cast<std::uint64_t>(new MutexAttributes);
  return 0;
}
int MutexattrDestroy(std::uint64_t* Slot) {
  if (!Slot || !*Slot) {
    return EINVAL;
  }
  delete reinterpret_cast<MutexAttributes*>(*Slot);
  *Slot = 0;
  return 0;
}
int MutexattrSettype(std::uint64_t* Slot, int Type) {
  if (!Slot || !*Slot || Type < MutexErrorCheck || Type > MutexAdaptive) {
    return EINVAL;
  }
  reinterpret_cast<MutexAttributes*>(*Slot)->Type = Type;
  return 0;
}
int MutexattrGettype(const std::uint64_t* Slot, int* Type) {
  if (!Slot || !*Slot || !Type) {
    return EINVAL;
  }
  *Type = reinterpret_cast<const MutexAttributes*>(*Slot)->Type;
  return 0;
}
int MutexattrSetprotocol(std::uint64_t* Slot, int Protocol) {
  if (!Slot || !*Slot) {
    return EINVAL;
  }
  reinterpret_cast<MutexAttributes*>(*Slot)->Protocol = Protocol;
  return 0;
}
int MutexattrGetprotocol(const std::uint64_t* Slot, int* Protocol) {
  if (!Slot || !*Slot || !Protocol) {
    return EINVAL;
  }
  *Protocol = reinterpret_cast<const MutexAttributes*>(*Slot)->Protocol;
  return 0;
}
int MutexattrSetpshared(std::uint64_t* Slot, int) {
  return Slot && *Slot ? 0 : EINVAL;
}

// Condition variables.
struct CondAttributes {
  int Clock = 0;
};
struct Cond {
  pthread_cond_t Host;
  int Clock = 0;
};
Cond* NewCond(int Clock) {
  auto* C = new Cond;
  C->Clock = Clock;
  pthread_cond_init(&C->Host, nullptr);
  return C;
}
Cond* CondOf(std::uint64_t* Slot) {
  return RecordOf<Cond>(Slot, [](std::uint64_t) { return NewCond(0); });
}
int CondInit(std::uint64_t* Slot, const std::uint64_t* AttributeSlot) {
  if (!Slot) {
    return EINVAL;
  }
  *Slot = reinterpret_cast<std::uint64_t>(NewCond(AttributeSlot && *AttributeSlot ? reinterpret_cast<const CondAttributes*>(*AttributeSlot)->Clock : 0));
  return 0;
}
int CondDestroy(std::uint64_t* Slot) {
  if (!Slot) {
    return EINVAL;
  }
  if (*Slot > 1) {
    auto* C = reinterpret_cast<Cond*>(*Slot);
    if (pthread_cond_destroy(&C->Host) == EBUSY) {
      return EBUSY;
    }
    delete C;
  }
  *Slot = 0;
  return 0;
}
// A wait releases the mutex and takes it again: the owner record follows.
template<class Wait>
int WaitHolding(Mutex* M, Wait Waiting) {
  const int Depth = M->Owner.load(std::memory_order_relaxed) == pthread_self() ? M->Depth : 0;
  if (Depth) {
    M->Depth = 0;
    M->Owner.store(nullptr, std::memory_order_relaxed);
  }
  const int Error = Waiting();
  if (Depth) {
    M->Owner.store(pthread_self(), std::memory_order_relaxed);
    M->Depth = Depth;
  }
  return Error;
}
int CondWait(std::uint64_t* Slot, std::uint64_t* MutexSlot) {
  if (!Slot || !MutexSlot) {
    return EINVAL;
  }
  auto* C = CondOf(Slot);
  auto* M = MutexOf(MutexSlot);
  return WaitHolding(M, [&] { return pthread_cond_wait(&C->Host, &M->Host); });
}
int CondWaitUntil(std::uint64_t* Slot, std::uint64_t* MutexSlot, std::chrono::steady_clock::time_point Deadline) {
  if (!Slot || !MutexSlot) {
    return EINVAL;
  }
  const auto Remaining = std::chrono::duration_cast<std::chrono::nanoseconds>(Deadline - std::chrono::steady_clock::now()).count();
  const timespec Relative {static_cast<time_t>(std::max<std::int64_t>(Remaining, 0) / 1'000'000'000),
                           static_cast<long>(std::max<std::int64_t>(Remaining, 0) % 1'000'000'000)};
  auto* C = CondOf(Slot);
  auto* M = MutexOf(MutexSlot);
  return WaitHolding(M, [&] { return pthread_cond_timedwait_relative_np(&C->Host, &M->Host, &Relative); });
}
int CondTimedwait(std::uint64_t* Slot, std::uint64_t* MutexSlot, const GuestTimespec* Time) {
  return Slot && Time ? CondWaitUntil(Slot, MutexSlot, DeadlineOf(Time, CondOf(Slot)->Clock)) : EINVAL;
}
int CondSignal(std::uint64_t* Slot) {
  return Slot ? pthread_cond_signal(&CondOf(Slot)->Host) : EINVAL;
}
int CondBroadcast(std::uint64_t* Slot) {
  return Slot ? pthread_cond_broadcast(&CondOf(Slot)->Host) : EINVAL;
}
int CondattrInit(std::uint64_t* Slot) {
  if (!Slot) {
    return EINVAL;
  }
  *Slot = reinterpret_cast<std::uint64_t>(new CondAttributes);
  return 0;
}
int CondattrDestroy(std::uint64_t* Slot) {
  if (!Slot || !*Slot) {
    return EINVAL;
  }
  delete reinterpret_cast<CondAttributes*>(*Slot);
  *Slot = 0;
  return 0;
}
int CondattrSetclock(std::uint64_t* Slot, int Clock) {
  if (!Slot || !*Slot) {
    return EINVAL;
  }
  reinterpret_cast<CondAttributes*>(*Slot)->Clock = Clock;
  return 0;
}
int CondattrGetclock(const std::uint64_t* Slot, int* Clock) {
  if (!Slot || !*Slot || !Clock) {
    return EINVAL;
  }
  *Clock = reinterpret_cast<const CondAttributes*>(*Slot)->Clock;
  return 0;
}

// Read-write locks.
struct RwLock {
  pthread_rwlock_t Host;
};
RwLock* RwLockOf(std::uint64_t* Slot) {
  return RecordOf<RwLock>(Slot, [](std::uint64_t) {
    auto* L = new RwLock;
    pthread_rwlock_init(&L->Host, nullptr);
    return L;
  });
}
int RwlockInit(std::uint64_t* Slot, const std::uint64_t*) {
  if (!Slot) {
    return EINVAL;
  }
  *Slot = 0;
  RwLockOf(Slot);
  return 0;
}
int RwlockDestroy(std::uint64_t* Slot) {
  if (!Slot) {
    return EINVAL;
  }
  if (*Slot > 1) {
    auto* L = reinterpret_cast<RwLock*>(*Slot);
    if (pthread_rwlock_destroy(&L->Host) == EBUSY) {
      return EBUSY;
    }
    delete L;
  }
  *Slot = 0;
  return 0;
}
int RwlockRdlock(std::uint64_t* Slot) {
  return Slot ? pthread_rwlock_rdlock(&RwLockOf(Slot)->Host) : EINVAL;
}
int RwlockWrlock(std::uint64_t* Slot) {
  return Slot ? pthread_rwlock_wrlock(&RwLockOf(Slot)->Host) : EINVAL;
}
int RwlockTryrdlock(std::uint64_t* Slot) {
  return Slot ? pthread_rwlock_tryrdlock(&RwLockOf(Slot)->Host) : EINVAL;
}
int RwlockTrywrlock(std::uint64_t* Slot) {
  return Slot ? pthread_rwlock_trywrlock(&RwLockOf(Slot)->Host) : EINVAL;
}
int RwlockUnlock(std::uint64_t* Slot) {
  return Slot ? pthread_rwlock_unlock(&RwLockOf(Slot)->Host) : EINVAL;
}
// macOS has no timed read-write lock: the lock is tried until the deadline, 50 us apart.
template<int (*Try)(pthread_rwlock_t*)>
int RwlockLockFor(std::uint64_t* Slot, std::chrono::steady_clock::time_point Deadline) {
  if (!Slot) {
    return EINVAL;
  }
  auto* L = RwLockOf(Slot);
  for (;;) {
    const int Result = Try(&L->Host);
    if (Result != EBUSY) {
      return Result;
    }
    if (std::chrono::steady_clock::now() >= Deadline) {
      return ETIMEDOUT;
    }
    std::this_thread::sleep_for(std::chrono::microseconds(50));
  }
}
int RwlockattrInit(std::uint64_t* Slot) {
  if (!Slot) {
    return EINVAL;
  }
  *Slot = reinterpret_cast<std::uint64_t>(new int(0));
  return 0;
}
int RwlockattrDestroy(std::uint64_t* Slot) {
  if (!Slot || !*Slot) {
    return EINVAL;
  }
  delete reinterpret_cast<int*>(*Slot);
  *Slot = 0;
  return 0;
}

// pthread_once: FreeBSD's pthread_once_t is {int state; pthread_mutex_t mutex;}, state 0 until the routine has run and 1
// after; 2 marks a call in progress here.
std::mutex OnceMutex;
std::condition_variable OnceDone;
int Once(std::int32_t* State, std::uint64_t Routine) {
  if (!State || Routine == 0) {
    return EINVAL;
  }
  if (__atomic_load_n(State, __ATOMIC_ACQUIRE) == 1) {
    return 0;
  }
  {
    std::unique_lock Lock(OnceMutex);
    OnceDone.wait(Lock, [State] { return *State != 2; });
    if (*State == 1) {
      return 0;
    }
    *State = 2;
  }
  FexGuest::CallGuest(Routine, {}, {});
  {
    std::lock_guard Lock(OnceMutex);
    __atomic_store_n(State, 1, __ATOMIC_RELEASE);
  }
  OnceDone.notify_all();
  return 0;
}

// Thread-specific data. Keys are 1-based, as FreeBSD's.
int KeyCreate(std::uint32_t* Out, std::uint64_t Destructor) {
  if (!Out) {
    return EINVAL;
  }
  std::lock_guard Lock(KeyMutex);
  for (std::size_t Index = 0; Index < KeyCount; ++Index) {
    if (!Keys[Index].Used) {
      Keys[Index] = {true, Destructor};
      *Out = static_cast<std::uint32_t>(Index + 1);
      return 0;
    }
  }
  return EAGAIN;
}
int KeyDelete(std::uint32_t Key) {
  std::lock_guard Lock(KeyMutex);
  if (Key == 0 || Key > KeyCount || !Keys[Key - 1].Used) {
    return EINVAL;
  }
  Keys[Key - 1] = {};
  return 0;
}
Thread& Current() {
  return Self ? *Self : InitialThread;
}
std::uint64_t GetSpecific(std::uint32_t Key) {
  return Key == 0 || Key > KeyCount ? 0 : Current().Specific[Key - 1];
}
int SetSpecific(std::uint32_t Key, std::uint64_t Value) {
  if (Key == 0 || Key > KeyCount) {
    return EINVAL;
  }
  Current().Specific[Key - 1] = Value;
  return 0;
}

// Thread attributes.
Attributes* AttributesOf(const std::uint64_t* Slot) {
  return Slot && *Slot ? reinterpret_cast<Attributes*>(*Slot) : nullptr;
}
int AttrInit(std::uint64_t* Slot) {
  if (!Slot) {
    return EINVAL;
  }
  *Slot = reinterpret_cast<std::uint64_t>(new Attributes);
  return 0;
}
int AttrDestroy(std::uint64_t* Slot) {
  if (!AttributesOf(Slot)) {
    return EINVAL;
  }
  delete AttributesOf(Slot);
  *Slot = 0;
  return 0;
}
int AttrSetstacksize(std::uint64_t* Slot, std::uint64_t Size) {
  if (!AttributesOf(Slot) || Size == 0) {
    return EINVAL;
  }
  AttributesOf(Slot)->StackSize = Size;
  return 0;
}
int AttrGetstacksize(const std::uint64_t* Slot, std::uint64_t* Size) {
  if (!AttributesOf(Slot) || !Size) {
    return EINVAL;
  }
  *Size = AttributesOf(Slot)->StackSize;
  return 0;
}
int AttrSetguardsize(std::uint64_t* Slot, std::uint64_t Size) {
  if (!AttributesOf(Slot)) {
    return EINVAL;
  }
  AttributesOf(Slot)->GuardSize = Size;
  return 0;
}
int AttrSetstackaddr(std::uint64_t* Slot, std::uint64_t Address) {
  if (!AttributesOf(Slot)) {
    return EINVAL;
  }
  AttributesOf(Slot)->StackAddr = Address;
  return 0;
}
int AttrGetstackaddr(const std::uint64_t* Slot, std::uint64_t* Address) {
  if (!AttributesOf(Slot) || !Address) {
    return EINVAL;
  }
  *Address = AttributesOf(Slot)->StackAddr;
  return 0;
}
int AttrGetstack(const std::uint64_t* Slot, std::uint64_t* Address, std::uint64_t* Size) {
  if (!AttributesOf(Slot) || !Address || !Size) {
    return EINVAL;
  }
  *Address = AttributesOf(Slot)->StackAddr;
  *Size = AttributesOf(Slot)->StackSize;
  return 0;
}
int AttrGetguardsize(const std::uint64_t* Slot, std::uint64_t* Size) {
  if (!AttributesOf(Slot) || !Size) {
    return EINVAL;
  }
  *Size = AttributesOf(Slot)->GuardSize;
  return 0;
}
int AttrSetdetachstate(std::uint64_t* Slot, int State) {
  if (!AttributesOf(Slot) || (State != 0 && State != CreateDetached)) {
    return EINVAL;
  }
  AttributesOf(Slot)->DetachState = State;
  return 0;
}
int AttrGetdetachstate(const std::uint64_t* Slot, int* State) {
  if (!AttributesOf(Slot) || !State) {
    return EINVAL;
  }
  *State = AttributesOf(Slot)->DetachState;
  return 0;
}
int AttrSetinheritsched(std::uint64_t* Slot, int Inherit) {
  if (!AttributesOf(Slot)) {
    return EINVAL;
  }
  AttributesOf(Slot)->Inherit = Inherit;
  return 0;
}
int AttrGetinheritsched(const std::uint64_t* Slot, int* Inherit) {
  if (!AttributesOf(Slot) || !Inherit) {
    return EINVAL;
  }
  *Inherit = AttributesOf(Slot)->Inherit;
  return 0;
}
int AttrSetschedpolicy(std::uint64_t* Slot, int Policy) {
  if (!AttributesOf(Slot)) {
    return EINVAL;
  }
  AttributesOf(Slot)->Policy = Policy;
  return 0;
}
int AttrGetschedpolicy(const std::uint64_t* Slot, int* Policy) {
  if (!AttributesOf(Slot) || !Policy) {
    return EINVAL;
  }
  *Policy = AttributesOf(Slot)->Policy;
  return 0;
}
// struct sched_param is {int sched_priority;}.
int AttrSetschedparam(std::uint64_t* Slot, const int* Parameter) {
  if (!AttributesOf(Slot) || !Parameter) {
    return EINVAL;
  }
  AttributesOf(Slot)->Priority = *Parameter;
  return 0;
}
int AttrGetschedparam(const std::uint64_t* Slot, int* Parameter) {
  if (!AttributesOf(Slot) || !Parameter) {
    return EINVAL;
  }
  *Parameter = AttributesOf(Slot)->Priority;
  return 0;
}
int AttrSetaffinity(std::uint64_t* Slot, std::uint64_t Mask) {
  if (!AttributesOf(Slot)) {
    return EINVAL;
  }
  AttributesOf(Slot)->Affinity = Mask;
  return 0;
}
int AttrGetaffinity(const std::uint64_t* Slot, std::uint64_t* Mask) {
  if (!AttributesOf(Slot) || !Mask) {
    return EINVAL;
  }
  *Mask = AttributesOf(Slot)->Affinity;
  return 0;
}
// pthread_attr_get_np and scePthreadAttrGet: a thread's attributes into an initialized attribute object.
int AttrGet(std::uint64_t Handle, std::uint64_t* Slot) {
  if (!Handle || !AttributesOf(Slot)) {
    return EINVAL;
  }
  *AttributesOf(Slot) = ThreadOf(Handle)->Settings;
  return 0;
}

// Thread properties.
int Getthreadid() {
  return Current().Id;
}
int Setprio(std::uint64_t Handle, int Priority) {
  if (!Handle) {
    return ESRCH;
  }
  ThreadOf(Handle)->Settings.Priority = Priority;
  return 0;
}
int Getprio(std::uint64_t Handle, int* Priority) {
  if (!Handle || !Priority) {
    return EINVAL;
  }
  *Priority = ThreadOf(Handle)->Settings.Priority;
  return 0;
}
// The policy and priority are kept for the guest to read back; host threads keep the default scheduling.
int Setschedparam(std::uint64_t Handle, int Policy, const int* Parameter) {
  if (!Handle || !Parameter) {
    return EINVAL;
  }
  ThreadOf(Handle)->Settings.Policy = Policy;
  ThreadOf(Handle)->Settings.Priority = *Parameter;
  return 0;
}
int Getschedparam(std::uint64_t Handle, int* Policy, int* Parameter) {
  if (!Handle || !Policy || !Parameter) {
    return EINVAL;
  }
  *Policy = ThreadOf(Handle)->Settings.Policy;
  *Parameter = ThreadOf(Handle)->Settings.Priority;
  return 0;
}
int Setaffinity(std::uint64_t Handle, std::uint64_t Mask) {
  if (!Handle) {
    return ESRCH;
  }
  ThreadOf(Handle)->Settings.Affinity = Mask;
  return 0;
}
int Getaffinity(std::uint64_t Handle, std::uint64_t* Mask) {
  if (!Handle || !Mask) {
    return EINVAL;
  }
  *Mask = ThreadOf(Handle)->Settings.Affinity;
  return 0;
}
int Rename(std::uint64_t Handle, const char* Name) {
  if (!Handle || !Name) {
    return EINVAL;
  }
  auto* T = ThreadOf(Handle);
  T->Name = Name;
  if (T == &Current()) {
    pthread_setname_np(T->Name.substr(0, 63).c_str());
  }
  return 0;
}
// scePthreadGetname: the name into a 32-byte buffer.
int Getname(std::uint64_t Handle, char* Name) {
  if (!Handle || !Name) {
    return EINVAL;
  }
  std::snprintf(Name, 32, "%s", ThreadOf(Handle)->Name.c_str());
  return 0;
}
int GetnameNp(std::uint64_t Handle, char* Name, std::uint64_t Size) {
  if (!Handle || !Name || Size == 0) {
    return EINVAL;
  }
  std::snprintf(Name, Size, "%s", ThreadOf(Handle)->Name.c_str());
  return 0;
}
int Equal(std::uint64_t A, std::uint64_t B) {
  return A == B;
}
int Yield() {
  sched_yield();
  return 0;
}
int SetDefaultstacksize(std::uint64_t Size) {
  if (Size < MinimumStackSize) {
    return EINVAL;
  }
  DefaultStackSize = Size;
  return 0;
}

// POSIX and SCE entry points over the same implementation.
int PosixCreate(std::uint64_t* Out, const std::uint64_t* Attributes, std::uint64_t Entry, std::uint64_t Argument) {
  return Create(Out, Attributes, Entry, Argument, nullptr);
}
int PosixSetnameNp(std::uint64_t Handle, const char* Name) {
  return Rename(Handle, Name);
}
template<auto F, class... A>
int SceOf(A... Arguments) {
  return Sce(F(Arguments...));
}
int SceCreate(std::uint64_t* Out, const std::uint64_t* Attributes, std::uint64_t Entry, std::uint64_t Argument, const char* Name) {
  return Sce(Create(Out, Attributes, Entry, Argument, Name));
}
int SceCreateWith(std::uint64_t* Out, const std::uint64_t* Attributes, std::uint64_t Entry, std::uint64_t Argument, const char* Name,
                  bool HostEntry) {
  return Sce(Create(Out, Attributes, Entry, Argument, Name, HostEntry));
}
int SceMutexInit(std::uint64_t* Slot, const std::uint64_t* Attributes, const char*) {
  return Sce(MutexInit(Slot, Attributes));
}
int SceMutexTimedlock(std::uint64_t* Slot, std::uint32_t Microseconds) {
  return Sce(MutexLockFor(Slot, DeadlineAfter(Microseconds)));
}
int SceCondInit(std::uint64_t* Slot, const std::uint64_t* Attributes, const char*) {
  return Sce(CondInit(Slot, Attributes));
}
int SceCondTimedwait(std::uint64_t* Slot, std::uint64_t* MutexSlot, std::uint32_t Microseconds) {
  return Sce(CondWaitUntil(Slot, MutexSlot, DeadlineAfter(Microseconds)));
}
int SceRwlockInit(std::uint64_t* Slot, const std::uint64_t* Attributes, const char*) {
  return Sce(RwlockInit(Slot, Attributes));
}
int SceRwlockTimedrdlock(std::uint64_t* Slot, std::uint32_t Microseconds) {
  return Sce(RwlockLockFor<pthread_rwlock_tryrdlock>(Slot, DeadlineAfter(Microseconds)));
}
int SceRwlockTimedwrlock(std::uint64_t* Slot, std::uint32_t Microseconds) {
  return Sce(RwlockLockFor<pthread_rwlock_trywrlock>(Slot, DeadlineAfter(Microseconds)));
}
std::uint64_t SceGetspecific(std::uint32_t Key) {
  return GetSpecific(Key);
}

// Exception handlers (libkernel System/src/Exception.cpp's exports). A handler is a guest function
// handler(int signal, ucontext*); sceKernelRaiseException runs the signal-30 handler on another thread, which is how
// Unity's garbage collector stops threads (PS5Util.prx). The host delivers it through FexGuest's asynchronous
// exceptions. Fault signals keep their handlers for the guest to read back; guest faults still end the run.
constexpr int RaisedSignal = 30;
std::array<std::atomic<std::uint64_t>, 32> ExceptionHandlers {};
bool ExceptionSignalAllowed(int Signal) {
  return Signal == 1 || Signal == 4 || Signal == 8 || Signal == 10 || Signal == 11 || Signal == RaisedSignal;
}
int InstallExceptionHandler(int Signal, std::uint64_t Handler) {
  if (!ExceptionSignalAllowed(Signal) || Handler == 0) {
    return Sce(EINVAL);
  }
  std::uint64_t Expected = 0;
  return ExceptionHandlers[Signal].compare_exchange_strong(Expected, Handler) ? 0 : Sce(EAGAIN);
}
int RemoveExceptionHandler(int Signal) {
  if (!ExceptionSignalAllowed(Signal)) {
    return Sce(EINVAL);
  }
  ExceptionHandlers[Signal].store(0);
  return 0;
}
int RaiseException(std::uint64_t Handle, int Signal) {
  if (Signal != RaisedSignal) {
    return Sce(EINVAL);
  }
  auto* T = ThreadOf(Handle);
  const std::uint64_t Handler = ExceptionHandlers[Signal].load();
  if (!T || Handler == 0) {
    return Sce(!T ? ESRCH : EINVAL);
  }
  if (T == &Current()) {
    FexGuest::RunExceptionHandlerHere(Handler, Signal);
    return 0;
  }
  {
    std::lock_guard Lock(T->Lock);
    if (T->Finished || !T->Started) {
      return Sce(ESRCH);
    }
  }
  T->Exception.Signal = Signal;
  std::uint64_t Expected = 0;
  if (!T->Exception.Handler.compare_exchange_strong(Expected, Handler, std::memory_order_acq_rel)) {
    return 0; // already pending
  }
  // The target takes the exception only at a delivery point (FexGuest::TakeException); until then it is signalled
  // again every 100 microseconds.
  const auto Deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  for (;;) {
    {
      std::lock_guard Lock(T->Lock);
      if (T->Finished) {
        T->Exception.Handler.store(0);
        return Sce(ESRCH);
      }
      if (T->Exception.Handler.load(std::memory_order_acquire) == 0) {
        return 0;
      }
      pthread_kill(T->Host, FexGuest::ExceptionSignal);
    }
    for (int Wait = 0; Wait < 10; ++Wait) {
      if (T->Exception.Handler.load(std::memory_order_acquire) == 0) {
        return 0;
      }
      std::this_thread::sleep_for(std::chrono::microseconds(10));
    }
    if (std::chrono::steady_clock::now() > Deadline) {
      std::printf("sceKernelRaiseException: thread %d (%s) reached no delivery point in 10 s\n", T->Id, T->Name.c_str());
      std::fflush(stdout);
      Expected = Handler;
      T->Exception.Handler.compare_exchange_strong(Expected, 0);
      return Sce(EBUSY);
    }
  }
}

// The guest's exception context: FreeBSD's amd64 ucontext with an FXSAVE image (UserContext.hpp).
std::uint64_t WriteExceptionContext(const FexGuest::CPUState& State, std::uint64_t Rip, std::uint32_t Eflags, std::uint64_t Below) {
  namespace X86 = FexGuest::X86;
  const std::uint64_t Address = (Below - sizeof(UserUcontext)) & ~63ULL;
  auto* Context = reinterpret_cast<UserUcontext*>(Address);
  std::memset(Context, 0, sizeof(*Context));
  auto& M = Context->mcontext;
  M.rdi = State.gregs[X86::REG_RDI];
  M.rsi = State.gregs[X86::REG_RSI];
  M.rdx = State.gregs[X86::REG_RDX];
  M.rcx = State.gregs[X86::REG_RCX];
  M.r8 = State.gregs[X86::REG_R8];
  M.r9 = State.gregs[X86::REG_R9];
  M.rax = State.gregs[X86::REG_RAX];
  M.rbx = State.gregs[X86::REG_RBX];
  M.rbp = State.gregs[X86::REG_RBP];
  M.r10 = State.gregs[X86::REG_R10];
  M.r11 = State.gregs[X86::REG_R11];
  M.r12 = State.gregs[X86::REG_R12];
  M.r13 = State.gregs[X86::REG_R13];
  M.r14 = State.gregs[X86::REG_R14];
  M.r15 = State.gregs[X86::REG_R15];
  M.rsp = State.gregs[X86::REG_RSP];
  M.rip = Rip;
  M.rflags = Eflags;
  M.cs = 0x43; // FreeBSD's user code and stack selectors
  M.ss = 0x3b;
  M.len = sizeof(UserMcontext);
  M.fpformat = 0x10002; // _MC_FPFMT_XMM
  M.ownedfp = 0x20001;  // _MC_FPOWNED_PCB
  auto* Fx = reinterpret_cast<std::uint8_t*>(M.fpstate);
  const std::uint16_t ControlWord = 0x37f;
  const std::uint32_t MxcsrMask = 0xffbf;
  std::memcpy(Fx, &ControlWord, sizeof(ControlWord));
  std::memcpy(Fx + 24, &State.mxcsr, sizeof(State.mxcsr));
  std::memcpy(Fx + 28, &MxcsrMask, sizeof(MxcsrMask));
  for (int Index = 0; Index < 8; ++Index) {
    std::memcpy(Fx + 32 + Index * 16, State.mm[Index], 10);
  }
  for (int Index = 0; Index < 16; ++Index) {
    std::memcpy(Fx + 160 + Index * 16, State.xmm.sse.data[Index], 16);
  }
  M.fsbase = State.fs_cached;
  M.gsbase = State.gs_cached;
  return Address;
}
void ReadExceptionContext(std::uint64_t Address, FexGuest::CPUState& State, std::uint32_t& Eflags) {
  namespace X86 = FexGuest::X86;
  const auto& M = reinterpret_cast<const UserUcontext*>(Address)->mcontext;
  State.gregs[X86::REG_RDI] = M.rdi;
  State.gregs[X86::REG_RSI] = M.rsi;
  State.gregs[X86::REG_RDX] = M.rdx;
  State.gregs[X86::REG_RCX] = M.rcx;
  State.gregs[X86::REG_R8] = M.r8;
  State.gregs[X86::REG_R9] = M.r9;
  State.gregs[X86::REG_RAX] = M.rax;
  State.gregs[X86::REG_RBX] = M.rbx;
  State.gregs[X86::REG_RBP] = M.rbp;
  State.gregs[X86::REG_R10] = M.r10;
  State.gregs[X86::REG_R11] = M.r11;
  State.gregs[X86::REG_R12] = M.r12;
  State.gregs[X86::REG_R13] = M.r13;
  State.gregs[X86::REG_R14] = M.r14;
  State.gregs[X86::REG_R15] = M.r15;
  State.gregs[X86::REG_RSP] = M.rsp;
  State.rip = M.rip;
  Eflags = static_cast<std::uint32_t>(M.rflags);
}
} // namespace

namespace GuestThreads {

const std::pair<const char*, FexGuest::Thunk> Functions[] = {
  {"pthread_create", SysV::Thunk<&PosixCreate>},
  {"pthread_join", SysV::Thunk<&Join>},
  {"pthread_detach", SysV::Thunk<&Detach>},
  {"pthread_self", SysV::Thunk<&SelfHandle>},
  {"pthread_equal", SysV::Thunk<&Equal>},
  {"pthread_exit", SysV::Thunk<&Exit>},
  {"pthread_once", SysV::Thunk<&Once>},
  {"pthread_key_create", SysV::Thunk<&KeyCreate>},
  {"pthread_key_delete", SysV::Thunk<&KeyDelete>},
  {"pthread_getspecific", SysV::Thunk<&GetSpecific>},
  {"pthread_setspecific", SysV::Thunk<&SetSpecific>},
  {"pthread_mutex_init", SysV::Thunk<&MutexInit>},
  {"pthread_mutex_destroy", SysV::Thunk<&MutexDestroy>},
  {"pthread_mutex_lock", SysV::Thunk<&MutexLock>},
  {"pthread_mutex_trylock", SysV::Thunk<&MutexTrylock>},
  {"pthread_mutex_unlock", SysV::Thunk<&MutexUnlock>},
  {"pthread_mutex_isowned_np", SysV::Thunk<&PosixMutexIsowned>},
  {"pthread_mutex_timedlock", SysV::Thunk<&MutexTimedlock>},
  {"pthread_mutexattr_init", SysV::Thunk<&MutexattrInit>},
  {"pthread_mutexattr_destroy", SysV::Thunk<&MutexattrDestroy>},
  {"pthread_mutexattr_settype", SysV::Thunk<&MutexattrSettype>},
  {"pthread_mutexattr_gettype", SysV::Thunk<&MutexattrGettype>},
  {"pthread_mutexattr_setprotocol", SysV::Thunk<&MutexattrSetprotocol>},
  {"pthread_mutexattr_getprotocol", SysV::Thunk<&MutexattrGetprotocol>},
  {"pthread_mutexattr_setpshared", SysV::Thunk<&MutexattrSetpshared>},
  {"pthread_cond_init", SysV::Thunk<&CondInit>},
  {"pthread_cond_destroy", SysV::Thunk<&CondDestroy>},
  {"pthread_cond_wait", SysV::Thunk<&CondWait>},
  {"pthread_cond_timedwait", SysV::Thunk<&CondTimedwait>},
  {"pthread_cond_signal", SysV::Thunk<&CondSignal>},
  {"pthread_cond_broadcast", SysV::Thunk<&CondBroadcast>},
  {"pthread_condattr_init", SysV::Thunk<&CondattrInit>},
  {"pthread_condattr_destroy", SysV::Thunk<&CondattrDestroy>},
  {"pthread_condattr_setclock", SysV::Thunk<&CondattrSetclock>},
  {"pthread_condattr_getclock", SysV::Thunk<&CondattrGetclock>},
  {"pthread_rwlock_init", SysV::Thunk<&RwlockInit>},
  {"pthread_rwlock_destroy", SysV::Thunk<&RwlockDestroy>},
  {"pthread_rwlock_rdlock", SysV::Thunk<&RwlockRdlock>},
  {"pthread_rwlock_wrlock", SysV::Thunk<&RwlockWrlock>},
  {"pthread_rwlock_tryrdlock", SysV::Thunk<&RwlockTryrdlock>},
  {"pthread_rwlock_trywrlock", SysV::Thunk<&RwlockTrywrlock>},
  {"pthread_rwlock_unlock", SysV::Thunk<&RwlockUnlock>},
  {"pthread_rwlockattr_init", SysV::Thunk<&RwlockattrInit>},
  {"pthread_rwlockattr_destroy", SysV::Thunk<&RwlockattrDestroy>},
  {"pthread_attr_init", SysV::Thunk<&AttrInit>},
  {"pthread_attr_destroy", SysV::Thunk<&AttrDestroy>},
  {"pthread_attr_setstacksize", SysV::Thunk<&AttrSetstacksize>},
  {"pthread_attr_getstacksize", SysV::Thunk<&AttrGetstacksize>},
  {"pthread_attr_setguardsize", SysV::Thunk<&AttrSetguardsize>},
  {"pthread_attr_getguardsize", SysV::Thunk<&AttrGetguardsize>},
  {"pthread_attr_setdetachstate", SysV::Thunk<&AttrSetdetachstate>},
  {"pthread_attr_getdetachstate", SysV::Thunk<&AttrGetdetachstate>},
  {"pthread_attr_setinheritsched", SysV::Thunk<&AttrSetinheritsched>},
  {"pthread_attr_getinheritsched", SysV::Thunk<&AttrGetinheritsched>},
  {"pthread_attr_setschedpolicy", SysV::Thunk<&AttrSetschedpolicy>},
  {"pthread_attr_getschedpolicy", SysV::Thunk<&AttrGetschedpolicy>},
  {"pthread_attr_setschedparam", SysV::Thunk<&AttrSetschedparam>},
  {"pthread_attr_getschedparam", SysV::Thunk<&AttrGetschedparam>},
  {"pthread_attr_get_np", SysV::Thunk<&AttrGet>},
  {"pthread_getthreadid_np", SysV::Thunk<&Getthreadid>},
  {"pthread_set_name_np", SysV::Thunk<&PosixSetnameNp>},
  {"pthread_setname_np", SysV::Thunk<&PosixSetnameNp>},
  {"pthread_getname_np", SysV::Thunk<&GetnameNp>},
  {"pthread_set_defaultstacksize_np", SysV::Thunk<&SetDefaultstacksize>},
  {"sched_yield", SysV::Thunk<&Yield>},
  {"scePthreadCreate", SysV::Thunk<&SceCreate>},
  {"scePthreadJoin", SysV::Thunk<&SceOf<&Join, std::uint64_t, std::uint64_t*>>},
  {"scePthreadDetach", SysV::Thunk<&SceOf<&Detach, std::uint64_t>>},
  {"scePthreadSelf", SysV::Thunk<&SelfHandle>},
  {"scePthreadEqual", SysV::Thunk<&Equal>},
  {"scePthreadExit", SysV::Thunk<&Exit>},
  {"scePthreadOnce", SysV::Thunk<&SceOf<&Once, std::int32_t*, std::uint64_t>>},
  {"scePthreadKeyCreate", SysV::Thunk<&SceOf<&KeyCreate, std::uint32_t*, std::uint64_t>>},
  {"scePthreadKeyDelete", SysV::Thunk<&SceOf<&KeyDelete, std::uint32_t>>},
  {"scePthreadGetspecific", SysV::Thunk<&SceGetspecific>},
  {"scePthreadSetspecific", SysV::Thunk<&SceOf<&SetSpecific, std::uint32_t, std::uint64_t>>},
  {"scePthreadMutexInit", SysV::Thunk<&SceMutexInit>},
  {"scePthreadMutexDestroy", SysV::Thunk<&SceOf<&MutexDestroy, std::uint64_t*>>},
  {"scePthreadMutexLock", SysV::Thunk<&SceOf<&MutexLock, std::uint64_t*>>},
  {"scePthreadMutexTrylock", SysV::Thunk<&SceOf<&MutexTrylock, std::uint64_t*>>},
  {"scePthreadMutexUnlock", SysV::Thunk<&SceOf<&MutexUnlock, std::uint64_t*>>},
  {"scePthreadMutexIsowned", SysV::Thunk<&SceMutexIsowned>},
  {"scePthreadMutexTimedlock", SysV::Thunk<&SceMutexTimedlock>},
  {"scePthreadMutexattrInit", SysV::Thunk<&SceOf<&MutexattrInit, std::uint64_t*>>},
  {"scePthreadMutexattrDestroy", SysV::Thunk<&SceOf<&MutexattrDestroy, std::uint64_t*>>},
  {"scePthreadMutexattrSettype", SysV::Thunk<&SceOf<&MutexattrSettype, std::uint64_t*, int>>},
  {"scePthreadMutexattrGettype", SysV::Thunk<&SceOf<&MutexattrGettype, const std::uint64_t*, int*>>},
  {"scePthreadMutexattrSetprotocol", SysV::Thunk<&SceOf<&MutexattrSetprotocol, std::uint64_t*, int>>},
  {"scePthreadMutexattrGetprotocol", SysV::Thunk<&SceOf<&MutexattrGetprotocol, const std::uint64_t*, int*>>},
  {"scePthreadCondInit", SysV::Thunk<&SceCondInit>},
  {"scePthreadCondDestroy", SysV::Thunk<&SceOf<&CondDestroy, std::uint64_t*>>},
  {"scePthreadCondWait", SysV::Thunk<&SceOf<&CondWait, std::uint64_t*, std::uint64_t*>>},
  {"scePthreadCondTimedwait", SysV::Thunk<&SceCondTimedwait>},
  {"scePthreadCondSignal", SysV::Thunk<&SceOf<&CondSignal, std::uint64_t*>>},
  {"scePthreadCondBroadcast", SysV::Thunk<&SceOf<&CondBroadcast, std::uint64_t*>>},
  {"scePthreadCondattrInit", SysV::Thunk<&SceOf<&CondattrInit, std::uint64_t*>>},
  {"scePthreadCondattrDestroy", SysV::Thunk<&SceOf<&CondattrDestroy, std::uint64_t*>>},
  {"scePthreadCondattrSetclock", SysV::Thunk<&SceOf<&CondattrSetclock, std::uint64_t*, int>>},
  {"scePthreadCondattrGetclock", SysV::Thunk<&SceOf<&CondattrGetclock, const std::uint64_t*, int*>>},
  {"scePthreadRwlockInit", SysV::Thunk<&SceRwlockInit>},
  {"scePthreadRwlockDestroy", SysV::Thunk<&SceOf<&RwlockDestroy, std::uint64_t*>>},
  {"scePthreadRwlockRdlock", SysV::Thunk<&SceOf<&RwlockRdlock, std::uint64_t*>>},
  {"scePthreadRwlockWrlock", SysV::Thunk<&SceOf<&RwlockWrlock, std::uint64_t*>>},
  {"scePthreadRwlockTryrdlock", SysV::Thunk<&SceOf<&RwlockTryrdlock, std::uint64_t*>>},
  {"scePthreadRwlockTrywrlock", SysV::Thunk<&SceOf<&RwlockTrywrlock, std::uint64_t*>>},
  {"scePthreadRwlockUnlock", SysV::Thunk<&SceOf<&RwlockUnlock, std::uint64_t*>>},
  {"scePthreadRwlockTimedrdlock", SysV::Thunk<&SceRwlockTimedrdlock>},
  {"scePthreadRwlockTimedwrlock", SysV::Thunk<&SceRwlockTimedwrlock>},
  {"scePthreadRwlockattrInit", SysV::Thunk<&SceOf<&RwlockattrInit, std::uint64_t*>>},
  {"scePthreadRwlockattrDestroy", SysV::Thunk<&SceOf<&RwlockattrDestroy, std::uint64_t*>>},
  {"scePthreadAttrInit", SysV::Thunk<&SceOf<&AttrInit, std::uint64_t*>>},
  {"scePthreadAttrDestroy", SysV::Thunk<&SceOf<&AttrDestroy, std::uint64_t*>>},
  {"scePthreadAttrSetstacksize", SysV::Thunk<&SceOf<&AttrSetstacksize, std::uint64_t*, std::uint64_t>>},
  {"scePthreadAttrGetstacksize", SysV::Thunk<&SceOf<&AttrGetstacksize, const std::uint64_t*, std::uint64_t*>>},
  {"scePthreadAttrSetguardsize", SysV::Thunk<&SceOf<&AttrSetguardsize, std::uint64_t*, std::uint64_t>>},
  {"scePthreadAttrGetguardsize", SysV::Thunk<&SceOf<&AttrGetguardsize, const std::uint64_t*, std::uint64_t*>>},
  {"scePthreadAttrSetdetachstate", SysV::Thunk<&SceOf<&AttrSetdetachstate, std::uint64_t*, int>>},
  {"scePthreadAttrGetdetachstate", SysV::Thunk<&SceOf<&AttrGetdetachstate, const std::uint64_t*, int*>>},
  {"scePthreadAttrSetinheritsched", SysV::Thunk<&SceOf<&AttrSetinheritsched, std::uint64_t*, int>>},
  {"scePthreadAttrGetinheritsched", SysV::Thunk<&SceOf<&AttrGetinheritsched, const std::uint64_t*, int*>>},
  {"scePthreadAttrSetschedpolicy", SysV::Thunk<&SceOf<&AttrSetschedpolicy, std::uint64_t*, int>>},
  {"scePthreadAttrGetschedpolicy", SysV::Thunk<&SceOf<&AttrGetschedpolicy, const std::uint64_t*, int*>>},
  {"scePthreadAttrSetschedparam", SysV::Thunk<&SceOf<&AttrSetschedparam, std::uint64_t*, const int*>>},
  {"scePthreadAttrGetschedparam", SysV::Thunk<&SceOf<&AttrGetschedparam, const std::uint64_t*, int*>>},
  {"scePthreadAttrSetaffinity", SysV::Thunk<&SceOf<&AttrSetaffinity, std::uint64_t*, std::uint64_t>>},
  {"scePthreadAttrGetaffinity", SysV::Thunk<&SceOf<&AttrGetaffinity, const std::uint64_t*, std::uint64_t*>>},
  {"scePthreadAttrGet", SysV::Thunk<&SceOf<&AttrGet, std::uint64_t, std::uint64_t*>>},
  {"scePthreadGetthreadid", SysV::Thunk<&Getthreadid>},
  {"scePthreadSetprio", SysV::Thunk<&SceOf<&Setprio, std::uint64_t, int>>},
  {"scePthreadGetprio", SysV::Thunk<&SceOf<&Getprio, std::uint64_t, int*>>},
  {"scePthreadSetschedparam", SysV::Thunk<&SceOf<&Setschedparam, std::uint64_t, int, const int*>>},
  {"scePthreadGetschedparam", SysV::Thunk<&SceOf<&Getschedparam, std::uint64_t, int*, int*>>},
  {"pthread_setschedparam", SysV::Thunk<&Setschedparam>},
  {"pthread_getschedparam", SysV::Thunk<&Getschedparam>},
  {"scePthreadSetaffinity", SysV::Thunk<&SceOf<&Setaffinity, std::uint64_t, std::uint64_t>>},
  {"scePthreadGetaffinity", SysV::Thunk<&SceOf<&Getaffinity, std::uint64_t, std::uint64_t*>>},
  {"scePthreadRename", SysV::Thunk<&SceOf<&Rename, std::uint64_t, const char*>>},
  {"scePthreadGetname", SysV::Thunk<&SceOf<&Getname, std::uint64_t, char*>>},
  {"scePthreadYield", SysV::Thunk<&Yield>},
  {"scePthreadSetDefaultstacksize", SysV::Thunk<&SceOf<&SetDefaultstacksize, std::uint64_t>>},
  {"pthread_attr_setstackaddr", SysV::Thunk<&AttrSetstackaddr>},
  {"pthread_attr_getstackaddr", SysV::Thunk<&AttrGetstackaddr>},
  {"pthread_attr_getstack", SysV::Thunk<&AttrGetstack>},
  {"scePthreadAttrSetstackaddr", SysV::Thunk<&SceOf<&AttrSetstackaddr, std::uint64_t*, std::uint64_t>>},
  {"scePthreadAttrGetstackaddr", SysV::Thunk<&SceOf<&AttrGetstackaddr, const std::uint64_t*, std::uint64_t*>>},
  {"scePthreadAttrGetstack", SysV::Thunk<&SceOf<&AttrGetstack, const std::uint64_t*, std::uint64_t*, std::uint64_t*>>},
  {"sceKernelInstallExceptionHandler", SysV::Thunk<&InstallExceptionHandler>},
  {"sceKernelRemoveExceptionHandler", SysV::Thunk<&RemoveExceptionHandler>},
  {"sceKernelRaiseException", SysV::Thunk<&RaiseException>},
};
const std::size_t FunctionCount = std::size(Functions);

bool OwnsExport(const char* Name) {
  const std::string_view View(Name);
  return View.starts_with("scePthread") || View.starts_with("pthread_");
}

// A host thread that calls a guest function (a library's own worker running a callback the game registered) gets a
// thread record, static TLS and a guest stack on its first call, as a thread the guest creates does, and keeps them
// until it exits.
struct HostAdoption {
  std::pair<std::uint64_t, std::uint64_t> Stack {};
  ~HostAdoption() {
    if (Stack.second) {
      ReturnStack(Stack);
    }
  }
};
thread_local HostAdoption Adoption;
void AdoptHostThread() {
  // A thread this layer started with a host entry already has its record and static TLS.
  auto* T = Self;
  if (!T) {
    T = new Thread;
    T->Id = NextThreadId.fetch_add(1);
    T->Name = "host";
    T->Detached = true;
    T->ThreadPointer = Ps5::AllocateStaticTls();
    reinterpret_cast<std::uint64_t*>(T->ThreadPointer)[2] = reinterpret_cast<std::uint64_t>(T);
    Self = T;
    FexGuest::ThreadException = &T->Exception;
    std::lock_guard Lock(T->Lock);
    T->Host = pthread_self();
    T->Started = true;
  }
  Adoption.Stack = TakeStack(std::max(T->Settings.StackSize, MinimumStackSize));
  T->Settings.StackAddr = Adoption.Stack.first;
  T->Settings.StackSize = Adoption.Stack.second;
  FexGuest::AdoptCallingThread(Adoption.Stack.first + Adoption.Stack.second, T->ThreadPointer);
}

void AdoptInitialThread(std::uint64_t ThreadPointer) {
  FexGuest::AdoptHostThread = AdoptHostThread;
  Self = &InitialThread;
  InitialThread.ThreadPointer = ThreadPointer;
  InitialThread.Name = "main";
  reinterpret_cast<std::uint64_t*>(ThreadPointer)[2] = reinterpret_cast<std::uint64_t>(&InitialThread);
  FexGuest::ThreadException = &InitialThread.Exception;
  FexGuest::WriteExceptionContext = WriteExceptionContext;
  FexGuest::ReadExceptionContext = ReadExceptionContext;
  std::lock_guard Lock(InitialThread.Lock);
  InitialThread.Host = pthread_self();
  InitialThread.Started = true;
}

void SetInitialStack(std::uint64_t Base, std::uint64_t Size) {
  InitialThread.Settings.StackAddr = Base;
  InitialThread.Settings.StackSize = Size;
}

} // namespace GuestThreads

// libkernel's DirectMemory asks these before it changes a range's protection (prx/libkernel/Pthread/include/Pthread.hpp).
// The guest thread stacks are this layer's, and guest code never runs on a host thread's stack here.
bool GuestThreadStack(std::uintptr_t Address, std::uintptr_t* Start, std::uintptr_t* End) {
  std::lock_guard Lock(StackMutex);
  for (const auto& [Base, Size] : AllStacks) {
    if (Address >= Base && Address < Base + Size) {
      *Start = Base;
      *End = Base + Size;
      return true;
    }
  }
  return false;
}
// AnyPS5's own arm64 code calls some thread exports directly instead of through a guest import: libkernel's
// sceKernelWaitSema orders a priority queue by scePthreadGetprio(scePthreadSelf()), and libSceLibcInternal registers
// its thread_local destructor runner with sceKernelSetThreadDtors. These answer from this layer's records.
extern "C" std::uint64_t scePthreadSelf() {
  return SelfHandle();
}
extern "C" int scePthreadGetprio(std::uint64_t Handle, int* Priority) {
  return SceOf<&Getprio, std::uint64_t, int*>(Handle, Priority);
}
extern "C" void sceKernelSetThreadDtors(void (*Dtors)()) {
  ThreadDtors.store(Dtors, std::memory_order_release);
}

// The rest of the thread exports AnyPS5's arm64 libraries call directly (libSceJson2's kernel mutex, libSceNpCommon's
// mutexes, conditions and threads, libSceNet's sync objects, libc's _Mtx* and _Cnd*): the same records and results as
// the guest's imports of them. A thread created with a host entry runs it natively.
extern "C" {
int scePthreadMutexattrInit(std::uint64_t* Attributes) {
  return SceOf<&MutexattrInit, std::uint64_t*>(Attributes);
}
int scePthreadMutexattrDestroy(std::uint64_t* Attributes) {
  return SceOf<&MutexattrDestroy, std::uint64_t*>(Attributes);
}
int scePthreadMutexattrSettype(std::uint64_t* Attributes, int Type) {
  return SceOf<&MutexattrSettype, std::uint64_t*, int>(Attributes, Type);
}
int scePthreadMutexInit(std::uint64_t* Slot, const std::uint64_t* Attributes, const char* Name) {
  return SceMutexInit(Slot, Attributes, Name);
}
int scePthreadMutexDestroy(std::uint64_t* Slot) {
  return SceOf<&MutexDestroy, std::uint64_t*>(Slot);
}
int scePthreadMutexLock(std::uint64_t* Slot) {
  return SceOf<&MutexLock, std::uint64_t*>(Slot);
}
int scePthreadMutexTrylock(std::uint64_t* Slot) {
  return SceOf<&MutexTrylock, std::uint64_t*>(Slot);
}
int scePthreadMutexUnlock(std::uint64_t* Slot) {
  return SceOf<&MutexUnlock, std::uint64_t*>(Slot);
}
int pthread_mutex_lock_nid_postfix(std::uint64_t* Slot) {
  return MutexLock(Slot);
}
int pthread_mutex_unlock_nid_postfix(std::uint64_t* Slot) {
  return MutexUnlock(Slot);
}
int pthread_mutex_destroy_nid_postfix(std::uint64_t* Slot) {
  return MutexDestroy(Slot);
}
int scePthreadCondattrInit(std::uint64_t* Attributes) {
  return SceOf<&CondattrInit, std::uint64_t*>(Attributes);
}
int scePthreadCondattrDestroy(std::uint64_t* Attributes) {
  return SceOf<&CondattrDestroy, std::uint64_t*>(Attributes);
}
int scePthreadCondInit(std::uint64_t* Slot, const std::uint64_t* Attributes, const char* Name) {
  return SceCondInit(Slot, Attributes, Name);
}
int scePthreadCondDestroy(std::uint64_t* Slot) {
  return SceOf<&CondDestroy, std::uint64_t*>(Slot);
}
int scePthreadCondWait(std::uint64_t* Slot, std::uint64_t* MutexSlot) {
  return SceOf<&CondWait, std::uint64_t*, std::uint64_t*>(Slot, MutexSlot);
}
int scePthreadCondTimedwait(std::uint64_t* Slot, std::uint64_t* MutexSlot, std::uint32_t Microseconds) {
  return SceCondTimedwait(Slot, MutexSlot, Microseconds);
}
int scePthreadCondSignal(std::uint64_t* Slot) {
  return SceOf<&CondSignal, std::uint64_t*>(Slot);
}
int scePthreadCondBroadcast(std::uint64_t* Slot) {
  return SceOf<&CondBroadcast, std::uint64_t*>(Slot);
}
// Signals the waiter on one thread: every waiter wakes, and the others see a spurious wakeup, which a condition allows.
int scePthreadCondSignalto(std::uint64_t* Slot, std::uint64_t) {
  return SceOf<&CondBroadcast, std::uint64_t*>(Slot);
}
int scePthreadAttrInit(std::uint64_t* Attributes) {
  return SceOf<&AttrInit, std::uint64_t*>(Attributes);
}
int scePthreadAttrDestroy(std::uint64_t* Attributes) {
  return SceOf<&AttrDestroy, std::uint64_t*>(Attributes);
}
int scePthreadAttrSetstacksize(std::uint64_t* Attributes, std::uint64_t Size) {
  return SceOf<&AttrSetstacksize, std::uint64_t*, std::uint64_t>(Attributes, Size);
}
int scePthreadAttrSetinheritsched(std::uint64_t* Attributes, int Inherit) {
  return SceOf<&AttrSetinheritsched, std::uint64_t*, int>(Attributes, Inherit);
}
int scePthreadAttrSetschedpolicy(std::uint64_t* Attributes, int Policy) {
  return SceOf<&AttrSetschedpolicy, std::uint64_t*, int>(Attributes, Policy);
}
int scePthreadAttrSetschedparam(std::uint64_t* Attributes, const int* Parameter) {
  return SceOf<&AttrSetschedparam, std::uint64_t*, const int*>(Attributes, Parameter);
}
int scePthreadAttrSetaffinity(std::uint64_t* Attributes, std::uint64_t Mask) {
  return SceOf<&AttrSetaffinity, std::uint64_t*, std::uint64_t>(Attributes, Mask);
}
int scePthreadCreate(std::uint64_t* Out, const std::uint64_t* Attributes, std::uint64_t Entry, std::uint64_t Argument, const char* Name) {
  return SceCreateWith(Out, Attributes, Entry, Argument, Name, !(FexGuest::IsGuestCode && FexGuest::IsGuestCode(Entry)));
}
int scePthreadJoin(std::uint64_t Handle, std::uint64_t* Value) {
  return SceOf<&Join, std::uint64_t, std::uint64_t*>(Handle, Value);
}
int scePthreadEqual(std::uint64_t A, std::uint64_t B) {
  return Equal(A, B);
}
void scePthreadExit(std::uint64_t Value) {
  Exit(Value);
}
int scePthreadGetthreadid() {
  return Getthreadid();
}
void pthread_set_name_np_nid_postfix(std::uint64_t Handle, const char* Name) {
  PosixSetnameNp(Handle, Name);
}
int pthread_mutex_isowned_np_nid_postfix(std::uint64_t* Slot) {
  return PosixMutexIsowned(Slot);
}
// libkernel_sys's scePthreadSetDefaultstacksize and pthread_attr_setdefaultstacksize_np.
bool SetDefaultStackSize_nid_no_patch(std::size_t Size) {
  return SetDefaultstacksize(Size) == 0;
}
}

bool GuestThreadStackHostRangeOverlaps(std::uintptr_t, std::uintptr_t) {
  return false;
}
void NoteGuestStackProtection(std::uintptr_t, std::size_t, bool) {}
