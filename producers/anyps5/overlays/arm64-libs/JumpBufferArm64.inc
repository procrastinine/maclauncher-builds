// SPDX-License-Identifier: GPL-2.0-only
#include "prx/libc/include/GuestContextArm64.hpp"
#include "prx/libc/include/GuestCpu.hpp"

namespace {

int SaveJump(std::uint64_t* buffer, bool saveMask) {
    const auto frame = GuestContext::CaptureCall();
    buffer[0] = frame.rip;
    buffer[1] = frame.rbx;
    buffer[2] = frame.rsp;
    buffer[3] = frame.rbp;
    buffer[4] = frame.r12;
    buffer[5] = frame.r13;
    buffer[6] = frame.r14;
    buffer[7] = frame.r15;
    const auto mxcsr = GuestCpu::Mxcsr();
    const auto control = GuestCpu::X87Control();
    auto* bytes = reinterpret_cast<unsigned char*>(buffer);
    std::memcpy(bytes + 64, &mxcsr, sizeof(mxcsr));
    std::memcpy(bytes + 68, &control, sizeof(control));
    if (saveMask) JumpBuffer::JumpBufferSaveMask_nid_no_patch(bytes);
    else {
        const std::int32_t saved = 0;
        std::memcpy(bytes + 88, &saved, sizeof(saved));
    }
    return 0;
}

[[noreturn]] void RestoreJump(std::uint64_t* buffer, int value, bool restoreMask) {
    const auto* bytes = reinterpret_cast<const unsigned char*>(buffer);
    if (restoreMask) JumpBuffer::JumpBufferRestoreMask_nid_no_patch(bytes);
    auto frame = GuestContext::Capture();
    frame.rax = static_cast<std::uint32_t>(value == 0 ? 1 : value);
    frame.rip = buffer[0];
    frame.rbx = buffer[1];
    frame.rsp = buffer[2];
    frame.rbp = buffer[3];
    frame.r12 = buffer[4];
    frame.r13 = buffer[5];
    frame.r14 = buffer[6];
    frame.r15 = buffer[7];
    std::uint32_t mxcsr;
    std::uint16_t control;
    std::memcpy(&mxcsr, bytes + 64, sizeof(mxcsr));
    std::memcpy(&control, bytes + 68, sizeof(control));
    if (!restoreMask) mxcsr = (mxcsr & ~0x3fu) | (GuestCpu::Mxcsr() & 0x3fu);
    std::memcpy(frame.fxsave, &control, sizeof(control));
    std::memcpy(frame.fxsave + 24, &mxcsr, sizeof(mxcsr));
    GuestContext::Restore(frame);
}

}

extern "C" {
[[gnu::returns_twice]] int APS5_VABI setjmp_nid_postfix(std::uint64_t* buffer) { return SaveJump(buffer, true); }
[[gnu::returns_twice]] int APS5_VABI _setjmp_nid_postfix(std::uint64_t* buffer) { return SaveJump(buffer, false); }
[[noreturn]] void APS5_VABI longjmp_nid_postfix(std::uint64_t* buffer, int value) { RestoreJump(buffer, value, true); }
[[noreturn]] void APS5_VABI _longjmp_nid_postfix(std::uint64_t* buffer, int value) { RestoreJump(buffer, value, false); }
}
