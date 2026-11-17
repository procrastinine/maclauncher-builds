// SPDX-License-Identifier: GPL-2.0-only
// Per-signature thunks from the x86-64 System V calling convention of PS5 game code to an arm64 library export.
// SysVThunk<Export> reads each argument of the export's C prototype from the guest state in System V order, calls the
// export as an ordinary arm64 call (so the arm64 compiler places register and stack arguments), and writes the result
// where System V returns it:
// - integer and pointer arguments: rdi, rsi, rdx, rcx, r8, r9, then the guest stack;
// - float and double arguments: xmm0-xmm7, then the guest stack, interleaved with integer stack arguments in order;
// - long double: an 80-bit x87 value in a 16-byte aligned guest stack slot; returned in st(0). On Apple arm64 long
//   double is a 64-bit double, so the thunk converts in both directions;
// - structs over 16 bytes: returned through a hidden pointer in rdi, which shifts the integer arguments by one, with
//   that pointer returned in rax;
// - structs of 16 bytes or less: each eightbyte in the next of rax/rdx (INTEGER) or xmm0/xmm1 (SSE), by the classes
//   that SysVEightbytes<T> gives; generated thunks take them from the classification of the prototype's type;
// - function pointer arguments: guest code addresses; the export receives a host function pointer that runs the
//   guest function under FEXCore (GuestFunction, through FexGuest::CallGuest).
// ThunkFor<Export>() is the thunk, or nullptr for a prototype these rules do not cover yet (by-value struct arguments,
// small struct returns without SysVEightbytes, variadic functions).
#pragma once

#include "FexGuest.h"

#include <algorithm>
#include <array>
#include <bit>
#include <utility>
#include <cmath>
#include <tuple>
#include <type_traits>

namespace SysV {
using FexGuest::After;
using FexGuest::CPUState;
namespace X86 = FexGuest::X86;

// 80-bit x87 extended precision <-> double.
inline double X87ToDouble(const void* Source) {
  std::uint64_t Mantissa;
  std::uint16_t SignExponent;
  std::memcpy(&Mantissa, Source, 8);
  std::memcpy(&SignExponent, static_cast<const std::uint8_t*>(Source) + 8, 2);
  const int Exponent = SignExponent & 0x7fff;
  double Result;
  if (Exponent == 0x7fff) {
    Result = (Mantissa << 1) != 0 ? NAN : INFINITY;
  } else if (Mantissa == 0) {
    Result = 0;
  } else {
    Result = std::ldexp(static_cast<double>(Mantissa), Exponent - 16383 - 63);
  }
  return (SignExponent & 0x8000) ? -Result : Result;
}

inline void DoubleToX87(double Value, void* Destination) {
  std::uint64_t Mantissa = 0;
  std::uint16_t SignExponent = std::signbit(Value) ? 0x8000 : 0;
  if (std::isnan(Value)) {
    SignExponent |= 0x7fff;
    Mantissa = 0xC000'0000'0000'0000ULL;
  } else if (std::isinf(Value)) {
    SignExponent |= 0x7fff;
    Mantissa = 0x8000'0000'0000'0000ULL;
  } else if (Value != 0) {
    int Exponent;
    const double Fraction = std::frexp(std::fabs(Value), &Exponent); // [0.5, 1)
    Mantissa = static_cast<std::uint64_t>(std::ldexp(Fraction, 64));
    SignExponent |= static_cast<std::uint16_t>(Exponent + 16382);
  }
  std::memcpy(Destination, &Mantissa, 8);
  std::memcpy(static_cast<std::uint8_t*>(Destination) + 8, &SignExponent, 2);
  std::memset(static_cast<std::uint8_t*>(Destination) + 10, 0, 6);
}

// Eightbyte classes of a struct of 16 bytes or less: 'I' for INTEGER, 'S' for SSE.
template<class T>
struct SysVEightbytes;

template<class T>
constexpr bool IsMemoryStruct = [] {
  if constexpr (std::is_class_v<T>) {
    return sizeof(T) > 16;
  } else {
    return false;
  }
}();

template<class T>
constexpr bool IsGuestFunctionPointer = std::is_pointer_v<T> && std::is_function_v<std::remove_pointer_t<T>>;

// Host function pointers that call guest functions of one signature: a fixed pool of slots per signature.
template<class F>
struct GuestFunction;

template<class R, class... A>
struct GuestFunction<R(A...)> {
  static constexpr std::size_t SlotCount = 32;
  static inline std::uint64_t Targets[SlotCount] {};

  static R Invoke(std::uint64_t Target, A... Values) {
    std::uint64_t Integers[sizeof...(A) + 1] {};
    double Floats[sizeof...(A) + 1] {};
    std::size_t Int = 0, Vector = 0;
    auto Add = [&](auto Value) {
      using T = decltype(Value);
      if constexpr (std::is_floating_point_v<T>) {
        Floats[Vector++] = static_cast<double>(Value);
      } else if constexpr (std::is_pointer_v<T>) {
        Integers[Int++] = reinterpret_cast<std::uint64_t>(Value);
      } else {
        Integers[Int++] = static_cast<std::uint64_t>(Value);
      }
    };
    (Add(Values), ...);
    const auto Result = FexGuest::CallGuest(Target, std::span<const std::uint64_t>(Integers, Int), std::span<const double>(Floats, Vector));
    if constexpr (std::is_void_v<R>) {
      return;
    } else if constexpr (std::is_floating_point_v<R>) {
      return static_cast<R>(std::bit_cast<double>(Result.Xmm0));
    } else if constexpr (std::is_pointer_v<R>) {
      return reinterpret_cast<R>(Result.Rax);
    } else {
      return static_cast<R>(Result.Rax);
    }
  }

  template<std::size_t N>
  static R Call(A... Values) {
    return Invoke(Targets[N], Values...);
  }

  template<std::size_t... N>
  static constexpr auto Table(std::index_sequence<N...>) {
    return std::array<R (*)(A...), SlotCount> {&Call<N>...};
  }

  static R (*Wrap(std::uint64_t Target))(A...) {
    if (Target == 0) {
      return nullptr;
    }
    static constexpr auto Calls = Table(std::make_index_sequence<SlotCount> {});
    for (std::size_t i = 0; i < SlotCount; ++i) {
      if (Targets[i] == Target || Targets[i] == 0) {
        Targets[i] = Target;
        return Calls[i];
      }
    }
    std::printf("more than %zu guest callbacks of one signature\nFAIL\n", SlotCount);
    std::exit(1);
  }
};

class Arguments {
public:
  explicit Arguments(CPUState& State)
    : State(State)
    , Stack(State.gregs[X86::REG_RSP] + 8) {}

  std::uint64_t Integer() {
    static constexpr int Registers[] = {X86::REG_RDI, X86::REG_RSI, X86::REG_RDX, X86::REG_RCX, X86::REG_R8, X86::REG_R9};
    return Int < 6 ? State.gregs[Registers[Int++]] : Memory8();
  }
  std::uint64_t Sse() {
    return Vector < 8 ? State.xmm.sse.data[Vector++][0] : Memory8();
  }
  double X87() {
    Stack = (Stack + 15) & ~15ULL;
    const double Result = X87ToDouble(reinterpret_cast<const void*>(Stack));
    Stack += 16;
    return Result;
  }

  template<class T>
  T Next() {
    if constexpr (std::is_same_v<T, long double>) {
      return X87();
    } else if constexpr (std::is_same_v<T, double>) {
      return std::bit_cast<double>(Sse());
    } else if constexpr (std::is_same_v<T, float>) {
      return std::bit_cast<float>(static_cast<std::uint32_t>(Sse()));
    } else if constexpr (IsGuestFunctionPointer<T>) {
      return GuestFunction<std::remove_pointer_t<T>>::Wrap(Integer());
    } else if constexpr (std::is_same_v<T, bool>) {
      return (Integer() & 0xff) != 0;
    } else if constexpr (std::is_integral_v<T> || std::is_enum_v<T>) {
      return static_cast<T>(Integer());
    } else if constexpr (std::is_pointer_v<T>) {
      return reinterpret_cast<T>(Integer());
    } else {
      static_assert(sizeof(T) == 0, "no System V argument class for this type");
    }
  }

  // Where va_start would leave a va_list after the arguments read so far.
  unsigned Integers() const {
    return Int;
  }
  unsigned Vectors() const {
    return Vector;
  }
  std::uint64_t StackArguments() const {
    return Stack;
  }

private:
  std::uint64_t Memory8() {
    std::uint64_t Value;
    std::memcpy(&Value, reinterpret_cast<const void*>(Stack), 8);
    Stack += 8;
    return Value;
  }

  CPUState& State;
  std::uint64_t Stack;
  unsigned Int = 0;
  unsigned Vector = 0;
};

template<class R>
After Store(CPUState& State, const R& Result, std::uint64_t Hidden) {
  if constexpr (IsMemoryStruct<R>) {
    std::memcpy(reinterpret_cast<void*>(Hidden), &Result, sizeof(R));
    State.gregs[X86::REG_RAX] = Hidden;
  } else if constexpr (std::is_same_v<R, long double>) {
    // The x87 return stub loads st(0) and performs the guest's RET.
    DoubleToX87(Result, FexGuest::X87ReturnSlot());
    State.rip = FexGuest::X87ReturnStub();
    return After::Continue;
  } else if constexpr (std::is_same_v<R, double>) {
    State.xmm.sse.data[0][0] = std::bit_cast<std::uint64_t>(Result);
    State.xmm.sse.data[0][1] = 0;
  } else if constexpr (std::is_same_v<R, float>) {
    State.xmm.sse.data[0][0] = std::bit_cast<std::uint32_t>(Result);
    State.xmm.sse.data[0][1] = 0;
  } else if constexpr (std::is_integral_v<R> || std::is_enum_v<R>) {
    State.gregs[X86::REG_RAX] = static_cast<std::uint64_t>(Result);
  } else if constexpr (std::is_pointer_v<R>) {
    State.gregs[X86::REG_RAX] = reinterpret_cast<std::uint64_t>(Result);
  } else if constexpr (std::is_class_v<R>) {
    std::uint64_t Words[2] {};
    std::memcpy(Words, &Result, sizeof(R));
    static constexpr int IntegerRegisters[] = {X86::REG_RAX, X86::REG_RDX};
    unsigned Int = 0, Vector = 0;
    for (unsigned i = 0; i < (sizeof(R) + 7) / 8; ++i) {
      if (SysVEightbytes<R>::Classes[i] == 'I') {
        State.gregs[IntegerRegisters[Int++]] = Words[i];
      } else {
        State.xmm.sse.data[Vector][0] = Words[i];
        State.xmm.sse.data[Vector++][1] = 0;
      }
    }
  } else {
    static_assert(sizeof(R) == 0, "no System V return class for this type");
  }
  return After::Return;
}

template<class R, class... A>
After Call(R (*Export)(A...), CPUState& State) {
  Arguments In(State);
  std::uint64_t Hidden = 0;
  if constexpr (IsMemoryStruct<R>) {
    Hidden = In.Integer();
  }
  // A braced initializer evaluates left to right, which is the System V argument order.
  std::tuple<A...> Values {In.template Next<A>()...};
  if constexpr (std::is_void_v<R>) {
    std::apply(Export, Values);
    return After::Return;
  } else {
    return Store(State, std::apply(Export, Values), Hidden);
  }
}

template<auto Export>
After Thunk(CPUState& State) {
  return Call(Export, State);
}

template<class F>
struct FunctionTraits;
template<class R, class... A>
struct FunctionTraits<R (*)(A...)> {
  using Parameters = std::tuple<A...>;
};
// noexcept is part of a function's type, and many AnyPS5 exports are declared noexcept.
template<class R, class... A>
struct FunctionTraits<R (*)(A...) noexcept> : FunctionTraits<R (*)(A...)> {};

// A variadic export runs as its va_list counterpart (snprintf as vsnprintf), whose last parameter points to a System V
// va_list. The thunk reads the fixed arguments as usual and passes a va_list that starts after them, as va_start would
// in the guest: the six argument registers and xmm0-xmm7 in a register save area, then the guest's stack arguments.
struct alignas(16) RegisterSaveArea {
  std::uint64_t Integers[6];
  std::uint64_t Vectors[8][2];
};
struct GuestVaList {
  std::uint32_t GpOffset;
  std::uint32_t FpOffset;
  std::uint64_t OverflowArgArea;
  std::uint64_t RegSaveArea;
};
static_assert(sizeof(RegisterSaveArea) == 176 && sizeof(GuestVaList) == 24);

template<class R, class... P, std::size_t... I>
After CallVariadic(R (*Export)(P...), CPUState& State, std::index_sequence<I...>) {
  using Parameters = std::tuple<P...>;
  using ListPointer = std::tuple_element_t<sizeof...(P) - 1, Parameters>;
  Arguments In(State);
  std::tuple<std::tuple_element_t<I, Parameters>...> Fixed {In.template Next<std::tuple_element_t<I, Parameters>>()...};
  static constexpr int Registers[] = {X86::REG_RDI, X86::REG_RSI, X86::REG_RDX, X86::REG_RCX, X86::REG_R8, X86::REG_R9};
  RegisterSaveArea Save;
  for (int i = 0; i < 6; ++i) {
    Save.Integers[i] = State.gregs[Registers[i]];
  }
  for (int i = 0; i < 8; ++i) {
    Save.Vectors[i][0] = State.xmm.sse.data[i][0];
    Save.Vectors[i][1] = State.xmm.sse.data[i][1];
  }
  GuestVaList List {std::min(In.Integers(), 6u) * 8, 48 + std::min(In.Vectors(), 8u) * 16, In.StackArguments(), reinterpret_cast<std::uint64_t>(&Save)};
  auto Run = [&](auto... Values) { return Export(Values..., reinterpret_cast<ListPointer>(&List)); };
  if constexpr (std::is_void_v<R>) {
    std::apply(Run, Fixed);
    return After::Return;
  } else {
    return Store(State, std::apply(Run, Fixed), 0);
  }
}

template<auto Export>
After VariadicThunk(CPUState& State) {
  return CallVariadic(Export, State, std::make_index_sequence<std::tuple_size_v<typename FunctionTraits<decltype(Export)>::Parameters> - 1> {});
}

template<class T>
constexpr bool SupportedArgument = std::is_arithmetic_v<T> || std::is_enum_v<T> || std::is_pointer_v<T>;

template<class R>
constexpr bool SupportedReturn = [] {
  if constexpr (std::is_void_v<R> || std::is_arithmetic_v<R> || std::is_enum_v<R> || std::is_pointer_v<R>) {
    return true;
  } else if constexpr (std::is_class_v<R>) {
    return IsMemoryStruct<R> || requires { SysVEightbytes<R>::Classes; };
  } else {
    return false;
  }
}();

template<class F>
struct Supported : std::false_type {};
template<class R, class... A>
struct Supported<R (*)(A...)> : std::bool_constant<SupportedReturn<R> && (SupportedArgument<A> && ...)> {};
template<class R, class... A>
struct Supported<R (*)(A...) noexcept> : Supported<R (*)(A...)> {};

// The variadic thunk for VaListExport, the va_list counterpart of a variadic export: its last parameter points to a
// 24-byte System V va_list and its other parameters are ones the thunks cover. nullptr otherwise.
template<class F>
struct SupportedVaList : std::false_type {};
template<class R, class... A>
struct SupportedVaList<R (*)(A...)> {
  using Last = std::tuple_element_t<sizeof...(A) - 1, std::tuple<A...>>;
  static constexpr bool value = [] {
    if constexpr (!std::is_pointer_v<Last>) {
      return false;
    } else if constexpr (!std::is_class_v<std::remove_pointer_t<Last>>) {
      return false;
    } else {
      return sizeof(std::remove_pointer_t<Last>) == sizeof(GuestVaList) && SupportedReturn<R> && (SupportedArgument<A> && ...);
    }
  }();
};
template<class R, class... A>
struct SupportedVaList<R (*)(A...) noexcept> : SupportedVaList<R (*)(A...)> {};

template<auto VaListExport>
constexpr FexGuest::Thunk VariadicThunkFor() {
  if constexpr (SupportedVaList<decltype(VaListExport)>::value) {
    return VariadicThunk<VaListExport>;
  } else {
    return nullptr;
  }
}

// The thunk for Export, or nullptr when its prototype needs a case the thunks do not cover yet.
template<auto Export>
constexpr FexGuest::Thunk ThunkFor() {
  if constexpr (Supported<decltype(Export)>::value) {
    return Thunk<Export>;
  } else {
    return nullptr;
  }
}
} // namespace SysV
