// SPDX-License-Identifier: GPL-2.0-only
using ExtendedFloat = GuestFloat::X87;
inline constexpr std::size_t GuestLongDoubleBytes = 16;
static_assert(sizeof(ExtendedFloat) == GuestLongDoubleBytes && sizeof(ExtendedFloat::significand) == 8);

inline ExtendedFloat GuestLongDoubleLoad(const void* source) { return GuestFloat::LoadSlot(source); }
inline void GuestLongDoubleStore(void* target, const ExtendedFloat& value) { GuestFloat::StoreSlot(target, value); }

inline bool FormatIsNan(const ExtendedFloat& value) {
    const auto exponent = value.signExponent & 0x7fff;
    return (exponent == 0x7fff && (value.significand & 0x7fffffffffffffffull) != 0) ||
           (exponent != 0 && (value.significand >> 63) == 0);
}
inline bool FormatFinite(const ExtendedFloat& value) {
    return (value.signExponent & 0x7fff) != 0x7fff && !FormatIsNan(value);
}
inline bool FormatNegative(const ExtendedFloat& value) { return value.Negative(); }
inline bool FormatZero(const ExtendedFloat& value) { return value.Zero(); }

template<class T> inline bool FormatIsNan(T value) { return std::isnan(value); }
template<class T> inline bool FormatFinite(T value) { return std::isfinite(value); }
template<class T> inline bool FormatNegative(T value) { return std::signbit(value); }

struct FormatExtendedParts {
    std::uint64_t mantissa;
    int binary;
};

inline FormatExtendedParts FormatDecompose(const ExtendedFloat& value) {
    if (value.significand == 0) return {0, 0};
    const auto exponent = value.signExponent & 0x7fff;
    const int shift = std::countl_zero(value.significand);
    return {value.significand << shift, (exponent != 0 ? exponent : 1) - 16383 + 1 - shift};
}

inline ExtendedFloat FormatFromDouble(double value) {
    const auto bits = std::bit_cast<std::uint64_t>(value);
    const auto sign = static_cast<std::uint16_t>((bits >> 48) & 0x8000);
    const unsigned field = static_cast<unsigned>((bits >> 52) & 0x7ff);
    auto fraction = bits & 0xfffffffffffffull;
    if (field == 0x7ff) return ExtendedFloat::Parts((fraction << 11) | 0x8000000000000000ull,
                                                  static_cast<std::uint16_t>(sign | 0x7fff));
    if (field == 0 && fraction == 0) return ExtendedFloat::Parts(0, sign);
    int exponent;
    if (field != 0) {
        fraction |= 0x10000000000000ull;
        exponent = static_cast<int>(field) - 1023;
    } else {
        const int shift = std::countl_zero(fraction) - 11;
        fraction <<= shift;
        exponent = -1022 - shift;
    }
    return ExtendedFloat::Parts(fraction << 11, static_cast<std::uint16_t>(sign | (exponent + 16383)));
}

inline double FormatNativeInfinity(const ExtendedFloat& value) {
    const double infinity = std::numeric_limits<double>::infinity();
    return value.Negative() ? -infinity : infinity;
}
