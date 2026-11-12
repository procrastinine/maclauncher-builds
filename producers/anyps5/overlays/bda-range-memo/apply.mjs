// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs/promises';
import path from 'node:path';

const backend = 'core/shader/recompiler/SpirvBackend';
export const lookupFile = backend + '/src/SpirvBdaLookup.cpp';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 BDA lookup source changed: ' + before.slice(0, 100));
  return source.replace(before, after);
}

// Address-based (BDA) reads and writes look their address up in the page table on every access:
// the table header checks, a binary search and the range checks. A shader that walks one buffer
// (DOOM's presentation kernel: eight lookups and eight span reads per pixel) repeats the same
// search. Each lookup function now first checks a per-invocation memo of the last range it found
// (Private variables per permission: guest begin, bound and device base) and answers from it when
// the access lies inside that range, which by the table's order is exactly where the search would
// select the same entry; a successful search refreshes the memo. note_bda_write likewise skips the
// written-page table's atomics when this invocation already noted the same page in the same region.
export async function applyBdaRangeMemoOverlay(root) {
  await fs.copyFile(path.join(import.meta.dirname, 'BdaRangeMemo.hpp'), path.join(root, backend, 'include/SpirvBackend/BdaRangeMemo.hpp'));
  const target = path.join(root, lookupFile);
  let source = await fs.readFile(target, 'utf8');
  source = replace(source, '#include "SpirvBackend/SpirvBda.hpp"\n', '#include "SpirvBackend/SpirvBda.hpp"\n#include "SpirvBackend/BdaRangeMemo.hpp"\n');
  source = replace(source,
    'namespace {\n\n// (u64 address, u32 bytes, u32 instruction)',
    'namespace {\n\n' +
    '// BdaRangeMemo operations emitted as SPIR-V.\n' +
    'struct SpirvMemoOps {\n' +
    '    SpirvEmitterState& state;\n' +
    '    std::uint32_t u32() { return TypeU32(state); }\n' +
    '    std::uint32_t u64() { return TypeScalarU64(state); }\n' +
    '    std::uint32_t boolean() { return TypeBool(state); }\n' +
    '    std::uint32_t U32(std::uint32_t value) { return ConstantU32(state, value); }\n' +
    '    std::uint32_t U64(std::uint64_t value) { return BdaConstant(state, value); }\n' +
    '    std::uint32_t Add64(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpIAdd, u64(), a, b); }\n' +
    '    std::uint32_t Sub64(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpISub, u64(), a, b); }\n' +
    '    std::uint32_t Widen(std::uint32_t value) { return Unary(state, spv::OpUConvert, u64(), value); }\n' +
    '    std::uint32_t Ult64(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpULessThan, boolean(), a, b); }\n' +
    '    std::uint32_t Ule64(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpULessThanEqual, boolean(), a, b); }\n' +
    '    std::uint32_t Ugt64(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpUGreaterThan, boolean(), a, b); }\n' +
    '    std::uint32_t Uge64(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpUGreaterThanEqual, boolean(), a, b); }\n' +
    '    std::uint32_t Eq32(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpIEqual, boolean(), a, b); }\n' +
    '    std::uint32_t Ne32(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpINotEqual, boolean(), a, b); }\n' +
    '    std::uint32_t And(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpLogicalAnd, boolean(), a, b); }\n' +
    '    std::uint32_t Or(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpLogicalOr, boolean(), a, b); }\n' +
    '    std::uint32_t And32(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpBitwiseAnd, u32(), a, b); }\n' +
    '    std::uint32_t Or32(std::uint32_t a, std::uint32_t b) { return Binary(state, spv::OpBitwiseOr, u32(), a, b); }\n' +
    '    std::uint32_t Select32(std::uint32_t condition, std::uint32_t a, std::uint32_t b) { return Select(state, u32(), condition, a, b); }\n' +
    '    std::uint32_t Select64(std::uint32_t condition, std::uint32_t a, std::uint32_t b) { return Select(state, u64(), condition, a, b); }\n' +
    '};\n\n' +
    '// One invocation\'s memo of the last range a lookup of one permission found (Private, zero = empty).\n' +
    'struct BdaMemoVariables {\n' +
    '    std::uint32_t begin = 0;\n' +
    '    std::uint32_t bound = 0;\n' +
    '    std::uint32_t base = 0;\n' +
    '};\n\n' +
    'std::uint32_t PrivateVariable(SpirvEmitterState& state, std::uint32_t type, std::uint32_t zero, const std::string& name) {\n' +
    '    const auto variable = state.module.DefineInitializedGlobalVariable(TypePointer(state, spv::StorageClassPrivate, type), spv::StorageClassPrivate, zero);\n' +
    '    state.module.AddName(variable, name);\n' +
    '    return variable;\n' +
    '}\n\n' +
    'BdaMemoVariables DefineBdaMemo(SpirvEmitterState& state, const std::string& name) {\n' +
    '    const auto u64 = TypeScalarU64(state);\n' +
    '    const auto zero = BdaConstant(state, 0u);\n' +
    '    return {PrivateVariable(state, u64, zero, name + "_begin"), PrivateVariable(state, u64, zero, name + "_bound"), PrivateVariable(state, u64, zero, name + "_base")};\n' +
    '}\n\n' +
    '// (u64 address, u32 bytes, u32 instruction)');
  source = replace(source,
    'std::uint32_t DefineBdaLookup(SpirvEmitterState& state, const char* name, bool recordFaults, std::uint32_t permission = BdaAbi::Read, bool rangeResult = false) {\n',
    'std::uint32_t DefineBdaLookup(SpirvEmitterState& state, const char* name, bool recordFaults, std::uint32_t permission = BdaAbi::Read, bool rangeResult = false, const BdaMemoVariables* memo = nullptr) {\n');
  source = replace(source,
    '    const auto length = state.module.AllocateId();\n    state.module.AddFunction(spv::OpArrayLength, u32, length, state.bdaPagetableVariable, 0u);\n',
    '    SpirvMemoOps ops{state};\n' +
    '    if (memo != nullptr) {\n' +
    '        // Before the header checks and the search: an access inside the last range found.\n' +
    '        const auto load = [&](std::uint32_t variable) {\n' +
    '            const auto value = state.module.AllocateId();\n' +
    '            state.module.AddFunction(spv::OpLoad, u64, value, variable);\n' +
    '            return value;\n' +
    '        };\n' +
    '        const auto memoBegin = load(memo->begin);\n' +
    '        const auto memoBound = load(memo->bound);\n' +
    '        const auto memoBase = load(memo->base);\n' +
    '        const auto hit = BdaRangeMemo::Hit(ops, address, bytes, memoBegin, memoBound);\n' +
    '        const auto hitLabel = state.module.AllocateId();\n' +
    '        const auto miss = state.module.AllocateId();\n' +
    '        state.module.AddFunction(spv::OpSelectionMerge, miss, spv::SelectionControlMaskNone);\n' +
    '        state.module.AddFunction(spv::OpBranchConditional, hit, hitLabel, miss);\n' +
    '        EmitLabel(state, hitLabel);\n' +
    '        leave(BdaRangeMemo::Translate(ops, address, memoBegin, memoBase));\n' +
    '        EmitLabel(state, miss);\n' +
    '    }\n' +
    '    const auto length = state.module.AllocateId();\n    state.module.AddFunction(spv::OpArrayLength, u32, length, state.bdaPagetableVariable, 0u);\n');
  source = replace(source,
    '    } else {\n        leave(result);\n    }\n',
    '    } else {\n' +
    '        if (memo != nullptr) {\n' +
    '            const auto last = binary(spv::OpUGreaterThanEqual, boolean, index, count);\n' +
    '            const auto next = BdaLoadAddress(state, binary(spv::OpIAdd, u32, constant(4), binary(spv::OpIMul, u32, Select(state, u32, last, binary(spv::OpISub, u32, index, constant(1)), index), constant(8))));\n' +
    '            state.module.AddFunction(spv::OpStore, memo->begin, begin);\n' +
    '            state.module.AddFunction(spv::OpStore, memo->base, base);\n' +
    '            state.module.AddFunction(spv::OpStore, memo->bound, BdaRangeMemo::Bound(ops, begin, finish, base, next, last));\n' +
    '        }\n' +
    '        leave(result);\n' +
    '    }\n');
  // note_bda_write: the repeat check comes before the probe loop's first atomic.
  source = replace(source,
    '    state.module.AddFunction(spv::OpStore, done, ConstantBool(state, false));\n    state.module.AddFunction(spv::OpStore, counter, constant(0u));\n',
    '    state.module.AddFunction(spv::OpStore, counter, constant(0u));\n');
  source = replace(source,
    '    const auto bit = binary(spv::OpShiftLeftLogical, u32, constant(1u), page);\n',
    '    const auto bit = binary(spv::OpShiftLeftLogical, u32, constant(1u), page);\n' +
    '    {\n' +
    '        // This invocation\'s last noted region and the page bits noted in it: a page already noted\n' +
    '        // starts the search as done, so neither the probe loop nor the overflow store runs.\n' +
    '        const auto region = PrivateVariable(state, u32, constant(0u), "bda_noted_region");\n' +
    '        const auto pages = PrivateVariable(state, u32, constant(0u), "bda_noted_pages");\n' +
    '        const auto lastKey = state.module.AllocateId();\n' +
    '        state.module.AddFunction(spv::OpLoad, u32, lastKey, region);\n' +
    '        const auto lastMask = state.module.AllocateId();\n' +
    '        state.module.AddFunction(spv::OpLoad, u32, lastMask, pages);\n' +
    '        SpirvMemoOps ops{state};\n' +
    '        const auto seen = BdaRangeMemo::Seen(ops, key, bit, lastKey, lastMask);\n' +
    '        state.module.AddFunction(spv::OpStore, pages, BdaRangeMemo::NotedMask(ops, key, bit, lastKey, lastMask));\n' +
    '        state.module.AddFunction(spv::OpStore, region, key);\n' +
    '        state.module.AddFunction(spv::OpStore, done, seen);\n' +
    '    }\n');
  source = replace(source,
    '    state.bdaPointerFunction = DefineBdaLookup(state, "get_bda_pointer", true);\n    if (!BdaByteReadsForced()) state.bdaProbeFunction = DefineBdaLookup(state, "probe_bda_pointer", false);\n',
    '    const auto readMemo = DefineBdaMemo(state, "bda_read_range");\n' +
    '    state.bdaPointerFunction = DefineBdaLookup(state, "get_bda_pointer", true, BdaAbi::Read, false, &readMemo);\n' +
    '    if (!BdaByteReadsForced()) state.bdaProbeFunction = DefineBdaLookup(state, "probe_bda_pointer", false, BdaAbi::Read, false, &readMemo);\n');
  source = replace(source,
    '        state.bdaWritePointerFunction = DefineBdaLookup(state, "get_bda_write_pointer", true, BdaAbi::Write);\n' +
    '        if (!BdaByteReadsForced()) state.bdaWriteProbeFunction = DefineBdaLookup(state, "probe_bda_write_pointer", false, BdaAbi::Write);\n' +
    '        state.bdaAtomicPointerFunction = DefineBdaLookup(state, "get_bda_atomic_pointer", true, BdaAbi::Read | BdaAbi::Write);\n',
    '        const auto writeMemo = DefineBdaMemo(state, "bda_write_range");\n' +
    '        state.bdaWritePointerFunction = DefineBdaLookup(state, "get_bda_write_pointer", true, BdaAbi::Write, false, &writeMemo);\n' +
    '        if (!BdaByteReadsForced()) state.bdaWriteProbeFunction = DefineBdaLookup(state, "probe_bda_write_pointer", false, BdaAbi::Write, false, &writeMemo);\n' +
    '        const auto atomicMemo = DefineBdaMemo(state, "bda_atomic_range");\n' +
    '        state.bdaAtomicPointerFunction = DefineBdaLookup(state, "get_bda_atomic_pointer", true, BdaAbi::Read | BdaAbi::Write, false, &atomicMemo);\n');
  if (!source.includes('#include <string>')) source = replace(source, '#include <vector>\n', '#include <vector>\n#include <string>\n');
  await fs.writeFile(target, source);
}
