// SPDX-License-Identifier: GPL-2.0-only
#ifndef CORE_LIBS_PRX_LIBKERNEL_PTHREAD_GUESTTHREADSTACKARM64_HPP
#define CORE_LIBS_PRX_LIBKERNEL_PTHREAD_GUESTTHREADSTACKARM64_HPP

#include "prx/libkernel/DirectMemory/DirectMemory.hpp"
#include <exception>
#include <limits>
#include <stdexcept>

namespace GuestThread {

class MappedStack {
public:
    explicit MappedStack(std::size_t requestedBytes) {
        if (requestedBytes == 0 || requestedBytes > std::numeric_limits<std::size_t>::max() - 2 * PS5_PAGE_SIZE)
            throw std::invalid_argument("Guest thread stack size is invalid");
        usableBytes = requestedBytes;
        mappingBytes = ((requestedBytes + PS5_PAGE_SIZE - 1) & ~(PS5_PAGE_SIZE - 1)) + PS5_PAGE_SIZE;
        if (DoMapAnon(&mapping, mappingBytes, 3, 0) != 0)
            throw std::runtime_error("Cannot map the guest thread stack");
        if (DoMprotect(mapping, PS5_PAGE_SIZE, 0) != 0) {
            if (DoMunmap(mapping, mappingBytes) != 0) std::terminate();
            throw std::runtime_error("Cannot protect the guest thread stack guard");
        }
    }

    ~MappedStack() {
        if (DoMunmap(mapping, mappingBytes) != 0) std::terminate();
    }

    MappedStack(const MappedStack&) = delete;
    MappedStack& operator=(const MappedStack&) = delete;
    MappedStack(MappedStack&&) = delete;
    MappedStack& operator=(MappedStack&&) = delete;

    std::uintptr_t Low() const { return reinterpret_cast<std::uintptr_t>(mapping) + PS5_PAGE_SIZE; }
    std::size_t Bytes() const { return usableBytes; }

private:
    void* mapping = nullptr;
    std::size_t usableBytes;
    std::size_t mappingBytes;
};

}

#endif
