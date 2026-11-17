// SPDX-License-Identifier: GPL-2.0-only
#include "GuestGdtoaPlatform.h"
#include "reentrant.h"
#include "gdtoa.h"

mutex_t __gdtoa_locks[2] = {PTHREAD_MUTEX_INITIALIZER, PTHREAD_MUTEX_INITIALIZER};
extern void __hexdig_init_D2A(void);
static pthread_once_t hexOnce = PTHREAD_ONCE_INIT;
static void InitializeHexDigits(void) { __hexdig_init_D2A(); }

int GuestGdtoaParse_nid_no_patch(const char* text, char** end, int rounding,
                              uint64_t* significand, uint16_t* signExponent) {
    const FPI format = {64, -16445, 16320, rounding, 0};
    ULong bits[2] = {0, 0};
    Long exponent = 0;
    pthread_once(&hexOnce, InitializeHexDigits);
    const int status = strtodg(text, end, &format, &exponent, bits, (locale_t)0);
    *significand = 0;
    *signExponent = 0;
    switch (status & STRTOG_Retmask) {
    case STRTOG_Denormal:
        *significand = (uint64_t)bits[0] | ((uint64_t)bits[1] << 32);
        break;
    case STRTOG_Normal:
    case STRTOG_NaNbits:
        *significand = (uint64_t)bits[0] | ((uint64_t)bits[1] << 32);
        *signExponent = (uint16_t)(exponent + 0x3fff + 63);
        break;
    case STRTOG_Infinite:
        *significand = UINT64_C(0x8000000000000000);
        *signExponent = 0x7fff;
        break;
    case STRTOG_NaN:
        *significand = UINT64_C(0xc000000000000000);
        *signExponent = 0x7fff;
        break;
    }
    if (status & STRTOG_Neg) *signExponent |= 0x8000;
    return status;
}
