import fs from 'node:fs/promises';
import {replace, apple} from './common.mjs';
export async function applyProvokingCompatibility(edit) {
    const graphics = 'core/libs/prx/libSceAgcDriver/Graphics/';
    await edit(graphics + 'include/Pipeline.hpp', source => replace(source,
        'void ValidateProvokingVertex(const Context& context, const State& state, std::span<const CompiledShader> shaders = {});',
        'bool ReadsProvokingVertex(std::span<const CompiledShader> shaders);\nvoid ValidateProvokingVertex(const Context& context, const State& state, std::span<const CompiledShader> shaders = {});'));
    await edit(graphics + 'src/Pipeline.cpp', source => {
        const declaration = 'void ValidateProvokingVertex(const Context& context, const State& state, std::span<const CompiledShader> shaders) {';
        const start = source.indexOf('    struct Decorations {', source.indexOf(declaration));
        const end = source.indexOf('    if (!context.provokingVertexLast && !observed) return;', start);
        if (start < 0 || end < 0) throw Error('AnyPS5 provoking observation boundary changed');
        const observation = source.slice(start, end).replace('    const bool observed = ', '    return ');
        source = source.slice(0, start) + '    const bool observed = ReadsProvokingVertex(shaders);\n' + source.slice(end);
        return replace(source, declaration, 'bool ReadsProvokingVertex(std::span<const CompiledShader> shaders) {\n' + observation + '}\n\n' + declaration);
    });
    await edit(graphics + 'include/VertexInput.hpp', async source => replace(source,
        'inline std::vector<std::size_t> SoloZeroPaddedFetchIndices',
        await fs.readFile(new URL('./LastVertexFirstList.inc', import.meta.url), 'utf8') + '\ninline std::vector<std::size_t> SoloZeroPaddedFetchIndices'));
    await edit(graphics + 'src/Draw.cpp', async source => {
        const inputs = 'struct DrawInputs {';
        source = replace(source, inputs, await fs.readFile(new URL('./ProvokingVertex.inc', import.meta.url), 'utf8') + '\n' + inputs);
        source = replace(source,
            'DrawInputs prepareDrawInputs(const Context& context, const State& state, const Pm4::DrawParameters& draw, std::span<const CompiledShader> shaders, DrawOutcome& outcome, DrawTimer& timer, const DrawRecipe* recipe) {',
            'DrawInputs prepareDrawInputs(const Context& context, const State& state, const Pm4::DrawParameters& draw, std::span<const CompiledShader> shaders, DrawOutcome& outcome, DrawTimer& timer, const DrawRecipe* recipe, const ProvokingRewrite* rewrite = nullptr) {');
        source = replace(source,
            '    if (draw.indexed) GuestMemory::CheckRange(reinterpret_cast<const void*>(draw.indexAddress), static_cast<std::size_t>(indexBytes), draw.indexSize);',
            '    if (draw.indexed && rewrite == nullptr) GuestMemory::CheckRange(reinterpret_cast<const void*>(draw.indexAddress), static_cast<std::size_t>(indexBytes), draw.indexSize);');
        const start = '    inputs.maxIndex = draw.indexed ? 0u : draw.firstVertex + draw.indexCount - 1u;\n    if (state.quadList || StripPatches(state, shaders)) {';
        source = replace(source, start, `    inputs.maxIndex = draw.indexed ? 0u : draw.firstVertex + draw.indexCount - 1u;
    if (rewrite != nullptr) {
        if (rewrite->indices == nullptr) {
            inputs.nothing = true;
            return inputs;
        }
        Require(rewrite->highest <= context.limits.maxDrawIndexedIndexValue, "index exceeds the device's indexed draw limit");
        inputs.maxIndex = rewrite->highest;
        inputs.indices = rewrite->indices;
        inputs.indexHandle = inputs.indices->Handle();
    } else if (state.quadList || StripPatches(state, shaders)) {`);
        source = replace(source, '    explicit PreparedDraw(bool profile) : timer(profile) {}', '    explicit PreparedDraw(bool profile) : timer(profile) {}\n    const ProvokingRewrite* provoking = nullptr;');
        source = replace(source, '    inputs = prepareDrawInputs(context, state, draw, shaders, outcome, timer, nullptr);', '    inputs = prepareDrawInputs(context, state, draw, shaders, outcome, timer, nullptr, prepared.provoking);');
        const declaration = 'void Draw(const Context& context, const State& state, const Pm4::DrawParameters& draw, std::span<const CompiledShader> shaders, std::span<const GuestMemorySnapshot> snapshots, std::shared_ptr<const DrawRecipe>* recipeOut, const DrawTraceContext* trace, std::uint64_t shape) {';
        source = replace(source, declaration, 'static void drawWithProvoking(const Context& context, const State& state, const Pm4::DrawParameters& draw, std::span<const CompiledShader> shaders, std::span<const GuestMemorySnapshot> snapshots, std::shared_ptr<const DrawRecipe>* recipeOut, const DrawTraceContext* trace, std::uint64_t shape, const ProvokingRewrite* rewrite) {');
        source = replace(source, '    prepared.recipeOut = recipeOut;', '    prepared.recipeOut = recipeOut;\n    prepared.provoking = rewrite;');
        return replace(source, '\nDrawRecipeOutcome DrawWithRecipe(', `
${declaration}
#ifdef __APPLE__
    if (const auto rewrite = rewriteLastProvokingVertex(context, state, draw, shaders)) {
        drawWithProvoking(context, rewrite->state, rewrite->draw, shaders, snapshots, nullptr, trace, shape, &*rewrite);
        return;
    }
#endif
    drawWithProvoking(context, state, draw, shaders, snapshots, recipeOut, trace, shape, nullptr);
}

DrawRecipeOutcome DrawWithRecipe(`);
    });
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * last-provoking-vertex index reordering:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/8ebc654e624ba82ae5378dc83439e75452d872b1
 */
