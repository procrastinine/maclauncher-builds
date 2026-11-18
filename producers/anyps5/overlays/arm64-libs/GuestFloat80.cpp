// SPDX-License-Identifier: GPL-2.0-only
#include "prx/libc/include/GuestFloat80.hpp"

#if defined(__aarch64__)
#include <cerrno>
#include <new>

extern "C" int GuestGdtoaParse_nid_no_patch(const char*, char**, int, std::uint64_t*, std::uint16_t*);

namespace {
class NativeFloatEnvironment {
public:
    NativeFloatEnvironment() : savedErrno(errno) {
        asm volatile("mrs %0, fpcr\n\tmrs %1, fpsr\n\tmsr fpcr, xzr\n\tmsr fpsr, xzr"
                     : "=r"(control), "=r"(status) : : "memory");
    }
    ~NativeFloatEnvironment() {
        asm volatile("msr fpcr, %0\n\tmsr fpsr, %1" : : "r"(control), "r"(status) : "memory");
        errno = savedErrno;
    }
private:
    std::uint64_t control;
    std::uint64_t status;
    int savedErrno;
};
}

namespace GuestFloat {
Parsed Parse(const char* text, char** end, Round rounding) {
    NativeFloatEnvironment native;
    Parsed result{};
    result.status = static_cast<unsigned>(GuestGdtoaParse_nid_no_patch(text, end, static_cast<int>(rounding),
        &result.value.significand, &result.value.signExponent));
    if ((result.status & NoMemory) != 0) throw std::bad_alloc();
    return result;
}
}
#endif
