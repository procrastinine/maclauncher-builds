import {replace, apple} from './common.mjs';
export async function applyShaderResultCompatibility(edit) {
    const backend = 'core/shader/recompiler/SpirvBackend/';
    await edit(backend + 'include/SpirvBackend/SpirvEmitterState.hpp', source => replace(source, '    std::uint32_t srgbTableVariable = 0;', '    std::unordered_map<std::uint32_t, std::uint32_t> subgroupResultVariables;\n    std::uint32_t srgbTableVariable = 0;'));
    await edit(backend + 'include/SpirvBackend/SpirvMemory/SpirvSubgroup.hpp', source => replace(source, 'bool HostSubgroupSingleLane(const SpirvEmitterState& state);', `#ifdef __APPLE__
void EmitConvergentResult(SpirvEmitterState& state, std::uint32_t type, std::uint32_t result, std::uint32_t value);
#endif
bool HostSubgroupSingleLane(const SpirvEmitterState& state);`));
    await edit(backend + 'src/SpirvMemory/SpirvSubgroup.cpp', source => {
        source = replace(source, '    bool HostSubgroupSingleLane(const SpirvEmitterState& state) {', `#ifdef __APPLE__
    // A private store keeps subgroup operations outside short-circuit expressions
    // during translation to Metal, so every participating lane executes them.
    void EmitConvergentResult(SpirvEmitterState& state, std::uint32_t type, std::uint32_t result, std::uint32_t value) {
        auto [slot, inserted] = state.subgroupResultVariables.try_emplace(type, 0u);
        if (inserted) {
            slot->second = state.module.DefineGlobalVariable(TypePointer(state, spv::StorageClassPrivate, type), spv::StorageClassPrivate);
            if (state.spirvVersion >= 0x00010400u) state.interfaceVariables.push_back(slot->second);
        }
        state.module.AddFunction(spv::OpStore, slot->second, value);
        state.module.AddFunction(spv::OpLoad, type, result, slot->second);
    }
#endif

    bool HostSubgroupSingleLane(const SpirvEmitterState& state) {`);
        const ballot = '        state.module.AddSubgroupBallot(TypeU32Vector(state, 4u), result, ConstantU32(state, spv::ScopeSubgroup), predicate);';
        source = replace(source, ballot, apple(ballot, `        const auto raw = state.module.AllocateId();
        state.module.AddSubgroupBallot(TypeU32Vector(state, 4u), raw, ConstantU32(state, spv::ScopeSubgroup), predicate);
        EmitConvergentResult(state, TypeU32Vector(state, 4u), result, raw);`));
        for (const lane of ['lane', 'EmitBinaryU32(state, spv::OpBitwiseAnd, lane, ConstantU32(state, 31u))']) {
            const before = '        state.module.AddFunction(spv::OpGroupNonUniformShuffle, type, result, ConstantU32(state, spv::ScopeSubgroup), value, ' + lane + ');';
            source = replace(source, before, apple(before, `        const auto raw = state.module.AllocateId();
        state.module.AddFunction(spv::OpGroupNonUniformShuffle, type, raw, ConstantU32(state, spv::ScopeSubgroup), value, ${lane});
        EmitConvergentResult(state, type, result, raw);`));
        }
        return source;
    });
    await edit(backend + 'src/SpirvEmitter.cpp', source => {
        const ballot = '    state.module.AddSubgroupBallot(ballotType, high, scope, half == 1u ? Def(predicate) : otherHalf->Def(predicate));';
        source = replace(source, ballot, apple(ballot, '    EmitHostSubgroupBallot(state, high, half == 1u ? Def(predicate) : otherHalf->Def(predicate));'));
        for (const [result, half] of [['low', 0], ['high', 1]]) {
            const before = `    state.module.AddFunction(spv::OpGroupNonUniformShuffle, type, ${result}, scope, HalfArg(inst, index, ${half}u), physicalLane);`;
            source = replace(source, before, apple(before, `    EmitSubgroupShuffle(state, type, ${result}, HalfArg(inst, index, ${half}u), physicalLane);`));
        }
        return source;
    });
    await edit(backend + 'src/SpirvAlu/SpirvAluEmitterMath.cpp', source => {
        const before = '    return EmitNative<spv::OpFUnordNotEqual, IrType::U1>(state, arg0, arg0);';
        return replace(source, before, apple(before, `    const auto bits = Unary(state, spv::OpBitcast, TypeU32(state), arg0);
    const auto magnitude = Binary(state, spv::OpBitwiseAnd, TypeU32(state), bits, ConstantU32(state, 0x7fffffffu));
    return Binary(state, spv::OpUGreaterThan, TypeBool(state), magnitude, ConstantU32(state, 0x7f800000u));`));
    });
    await edit('core/shader/recompiler/Translation/src/FloatInstructions.cpp', source => {
        const before = '    IrU32 result = convertF32ToF16Bits(product, {&value.Value()});';
        return replace(source, before, before + '\n#ifdef __APPLE__\n    result = IrU32(ir.BitwiseOr(result.Value(), ir.BitwiseAnd(bits.Value(), ir.Constant(0x8000u))));\n#endif');
    });
    await edit(backend + 'src/SpirvImageEmitter.cpp', source => {
        const marker = '        const auto pointer = state.module.AllocateId();\n        const auto pointerType = TypePointer(state, spv::StorageClassImage, TypeU32(state));';
        return replace(source, marker, `#ifdef __APPLE__
        state.module.AddFunction(spv::OpMemoryBarrier, ConstantU32(state, spv::ScopeDevice), ConstantU32(state, spv::MemorySemanticsAcquireReleaseMask | spv::MemorySemanticsImageMemoryMask));
#endif
` + marker);
    });
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * subgroup storage, NaN classification and half-float ldexp:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/ab9abe095f4bb1eace87b1c53903b613800343e2
 * image-atomic memory ordering:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/92c2fb9ca7b1a1547136c32f63cfdc4417fc8197
 */
