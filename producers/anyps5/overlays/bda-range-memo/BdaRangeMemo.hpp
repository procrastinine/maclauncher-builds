// SPDX-License-Identifier: GPL-2.0-only
#ifndef CORE_SHADER_RECOMPILER_SPIRVBACKEND_BDARANGEMEMO_HPP
#define CORE_SHADER_RECOMPILER_SPIRVBACKEND_BDARANGEMEMO_HPP

#include <cstdint>

// The per-invocation BDA memos, written once against an operation set `B`: the SPIR-V emitter
// instantiates it with an instruction builder, a host check with plain integer arithmetic.
// B provides U32, U64, Add64, Sub64, Widen (u32 -> u64), Ult64, Ule64, Ugt64, Uge64, Eq32, Ne32,
// And, Or (booleans), And32, Or32 and Select32/Select64 (condition, if true, if false).
namespace ShaderRecompiler::BdaRangeMemo {

// A lookup of [address, address + bytes) is answered from the memo of the last range found when the
// bytes lie inside the remembered [begin, bound). A zero-byte or wrapping access never hits, and the
// initial memo (bound 0) never hits.
template <class B>
auto Hit(B& b, auto address, auto bytes, auto begin, auto bound) {
    const auto end = b.Add64(address, b.Widen(bytes));
    return b.And(b.And(b.Ne32(bytes, b.U32(0u)), b.Uge64(address, begin)), b.And(b.Ugt64(end, address), b.Ule64(end, bound)));
}

template <class B>
auto Translate(B& b, auto address, auto begin, auto base) {
    return b.Add64(base, b.Sub64(address, begin));
}

// The bound remembered for the range a full lookup selected: its end, or the next entry's start when
// that comes first (the search selects the next entry from there on). The memo is left unusable
// (bound 0) when the device span up to the bound would wrap, which a full lookup checks per access.
template <class B>
auto Bound(B& b, auto begin, auto finish, auto base, auto next, auto last) {
    const auto bound = b.Select64(b.Or(last, b.Ult64(finish, next)), finish, next);
    return b.Select64(b.Ugt64(b.Add64(base, b.Sub64(bound, begin)), base), bound, b.U64(0u));
}

// note_bda_write: whether this invocation already noted the page bit in the region, and the page
// bits to remember for the region after this note.
template <class B>
auto Seen(B& b, auto key, auto bit, auto lastKey, auto lastMask) {
    return b.And(b.Eq32(key, lastKey), b.Ne32(b.And32(lastMask, bit), b.U32(0u)));
}

template <class B>
auto NotedMask(B& b, auto key, auto bit, auto lastKey, auto lastMask) {
    return b.Select32(b.Eq32(key, lastKey), b.Or32(lastMask, bit), bit);
}

}

#endif
