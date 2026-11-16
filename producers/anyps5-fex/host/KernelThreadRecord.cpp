// SPDX-License-Identifier: GPL-2.0-only
// libkernel's thread cancellation for a guest thread without a libkernel thread record.
//
// libkernel's ThreadCancel functions (prx/libkernel/Pthread/src/Thread.cpp) read the calling thread's record
// (PthreadPrivate) through CurrentGuestState().current. RunThread and the main-thread set-up create that record; until
// the arm64 libkernel with those functions links into this host, the guest's main thread has none. With no record,
// libkernel finds no cancellation request and registers no cancellable wait, which is what these definitions return.
// Thread.cpp itself is not compiled here: its guest entry is x86-64 assembly.
#include "prx/libkernel/Pthread/include/Cancel.hpp"

bool ThreadCancel::Requested() {
  return false;
}
void ThreadCancel::Check() {}
void ThreadCancel::BeginWait(TimedWait::Condition*) {}
void ThreadCancel::EndWait() {}
