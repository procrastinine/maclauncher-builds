// SPDX-License-Identifier: GPL-2.0-only
#include "prx/libc/include/GuestContextArm64.hpp"

#if defined(__aarch64__)

#include <atomic>
#include <cstring>
#include <mutex>
#include <stdexcept>

namespace {
GuestContext::HostAccessors host;
std::atomic<bool> installed{false};
std::mutex installMutex;

const GuestContext::HostAccessors& Accessors() {
    if (!installed.load(std::memory_order_acquire)) throw std::logic_error("Guest context host accessors are not installed");
    return host;
}
}

extern "C" void GuestContextInstallHost_nid_no_patch(const GuestContext::HostAccessors* accessors) {
    if (accessors == nullptr || accessors->Capture == nullptr || accessors->Restore == nullptr) {
        throw std::invalid_argument("Guest context host accessors are incomplete");
    }
    std::lock_guard lock(installMutex);
    if (installed.load(std::memory_order_relaxed)) throw std::logic_error("Guest context host accessors are already installed");
    host = *accessors;
    installed.store(true, std::memory_order_release);
}

namespace GuestContext {

RegisterFrame Capture() {
    RegisterFrame frame{};
    Accessors().Capture(&frame);
    return frame;
}

RegisterFrame CaptureCall() {
    RegisterFrame frame = Capture();
    std::memcpy(&frame.rip, reinterpret_cast<const void*>(frame.rsp), sizeof(frame.rip));
    frame.rsp += sizeof(frame.rip);
    return frame;
}

[[noreturn]] void Restore(const RegisterFrame& frame) {
    Accessors().Restore(&frame);
    throw Transfer{frame.rip, frame.rsp};
}

}

#endif
