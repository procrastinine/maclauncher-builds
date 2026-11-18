// SPDX-License-Identifier: GPL-2.0-only
#include "prx/libc/include/GuestContextArm64.hpp"
#include "prx/libc/include/GuestCpu.hpp"
#include <cstring>

extern "C" {

[[gnu::returns_twice]] int APS5_VABI sigsetjmp_nid_postfix(std::uint64_t* buffer, int saveMask) {
    auto* bytes = reinterpret_cast<unsigned char*>(buffer);
    std::memcpy(bytes + 88, &saveMask, sizeof(saveMask));
    if (saveMask != 0) _sigprocmask_nid_postfix(1, nullptr, reinterpret_cast<GuestSignalSet*>(bytes + 72));
    const auto frame = GuestContext::CaptureCall();
    buffer[0] = frame.rip;
    buffer[1] = frame.rbx;
    buffer[2] = frame.rsp - sizeof(std::uint64_t);
    buffer[3] = frame.rbp;
    buffer[4] = frame.r12;
    buffer[5] = frame.r13;
    buffer[6] = frame.r14;
    buffer[7] = frame.r15;
    const auto control = GuestCpu::X87Control();
    std::memcpy(bytes + 64, &control, sizeof(control));
    return 0;
}

[[noreturn]] void APS5_VABI siglongjmp_nid_postfix(std::uint64_t* buffer, int value) {
    const auto* bytes = reinterpret_cast<const unsigned char*>(buffer);
    int saved;
    std::memcpy(&saved, bytes + 88, sizeof(saved));
    if (saved != 0) _sigprocmask_nid_postfix(3, reinterpret_cast<const GuestSignalSet*>(bytes + 72), nullptr);
    auto frame = GuestContext::Capture();
    frame.rax = static_cast<std::uint32_t>(value == 0 ? 1 : value);
    frame.rip = buffer[0];
    frame.rbx = buffer[1];
    frame.rsp = buffer[2] + sizeof(std::uint64_t);
    frame.rbp = buffer[3];
    frame.r12 = buffer[4];
    frame.r13 = buffer[5];
    frame.r14 = buffer[6];
    frame.r15 = buffer[7];
    std::uint16_t control;
    std::memcpy(&control, bytes + 64, sizeof(control));
    std::memcpy(frame.fxsave, &control, sizeof(control));
    GuestContext::Restore(frame);
}

}
