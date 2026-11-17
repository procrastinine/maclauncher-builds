// SPDX-License-Identifier: GPL-2.0-only
#include "prx/libc/include/GuestCpuArm64.hpp"

#if defined(__aarch64__)

#include <atomic>
#include <mutex>
#include <stdexcept>

namespace {
GuestCpu::HostAccessors host;
std::atomic<bool> installed{false};
std::mutex installMutex;
}

extern "C" void GuestCpuInstallHost_nid_no_patch(const GuestCpu::HostAccessors* accessors) {
    if (accessors == nullptr || accessors->ReadTsc == nullptr || accessors->Cpuid == nullptr ||
        accessors->Xgetbv == nullptr || accessors->Mxcsr == nullptr || accessors->SetMxcsr == nullptr ||
        accessors->X87Control == nullptr || accessors->SetX87Control == nullptr || accessors->X87Status == nullptr ||
        accessors->SetX87Status == nullptr || accessors->X87ClearExceptions == nullptr || accessors->X87Wait == nullptr ||
        accessors->MxcsrMask == nullptr || accessors->X87Environment == nullptr || accessors->SetX87Environment == nullptr ||
        accessors->RaiseInvalidForSignalingNan == nullptr) {
        throw std::invalid_argument("Guest CPU host accessors are incomplete");
    }
    std::lock_guard lock(installMutex);
    if (installed.load(std::memory_order_relaxed)) throw std::logic_error("Guest CPU host accessors are already installed");
    host = *accessors;
    installed.store(true, std::memory_order_release);
}

extern "C" const GuestCpu::HostAccessors& GuestCpuHost_nid_no_patch() {
    if (!installed.load(std::memory_order_acquire)) throw std::logic_error("Guest CPU host accessors are not installed");
    return host;
}

#endif
