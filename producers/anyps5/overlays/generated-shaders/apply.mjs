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
  edit('core/libs/prx/libSceAgcDriver/Graphics/src/ShaderInputState.cpp', (source, file) => {
    source = replace(source,
      '    if (address < headerAddress) throw std::runtime_error("AGC graphics: AGC header pointer precedes the shader header");', `#ifdef __APPLE__
    if (address < headerAddress || address - headerAddress > header.size() || bytes > header.size() - (address - headerAddress)) {
        T value{};
        AgcDriver::GuestMemory::Read(address, std::as_writable_bytes(std::span(&value, 1)).first(bytes), 1);
        return value;
    }
#endif
    if (address < headerAddress) throw std::runtime_error("AGC graphics: AGC header pointer precedes the shader header");`, file);
    source = replace(source,
      '    if (address < headerAddress) throw std::runtime_error("AGC graphics: AGC header array pointer precedes the shader header");', `#ifdef __APPLE__
    const auto guestBytes = static_cast<std::uint64_t>(count) * sizeof(T);
    if (address < headerAddress || address - headerAddress > header.size() || guestBytes > header.size() - (address - headerAddress)) {
        AgcDriver::GuestMemory::Read(address, std::as_writable_bytes(std::span(destination, count)), 1);
        return;
    }
#endif
    if (address < headerAddress) throw std::runtime_error("AGC graphics: AGC header array pointer precedes the shader header");`, file);
    return replace(source,
      '    if (shader.user_data == nullptr) throw std::runtime_error("AGC graphics: missing AGC user-data header");', `#ifdef __APPLE__
    if (shader.user_data == nullptr) return info;
#endif
    if (shader.user_data == nullptr) throw std::runtime_error("AGC graphics: missing AGC user-data header");`, file);
  });
  edit('core/libs/prx/libSceAgcDriver/Execution/src/Driver/Shaders/ShaderRegistry.cpp', (source, file) => {
    source = replace(source, 'bool AsyncRegistrationPrepare() {', `bool RegistrationPrepareEnabled() {
#ifdef __APPLE__
    static const bool enabled = [] {
        if (const char* text = std::getenv("APS5_REGISTRATION_PREPARE")) return std::strcmp(text, "0") != 0;
        const auto memory = ReadPhysicalMemoryBytes();
        return !memory || *memory >= (std::uint64_t{32} << 30u);
    }();
    return enabled;
#else
    return true;
#endif
}

bool AsyncRegistrationPrepare() {`, file);
    source = replace(source, '    if (LazyShaderPreparation()) {\n        static_cast<void>(PlanRegistered(snapshot, *localDevice, registered, true, &snapshot.prepared->deferred));', `    if (!RegistrationPrepareEnabled()) {
        snapshot.prepared->deferred = true;
    } else if (LazyShaderPreparation()) {
        static_cast<void>(PlanRegistered(snapshot, *localDevice, registered, true, &snapshot.prepared->deferred));`, file);
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

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * copied shader-input headers:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/471ac2f53aabd9989cf99cc31388c0d1b672c7d9
 * deferred registration preparation:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/ae9b457257672af16198743d9a4c397f85bd7666
 */
