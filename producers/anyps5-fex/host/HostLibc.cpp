// SPDX-License-Identifier: GPL-2.0-only
// Host versions of AnyPS5 libc exports whose AnyPS5 source is x86-specific, for every host that links AnyPS5's arm64
// libraries (the start host links the objects whole, the proof takes what it references from their archive).
//
// Dinkumware's scaled decimal parsers (_Stodx, _Stofx, _Stoldx), which the wide-string conversions (_WStod and the
// others) call. DinkumwareInternals.cpp needs an 80-bit long double, which arm64 does not have, so they are written here
// the same way: parse, then parse again with the power-of-ten scale added to the exponent.

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <string>

extern "C" int* __error_nid_postfix();
extern "C" const char* NanSubjectEnd_nid_no_patch(const char* Text);
extern "C" double strtod_nid_postfix(const char* Text, char** End);
extern "C" float strtof_nid_postfix(const char* Text, char** End);
namespace Dinkumware {
constexpr long long ExponentLimit = 1000000000;
constexpr int RangeError = 34;
bool Hexadecimal(const char* Text) {
  while (std::isspace(static_cast<unsigned char>(*Text))) {
    ++Text;
  }
  if (*Text == '+' || *Text == '-') {
    ++Text;
  }
  return Text[0] == '0' && (Text[1] == 'x' || Text[1] == 'X');
}
template<typename T>
T Scaled(const char* Text, char** End, std::int64_t Pten, int* Error, T (*Parse)(const char*, char**)) {
  int& Errno = *__error_nid_postfix();
  const int Saved = Errno;
  if (Error) {
    *Error = 0;
  }
  if (const char* Stop = NanSubjectEnd_nid_no_patch(Text)) {
    if (End) {
      *End = const_cast<char*>(Stop);
    }
    return std::numeric_limits<T>::quiet_NaN();
  }
  Errno = 0;
  char* Stop = nullptr;
  T Value = Parse(Text, &Stop);
  if (End) {
    *End = Stop;
  }
  const bool Hex = Hexadecimal(Text);
  if (Pten == 0 && Hex) {
    Errno = Saved;
    return Value;
  }
  const bool Overflowed = std::isinf(Value) && Errno == RangeError;
  if (Pten != 0 && Stop != Text && (std::isfinite(Value) || Overflowed)) {
    const long long Scale = std::clamp<std::int64_t>(Pten, -ExponentLimit, ExponentLimit);
    if (Hex) {
      Errno = 0;
      Value = static_cast<T>(Value * std::pow(10.0L, static_cast<long double>(Scale)));
      if (std::isinf(Value) || Value == 0) {
        Errno = RangeError;
      }
    } else {
      std::string Number(Text, static_cast<const char*>(Stop));
      long long Exponent = 0;
      if (const auto Marker = Number.find_first_of("eE"); Marker != std::string::npos) {
        Exponent = std::strtoll(Number.c_str() + Marker + 1, nullptr, 10);
        Number.resize(Marker);
      }
      Exponent = std::clamp(Exponent, -ExponentLimit, ExponentLimit) + Scale;
      Number += 'e';
      Number += std::to_string(Exponent);
      Errno = 0;
      Value = Parse(Number.c_str(), nullptr);
    }
  }
  if (Errno == RangeError && (Value == 0 || std::isinf(Value))) {
    if (Error) {
      *Error = 1;
    }
  } else if (Errno == 0 || Errno == RangeError) {
    Errno = Saved;
  }
  return Value;
}
} // namespace Dinkumware

extern "C" {
double _Stodx_nid_postfix(const char* Text, char** End, std::int64_t Pten, int* Error) {
  return Dinkumware::Scaled<double>(Text, End, Pten, Error, strtod_nid_postfix);
}
float _Stofx_nid_postfix(const char* Text, char** End, std::int64_t Pten, int* Error) {
  return Dinkumware::Scaled<float>(Text, End, Pten, Error, strtof_nid_postfix);
}
// long double is double on arm64, as Api.hpp declares _Stoldx there.
long double _Stoldx_nid_postfix(const char* Text, char** End, std::int64_t Pten, int* Error) {
  return Dinkumware::Scaled<double>(Text, End, Pten, Error, strtod_nid_postfix);
}
}
