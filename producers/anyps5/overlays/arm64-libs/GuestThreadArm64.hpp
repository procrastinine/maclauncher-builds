// SPDX-License-Identifier: GPL-2.0-only
#ifndef CORE_LIBS_PRX_LIBC_INCLUDE_GUESTTHREADARM64_HPP
#define CORE_LIBS_PRX_LIBC_INCLUDE_GUESTTHREADARM64_HPP

#include <cstddef>
#include <cstdint>

namespace GuestThread {

struct HostAccessors {
    void* (*Bind)(std::uintptr_t stackLow, std::size_t stackBytes);
    void (*Release)(void* binding) noexcept;
    std::uint64_t (*Call)(std::uintptr_t entry, std::uint64_t arg0, std::uint64_t arg1);
};

class Scope {
public:
    Scope(std::uintptr_t stackLow, std::size_t stackBytes);
    ~Scope();
    Scope(const Scope&) = delete;
    Scope& operator=(const Scope&) = delete;
    Scope(Scope&&) = delete;
    Scope& operator=(Scope&&) = delete;

private:
    void* binding;
};

std::uint64_t Call(std::uintptr_t entry, std::uint64_t arg0, std::uint64_t arg1 = 0);

}

extern "C" void GuestThreadInstallHost_nid_no_patch(const GuestThread::HostAccessors* accessors);

#endif
