import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
        throw Error('AnyPS5 validation cache source changed: ' + before.slice(0, 100));
    return source.replace(before, after);
}

export async function applyValidationCacheOverlay(root) {
    const base = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics');
    await fs.copyFile(new URL('./ShaderValidationKey.hpp', import.meta.url), path.join(base, 'include/ShaderValidationKey.hpp'));
    const file = path.join(base, 'src/Draw.cpp');
    let source = await fs.readFile(file, 'utf8');
    const start = source.indexOf('// ValidateShaders decodes every SPIR-V instruction');
    const end = source.indexOf('// The resource cache key of a recorded draw:', start);
    if (start < 0 || end < 0) throw Error('AnyPS5 validation cache boundaries changed');
    let block = source.slice(start, end);
    const functionAt = block.indexOf('bool ValidationKey(');
    block = `// Validation results are scoped to exact module words, compiled variants,
// checked metadata, pipeline state and enabled device capabilities. Generated
// geometry and patch stages have no variant id; their retained module holders
// distinguish their actual SPIR-V without decoding it on every draw. A new key
// still runs the complete validator. APS5_NO_VALIDATE_CACHE disables reuse.
` + block.slice(functionAt);
    block = block.replaceAll('std::vector<std::uint64_t>', 'ShaderValidationKey');
    block = replace(block, '        add(shaders.size());', '        add(shaders.size());\n        key.modules.reserve(shaders.size());');
    block = replace(block, '            const bool generated = (state.rectList && (shader.stage == Stage::TessellationControl || shader.stage == Stage::TessellationEvaluation)) || shader.stage == Stage::Geometry;', `            const bool generated = ((state.rectList || BarycentricPatches(state, shaders)) && (shader.stage == Stage::TessellationControl || shader.stage == Stage::TessellationEvaluation)) || shader.stage == Stage::Geometry;`);
    block = replace(block, '            add(generated ? std::uint64_t{0} : program.PipelineVariantId());', `            add(program.PipelineVariantId());
            key.modules.push_back(program.spirv);`);
    block = replace(block, '            add(program.bdaAbiVersion);', `            add(program.bdaAbiVersion);
            add(program.readsDepthRemapPush);
            add(program.specialization.size());
            // Validation checks supplied IDs, not their dynamic values.
            for (const auto& constant : program.specialization) add(constant.id);
            add(program.bindings.size());
            for (const auto& binding : program.bindings) {
                add(binding.kind); add(binding.role); add(binding.descriptorSet);
                add(binding.binding); add(binding.count); add(binding.readOnly);
                add(binding.guestDescriptor.empty());
            }
            const auto& emulation = program.barycentricEmulation;
            add(emulation.active); add(emulation.smooth);
            add(emulation.linear); add(emulation.smoothOffset);
            add(program.fragmentParameters.size());
            for (const auto& parameter : program.fragmentParameters) {
                add(parameter.location); add(parameter.sourceLocation);
                add(parameter.flat); add(parameter.perVertex); add(parameter.custom);
                add(parameter.flatP10); add(parameter.vertexOrder); add(parameter.flatP20);
            }`);
    block = replace(block, '        add(state.blends.size());', `        add(state.blends.size());
        add(state.colors.size());
        for (const auto& color : state.colors) {
            add(color.exportIndex); add(color.uintExport); add(color.packing);
        }
        add(state.dualSourceBlend); add(state.reversedBlend);
        add(state.rasterizerDiscard); add(state.tessellationCapture != nullptr);
        add(state.stages.vertexWaveSize);`);
    block = replace(block, '                add(attribute.formatComponents);', `                add(attribute.formatComponents);
                const auto& fields = attribute.resource.fields;
                add(fields[0] == 0 && fields[1] == 0 && fields[2] == 0 && fields[3] == 0);`);
    block = replace(block, '        add(context.fragmentShaderBarycentric);', `        add(context.fragmentShaderBarycentric);
        add(context.descriptorIndexing); add(context.imageInt64Atomics);
        add(context.geometryShader); add(context.sampleRateShading);
        add(context.bufferInt64Atomics); add(context.runtimeDescriptorArray);
        add(context.demoteToHelperInvocation); add(context.meshShader);`);
    source = '#include "prx/libSceAgcDriver/Graphics/include/ShaderValidationKey.hpp"\n' + source.slice(0, start) + block + source.slice(end);
    await fs.writeFile(file, source);
}
