// SPDX-License-Identifier: GPL-2.0-only
GuestFloat::Round GuestExtendedRounding() {
    switch ((GuestCpu::X87Control() >> 10) & 3) {
    case 1: return GuestFloat::Round::Down;
    case 2: return GuestFloat::Round::Up;
    case 3: return GuestFloat::Round::TowardZero;
    default: return GuestFloat::Round::NearestEven;
    }
}

GuestFloat::X87 FloatAsGuestExtended(float value) {
    const auto bits = std::bit_cast<std::uint32_t>(value);
    const auto sign = static_cast<std::uint16_t>((bits >> 16) & 0x8000);
    const unsigned field = (bits >> 23) & 0xff;
    std::uint32_t fraction = bits & 0x7fffff;
    if (field == 0 && fraction == 0) return GuestFloat::X87::Parts(0, sign);
    int exponent;
    if (field != 0) {
        fraction |= 0x800000;
        exponent = static_cast<int>(field) - 127;
    } else {
        const int shift = std::countl_zero(fraction) - 8;
        fraction <<= shift;
        exponent = -126 - shift;
    }
    return GuestFloat::X87::Parts(static_cast<std::uint64_t>(fraction) << 40,
        static_cast<std::uint16_t>(sign | (exponent + 16383)));
}

int CompareGuestExtendedMagnitude(const GuestFloat::X87& left, const GuestFloat::X87& right) {
    const auto le = left.signExponent & 0x7fff;
    const auto re = right.signExponent & 0x7fff;
    if (le != re) return le < re ? -1 : 1;
    return left.significand == right.significand ? 0 : left.significand < right.significand ? -1 : 1;
}

GuestFloat::X87 ParseGuestExtended(const char* text, char** end) {
    if (const NanSubject subject = FindNanSubject(text); subject.tail != nullptr) {
        const char* stop = subject.tail;
        const auto value = NanValue<GuestFloat::X87>(subject, stop);
        if (end != nullptr) *end = const_cast<char*>(stop);
        return value;
    }
    const int saved = errno;
    char* parsedEnd = nullptr;
    const auto parsed = GuestFloat::Parse(text, &parsedEnd, GuestExtendedRounding());
    if (end != nullptr) *end = parsedEnd;
    auto value = parsed.value;
    const char* subject = text;
    while (std::isspace(static_cast<unsigned char>(*subject))) ++subject;
    if (parsedEnd == text) {
        if (subject[0] != '-') return GuestFloat::X87::Parts(0, 0);
        const bool special = std::strchr("iInN", subject[1]) != nullptr && subject[1] != '\0';
        return GuestFloat::X87::Parts(0, !special ? 0x8000 : 0);
    }
    if ((parsed.status & (GuestFloat::Overflow | GuestFloat::Underflow)) != 0) errno = ERANGE;
    if (errno == ERANGE && value.Subnormal()) errno = saved;
    if (*subject == '+' || *subject == '-') ++subject;
    const bool hexadecimal = subject[0] == '0' && (subject[1] == 'x' || subject[1] == 'X') && parsedEnd > subject + 2;
    if (hexadecimal && errno == ERANGE) errno = saved;

    std::uint16_t flags = 0;
    if ((parsed.status & GuestFloat::Inexact) != 0) flags |= 0x20;
    if ((parsed.status & GuestFloat::Underflow) != 0) flags |= 0x10;
    if ((parsed.status & GuestFloat::Overflow) != 0) flags |= 0x08;
    if (flags != 0) {
        const auto control = GuestCpu::X87Control();
        auto status = static_cast<std::uint16_t>(GuestCpu::X87Status() | flags);
        if ((status & ~control & 0x3f) != 0) status |= 0x8080;
        GuestCpu::SetX87Status(status);
        GuestCpu::X87Wait();
    }
    return value;
}
