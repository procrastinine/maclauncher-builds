// SPDX-License-Identifier: GPL-2.0-only
#include "prx/libc/include/GuestThreadArm64.hpp"

#if defined(__aarch64__)

#include <atomic>
#include <limits>
#include <mutex>
#include <stdexcept>

namespace {
GuestThread::HostAccessors host;
std::atomic<bool> installed{false};
std::mutex installMutex;

const GuestThread::HostAccessors& Accessors() {
    if (!installed.load(std::memory_order_acquire)) throw std::logic_error("Guest thread host accessors are not installed");
    return host;
}
}

extern "C" void GuestThreadInstallHost_nid_no_patch(const GuestThread::HostAccessors* accessors) {
    if (accessors == nullptr || accessors->Bind == nullptr || accessors->Release == nullptr || accessors->Call == nullptr)
        throw std::invalid_argument("Guest thread host accessors are incomplete");
    std::lock_guard lock(installMutex);
    if (installed.load(std::memory_order_relaxed)) throw std::logic_error("Guest thread host accessors are already installed");
    host = *accessors;
    installed.store(true, std::memory_order_release);
}

namespace GuestThread {

Scope::Scope(std::uintptr_t stackLow, std::size_t stackBytes) {
    if (stackBytes < sizeof(std::uint64_t) || stackLow > std::numeric_limits<std::uintptr_t>::max() - stackBytes)
        throw std::invalid_argument("Guest thread stack range is invalid");
    binding = Accessors().Bind(stackLow, stackBytes);
    if (binding == nullptr) throw std::runtime_error("Guest thread host binding failed");
}

Scope::~Scope() {
    host.Release(binding);
}

std::uint64_t Call(std::uintptr_t entry, std::uint64_t arg0, std::uint64_t arg1) {
    if (entry == 0) throw std::invalid_argument("Guest thread entry is null");
    return Accessors().Call(entry, arg0, arg1);
}

}

#endif
