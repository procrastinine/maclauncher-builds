// SPDX-License-Identifier: GPL-2.0-only
#ifndef CORE_LIBS_PRX_LIBC_INCLUDE_GUESTFLOAT80_HPP
#define CORE_LIBS_PRX_LIBC_INCLUDE_GUESTFLOAT80_HPP

#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <type_traits>

namespace GuestFloat {

struct alignas(16) X87 {
    std::uint64_t significand;
    std::uint16_t signExponent;
    std::uint8_t padding[6];

    static constexpr X87 Parts(std::uint64_t significand, std::uint16_t signExponent) {
        return {significand, signExponent, {}};
    }
    constexpr bool Zero() const { return significand == 0 && (signExponent & 0x7fff) == 0; }
    constexpr bool Subnormal() const { return significand != 0 && (signExponent & 0x7fff) == 0; }
    constexpr bool Negative() const { return (signExponent & 0x8000) != 0; }
};

static_assert(std::endian::native == std::endian::little);
static_assert(sizeof(X87) == 16 && alignof(X87) == 16);
static_assert(offsetof(X87, significand) == 0 && offsetof(X87, signExponent) == 8);
static_assert(std::is_standard_layout_v<X87> && std::is_trivially_copyable_v<X87>);

inline X87 Load80(const void* source) {
    X87 value{};
    std::memcpy(&value.significand, source, 8);
    std::memcpy(&value.signExponent, static_cast<const std::uint8_t*>(source) + 8, 2);
    return value;
}

inline void Store80(void* target, const X87& value) {
    std::memcpy(target, &value.significand, 8);
    std::memcpy(static_cast<std::uint8_t*>(target) + 8, &value.signExponent, 2);
}

inline X87 LoadSlot(const void* source) {
    X87 value;
    std::memcpy(&value, source, sizeof(value));
    return value;
}

inline void StoreSlot(void* target, const X87& value) { std::memcpy(target, &value, sizeof(value)); }

enum class Round : std::uint8_t { TowardZero = 0, NearestEven = 1, Up = 2, Down = 3 };
enum ParseStatus : unsigned {
    Zero = 0, Normal = 1, Subnormal = 2, Infinite = 3, Nan = 4, NanPayload = 5,
    NoNumber = 6, ClassMask = 7, Negative = 8, Inexact = 0x30,
    Underflow = 0x40, Overflow = 0x80, NoMemory = 0x100,
};

struct Parsed {
    X87 value;
    unsigned status;
};

Parsed Parse(const char* text, char** end, Round rounding);

}

#endif
