// SPDX-License-Identifier: GPL-2.0-only
#ifndef CORE_LIBS_PRX_LIBC_INCLUDE_GUESTCONTEXTARM64_HPP
#define CORE_LIBS_PRX_LIBC_INCLUDE_GUESTCONTEXTARM64_HPP

#include <cstddef>
#include <cstdint>

namespace GuestContext {

struct RegisterFrame {
    std::uint64_t rax;
    std::uint64_t rbx;
    std::uint64_t rcx;
    std::uint64_t rdx;
    std::uint64_t rsi;
    std::uint64_t rdi;
    std::uint64_t rbp;
    std::uint64_t rsp;
    std::uint64_t r8;
    std::uint64_t r9;
    std::uint64_t r10;
    std::uint64_t r11;
    std::uint64_t r12;
    std::uint64_t r13;
    std::uint64_t r14;
    std::uint64_t r15;
    std::uint64_t rip;
    std::uint64_t rflags;
    std::uint64_t cs;
    std::uint64_t ss;
    alignas(16) std::uint8_t fxsave[512];
};

static_assert(offsetof(RegisterFrame, rsp) == 0x38 && offsetof(RegisterFrame, rip) == 0x80);
static_assert(offsetof(RegisterFrame, fxsave) == 0xa0 && sizeof(RegisterFrame) == 0x2a0);

struct HostAccessors {
    void (*Capture)(RegisterFrame*);
    void (*Restore)(const RegisterFrame*);
};

struct Transfer {
    std::uint64_t rip;
    std::uint64_t rsp;
};

RegisterFrame Capture();
RegisterFrame CaptureCall();
[[noreturn]] void Restore(const RegisterFrame& frame);

}

extern "C" void GuestContextInstallHost_nid_no_patch(const GuestContext::HostAccessors* accessors);

#endif
