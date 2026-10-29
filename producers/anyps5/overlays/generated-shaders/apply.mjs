import fs from 'node:fs';
import path from 'node:path';

function replace(source, before, after, file) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw new Error('AnyPS5 generated shader overlay does not match ' + file);
  return source.replace(before, after);
}

export function applyGeneratedShadersOverlay(root) {
  const changed = [];
  const copy = (name, relative) => {
    fs.copyFileSync(new URL('./' + name, import.meta.url), path.join(root, relative));
    changed.push(relative);
  };
  const edit = (relative, transform) => {
    fs.writeFileSync(path.join(root, relative), transform(fs.readFileSync(path.join(root, relative), 'utf8'), relative));
    changed.push(relative);
  };
  copy('GeneratedBarycentricCache.hpp', 'core/shader/recompiler/SpirvBackend/include/SpirvBackend/GeneratedBarycentricCache.hpp');
  copy('RectanglePreparation.hpp', 'core/libs/prx/libSceAgcDriver/Execution/include/Driver/Shaders/RectanglePreparation.hpp');
  edit('core/shader/recompiler/SpirvBackend/src/BarycentricGeometryShader.cpp', (source, file) => {
    source = '#include "SpirvBackend/GeneratedBarycentricCache.hpp"\n' + source;
    source = replace(source, 'RecompileResult BuildBarycentricGeometryShader(', 'static RecompileResult BuildBarycentricGeometryShaderUncached(', file);
    source = replace(source, 'BarycentricTessellationShaders BuildBarycentricTessellationShaders(', 'static BarycentricTessellationShaders BuildBarycentricTessellationShadersUncached(', file);
    const end = source.lastIndexOf('\n}');
    if (end < 0) throw new Error('AnyPS5 generated shader namespace is missing');
    return source.slice(0, end) + `
RecompileResult BuildBarycentricGeometryShader(const RecompileResult& vertex, const RecompileResult& fragment, const SpirvTarget& target, const std::optional<GeometryStageLimits>& limits) {
    static GeneratedBarycentric::Cache<RecompileResult> cache;
    auto key = GeneratedBarycentric::MakeKey(vertex, fragment, target);
    key.fields.push_back(limits.has_value());
    if (limits) {
        key.fields.insert(key.fields.end(), {limits->maxGeometryInputComponents, limits->maxGeometryOutputComponents,
            limits->maxGeometryOutputVertices, limits->maxGeometryTotalOutputComponents, limits->maxFragmentInputComponents});
    }
    return cache.Get(std::move(key), [&] { return BuildBarycentricGeometryShaderUncached(vertex, fragment, target, limits); });
}

BarycentricTessellationShaders BuildBarycentricTessellationShaders(const RecompileResult& vertex, const RecompileResult& fragment, const SpirvTarget& target, std::uint32_t maxFragmentInputComponents, std::uint32_t provokingVertex) {
    static GeneratedBarycentric::Cache<BarycentricTessellationShaders> cache;
    auto key = GeneratedBarycentric::MakeKey(vertex, fragment, target);
    key.fields.insert(key.fields.end(), {maxFragmentInputComponents, provokingVertex});
    return cache.Get(std::move(key), [&] { return BuildBarycentricTessellationShadersUncached(vertex, fragment, target, maxFragmentInputComponents, provokingVertex); });
}
` + source.slice(end);
  });
  edit('core/libs/prx/libSceAgcDriver/Execution/src/Driver/Shaders/ShaderRegistry.cpp', (source, file) => {
    source = '#include "prx/libSceAgcDriver/Execution/include/Driver/Shaders/RectanglePreparation.hpp"\n' + source;
    source = replace(source,
      '    ResolvePreparedGraphics(front, fragment, 17, target);\n    return PreparedRectangle(front, vertexId, fragmentId);',
      `    ShaderPreparationTransaction transaction;
    auto& selected = transaction.Edit(front);
    auto shaders = PrepareRequestedRectanglePair(selected, selected.entries, transaction.Read(*fragment).entries,
        vertexId, fragmentId, target, [](const auto& entry) -> const ShaderRecompiler::CompiledShaderArtifact& {
            return ShaderRecompiler::GetPreparedArtifact(*entry.handle);
        });
    transaction.Commit();
    return *shaders;`, file);
    source = replace(source, '    if (prepared()) return PreparedRectangle(front, vertexId, fragmentId);\n    APS5_LOG_ERR(',
      '    if (prepared()) return PreparedRectangle(front, vertexId, fragmentId);\n    require(fragment != nullptr, "a rectangle draw has no fragment shader");\n    APS5_LOG_ERR(', file);
    const begin = source.indexOf('        std::vector<PreparedShaders::Rectangle> rectangles;');
    const end = source.indexOf('        std::erase_if(prepared.rectangleProgress,', begin);
    if (begin < 0 || end < 0) throw new Error('AnyPS5 rectangle preparation loop is missing');
    return source.slice(0, begin) + `        for (std::size_t vertexIndex = 0; vertexIndex < prepared.entries.size(); ++vertexIndex) {
            const auto& vertexEntry = prepared.entries[vertexIndex];
            for (std::size_t fragmentIndex = vertexIndex < vertexCount ? fragmentCount : 0u; fragmentIndex < pixelPrepared.entries.size(); ++fragmentIndex) {
                const auto& fragmentEntry = pixelPrepared.entries[fragmentIndex];
                const auto& vertexArtifact = ShaderRecompiler::GetPreparedArtifact(*vertexEntry.handle);
                const auto& fragmentArtifact = ShaderRecompiler::GetPreparedArtifact(*fragmentEntry.handle);
                try {
                    PrepareRectanglePair(prepared, vertexArtifact, fragmentArtifact, target);
                } catch (const std::exception& error) {
                    if (!deferUnprepared && pixel == fragment) throw;
                    if (deferUnprepared) DeferPipelineStage(transaction.Edit(*pixel), *pixel, error.what());
                }
            }
        }
` + source.slice(end);
  });
  return changed;
}
