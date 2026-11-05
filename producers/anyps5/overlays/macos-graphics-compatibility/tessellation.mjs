import {replace, apple} from './common.mjs';
export async function applyTessellationCompatibility(edit) {
    const recompiler = 'core/shader/recompiler/';
    await edit(recompiler + 'Recompiler.hpp', source => replace(source, '    bool vertexSubgroups = true;', '    bool vertexSubgroups = true;\n    bool tessellationEvaluationSubgroups = true;'));
    await edit(recompiler + 'Recompiler.cpp', source => {
        const before = '    if (vertexStage && !request.target.vertexSubgroups) return 1u;';
        return replace(source, before, before + '\n#ifdef __APPLE__\n    if (request.shader.stage == ShaderStage::TessellationEvaluation && !request.target.tessellationEvaluationSubgroups && !(request.graphics && request.graphics->mesh)) return 1u;\n#endif');
    });
    await edit(recompiler + 'CacheKey.hpp', source => replace(source, '        append(key, value.vertexSubgroups);', '        append(key, value.vertexSubgroups);\n        append(key, value.tessellationEvaluationSubgroups);'));
    await edit(recompiler + 'ControlFlow/src/RequestSerializer.cpp', source => {
        source = replace(source, '    writer.WriteU32(49u);', '    writer.WriteU32(51u);');
        source = replace(source, '    writer.WriteBool(request.target.fragmentBarycentricBuiltins);', '    writer.WriteBool(request.target.fragmentBarycentricBuiltins);\n    writer.WriteBool(request.target.tessellationEvaluationSubgroups);');
        source = replace(source, 'version > 49u', 'version > 51u');
        return replace(source, '    if (version >= 48u) result.request.target.fragmentBarycentricBuiltins = reader.ReadBool();', '    if (version >= 48u) result.request.target.fragmentBarycentricBuiltins = reader.ReadBool();\n    if (version >= 51u) result.request.target.tessellationEvaluationSubgroups = reader.ReadBool();');
    });
    await edit('core/libs/prx/libSceAgcDriver/Execution/src/VulkanDevice.cpp', source => {
        const before = '    target.vertexSubgroups = (state->subgroup.supportedStages & VK_SHADER_STAGE_VERTEX_BIT) != 0;';
        return replace(source, before, before + '\n#ifdef __APPLE__\n    target.tessellationEvaluationSubgroups = (state->subgroup.supportedStages & VK_SHADER_STAGE_TESSELLATION_EVALUATION_BIT) != 0;\n#endif');
    });
    await edit(recompiler + 'SpirvBackend/src/RectListShaders.cpp', source => {
        const first = source.indexOf('        const auto first = result(spv::OpIEqual, boolType, invocation, intConstant(0));');
        const last = source.indexOf('\n\n        std::array<std::uint32_t, 3> positions', first);
        if (first < 0 || last < 0) throw Error('AnyPS5 rectangle levels boundary changed');
        const levels = source.slice(first, last);
        source = source.slice(0, first) + '#ifndef __APPLE__\n' + levels + '\n#endif' + source.slice(last);
        const before = '        rejectInvalidRectangle(valid);';
        const after = `        const auto x0 = result(spv::OpCompositeExtract, floatType, positions[0], 0u);
        const auto y0 = result(spv::OpCompositeExtract, floatType, positions[0], 1u);
        const auto cross = result(spv::OpFSub, floatType,
            result(spv::OpFMul, floatType, result(spv::OpFSub, floatType, result(spv::OpCompositeExtract, floatType, positions[1], 0u), x0), result(spv::OpFSub, floatType, result(spv::OpCompositeExtract, floatType, positions[2], 1u), y0)),
            result(spv::OpFMul, floatType, result(spv::OpFSub, floatType, result(spv::OpCompositeExtract, floatType, positions[1], 1u), y0), result(spv::OpFSub, floatType, result(spv::OpCompositeExtract, floatType, positions[2], 0u), x0)));
        const auto empty = result(spv::OpFOrdEqual, boolType, cross, constant(floatType, 0));
        const auto level = result(spv::OpSelect, floatType, empty, constant(floatType, 0), floatOne);
${levels.replaceAll(', floatOne);', ', level);')}
        rejectInvalidRectangle(result(spv::OpLogicalOr, boolType, valid, empty));`;
        return replace(source, before, apple(before, after));
    });
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * zero-area rectangle handling:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/140bdd3d4b99f353bd47808fa533876a0b3e20ce
 * Portions adapted from AnyPS5 (GPL-2.0-only).
 * tessellation subgroup capability lowering:
 * https://github.com/boykopovar/AnyPS5/commit/53e4e8e7961030f0cee59e992b0b0cc1421f5cec
 */
