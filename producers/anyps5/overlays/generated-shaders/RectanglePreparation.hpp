// SPDX-License-Identifier: GPL-2.0-only
#pragma once
#include "Recompiler.hpp"
#include <algorithm>
#include <memory>
#include <stdexcept>

namespace AgcDriver::DriverDetail {

template<class Prepared>
std::shared_ptr<const ShaderRecompiler::RectListShaders> PrepareRectanglePair(Prepared& prepared,
    const ShaderRecompiler::CompiledShaderArtifact& vertex, const ShaderRecompiler::CompiledShaderArtifact& fragment,
    const ShaderRecompiler::SpirvTarget& target) {
    for (const auto& entry : prepared.rectangles) {
        if (entry.vertexId == vertex.variantId && entry.fragmentId == fragment.variantId) {
            if (!entry.shaders) throw std::runtime_error("AGC driver: prepared rectangle artifact is missing");
            return entry.shaders;
        }
    }
    ShaderRecompiler::RecompileResult vertexResult;
    ShaderRecompiler::RecompileResult fragmentResult;
    static_cast<ShaderRecompiler::CompiledShaderArtifact&>(vertexResult) = vertex;
    static_cast<ShaderRecompiler::CompiledShaderArtifact&>(fragmentResult) = fragment;
    auto shaders = std::make_shared<const ShaderRecompiler::RectListShaders>(ShaderRecompiler::BuildRectListShaders(vertexResult, fragmentResult, target));
    prepared.rectangles.push_back({vertex.variantId, fragment.variantId, shaders});
    return shaders;
}

template<class Prepared, class Vertices, class Fragments, class ArtifactOf>
std::shared_ptr<const ShaderRecompiler::RectListShaders> PrepareRequestedRectanglePair(Prepared& prepared,
    const Vertices& vertices, const Fragments& fragments, std::uint64_t vertexId, std::uint64_t fragmentId,
    const ShaderRecompiler::SpirvTarget& target, ArtifactOf&& artifactOf) {
    const auto vertex = std::find_if(vertices.begin(), vertices.end(), [&](const auto& entry) { return artifactOf(entry).variantId == vertexId; });
    const auto fragment = std::find_if(fragments.begin(), fragments.end(), [&](const auto& entry) { return artifactOf(entry).variantId == fragmentId; });
    if (vertex == vertices.end() || fragment == fragments.end())
        throw std::runtime_error("AGC driver: requested rectangle stage artifact is missing");
    return PrepareRectanglePair(prepared, artifactOf(*vertex), artifactOf(*fragment), target);
}

} // namespace AgcDriver::DriverDetail
