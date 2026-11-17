// SPDX-License-Identifier: GPL-2.0-only
// The FEX route's guest threads and their synchronization objects (GuestThreads.cpp).
#pragma once

#include "FexGuest.h"

#include <cstddef>
#include <utility>

namespace GuestThreads {

// Host functions for libkernel's POSIX and SCE thread, mutex, condition variable, read-write lock, once and
// thread-specific data exports, by export name.
extern const std::pair<const char*, FexGuest::Thunk> Functions[];
extern const std::size_t FunctionCount;

// Whether an export belongs to this layer's objects (scePthread*, pthread_*): a generated thunk of AnyPS5's own
// libkernel thread code would read its own thread records, so such exports bind here or to a logging stub.
bool OwnsExport(const char* Name);

// The calling OS thread runs the guest's initial thread, whose thread pointer is ThreadPointer.
void AdoptInitialThread(std::uint64_t ThreadPointer);

} // namespace GuestThreads
