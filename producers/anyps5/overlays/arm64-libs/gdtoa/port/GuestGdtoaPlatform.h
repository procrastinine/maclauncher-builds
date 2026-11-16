// SPDX-License-Identifier: GPL-2.0-only
#ifndef ANYPS5_GDTOA_PLATFORM_H
#define ANYPS5_GDTOA_PLATFORM_H
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <xlocale.h>
#define __LOCALE_T_DECLARED 1
#ifndef __UNCONST
#define __UNCONST(value) ((void*)(uintptr_t)(const void*)(value))
#endif
#ifndef __type_fit
// The generic overflow builtin checks representability in the destination
// type, including signed/unsigned boundaries, and evaluates value once.
#define __type_fit(type, value) __extension__ ({ \
    type anyps5_gdtoa_fit_value; \
    !__builtin_add_overflow((value), 0, &anyps5_gdtoa_fit_value); \
})
#endif
#ifndef _DIAGASSERT
static inline __attribute__((noreturn)) void AnyPS5GdtoaAssertionFailed(
        const char* condition, const char* file, int line) {
    fprintf(stderr, "gdtoa assertion failed: %s (%s:%d)\n", condition, file, line);
    abort();
}
// Keep the checked pointer-difference conversion active in release builds.
#define _DIAGASSERT(condition) ((condition) ? (void)0 : \
    AnyPS5GdtoaAssertionFailed(#condition, __FILE__, __LINE__))
#endif
#endif
