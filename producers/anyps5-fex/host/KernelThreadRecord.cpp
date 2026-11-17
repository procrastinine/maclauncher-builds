// SPDX-License-Identifier: GPL-2.0-only
// libkernel's thread cancellation and CPU clocks for a guest thread without a libkernel thread record.
//
// libkernel's ThreadCancel functions (prx/libkernel/Pthread/src/Thread.cpp) read the calling thread's record
// (PthreadPrivate) through CurrentGuestState().current. RunThread and the main-thread set-up create that record; until
// the arm64 libkernel with those functions links into this host, the guest's main thread has none. With no record,
// libkernel finds no cancellation request and registers no cancellable wait, and the CPU-clock registry holds no thread,
// which is what these definitions return.
// Thread.cpp itself is not compiled here: its guest entry is x86-64 assembly.
#include "prx/libkernel/Pthread/include/Cancel.hpp"
#include "prx/libkernel/Pthread/include/Pthread.hpp"

bool ThreadCancel::Requested() {
  return false;
}
void ThreadCancel::Check() {}
void ThreadCancel::BeginWait(TimedWait::Condition*) {}
void ThreadCancel::EndWait() {}

// Thread.cpp looks the id up among the registered threads' CPU clocks and returns false for an unknown one.
bool GuestThreadCpuNanos(int, std::uint64_t*) {
  return false;
}
