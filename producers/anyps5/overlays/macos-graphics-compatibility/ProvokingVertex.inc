struct ProvokingRewrite {
    State state;
    Pm4::DrawParameters draw;
    std::shared_ptr<Buffer> indices;
    std::uint32_t highest = 0;
};

#ifdef __APPLE__
std::optional<ProvokingRewrite> rewriteLastProvokingVertex(const Context& context, const State& state, const Pm4::DrawParameters& draw, std::span<const CompiledShader> shaders) {
    if (state.provokingVertexMode != VK_PROVOKING_VERTEX_MODE_LAST_VERTEX_EXT || context.provokingVertexLast || draw.indirect) return std::nullopt;
    if (state.topology == VK_PRIMITIVE_TOPOLOGY_POINT_LIST || state.rectList || state.stages.path != ShaderPath::Vertex || state.stages.mesh || state.stages.tessellation) return std::nullopt;
    if (!ReadsProvokingVertex(shaders) || draw.indexCount == 0 || draw.instanceCount == 0) return std::nullopt;
    std::vector<std::uint32_t> source(draw.indexCount);
    std::optional<std::uint32_t> restart;
    if (draw.indexed) {
        Require(draw.indexSize == 2 || draw.indexSize == 4, "only uint16 and uint32 index buffers are supported");
        const auto bytes = static_cast<std::size_t>(draw.indexCount) * draw.indexSize;
        GuestMemory::CheckRange(reinterpret_cast<const void*>(draw.indexAddress), bytes, draw.indexSize);
        GuestMemory::FlushGpuWrites(draw.indexAddress, bytes);
        std::vector<std::byte> raw(bytes);
        GuestMemory::Read(draw.indexAddress, raw, draw.indexSize);
        for (std::size_t i = 0; i < source.size(); ++i) {
            if (draw.indexSize == 2) {
                std::uint16_t index = 0;
                std::memcpy(&index, raw.data() + i * 2, 2);
                source[i] = index;
            } else std::memcpy(&source[i], raw.data() + i * 4, 4);
        }
        if (state.primitiveRestart) restart = draw.indexSize == 2 ? 0xffffu : 0xffffffffu;
    } else {
        for (std::uint32_t i = 0; i < draw.indexCount; ++i) source[i] = i;
    }
    auto list = LastVertexFirstList(state.topology, source, restart, state.quadList);
    Require(list.size() <= std::numeric_limits<std::uint32_t>::max(), "expanded index count overflow");
    ProvokingRewrite rewrite{state, draw, nullptr, 0};
    rewrite.state.provokingVertexMode = VK_PROVOKING_VERTEX_MODE_FIRST_VERTEX_EXT;
    rewrite.state.topology = state.topology == VK_PRIMITIVE_TOPOLOGY_LINE_LIST || state.topology == VK_PRIMITIVE_TOPOLOGY_LINE_STRIP ? VK_PRIMITIVE_TOPOLOGY_LINE_LIST : VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
    rewrite.state.primitiveRestart = false;
    rewrite.state.quadList = false;
    rewrite.draw.indexed = true;
    rewrite.draw.indexAddress = 0;
    rewrite.draw.indexSize = 4;
    rewrite.draw.indexCount = static_cast<std::uint32_t>(list.size());
    rewrite.draw.flags = 0;
    if (list.empty()) return rewrite;
    rewrite.highest = *std::max_element(list.begin(), list.end());
    if (const auto zeroFrom = ZeroFetchVertex(shaders.front().program->vertexAttributes)) {
        const auto limit = *zeroFrom > draw.firstVertex ? *zeroFrom - draw.firstVertex : 0u;
        if (rewrite.highest > limit) rewrite.highest = ClampDrawIndices(std::as_writable_bytes(std::span(list)), 4, false, limit).value_or(0u);
    }
    rewrite.indices = std::make_shared<Buffer>(context, list.size() * sizeof(std::uint32_t), VK_BUFFER_USAGE_INDEX_BUFFER_BIT);
    std::memcpy(rewrite.indices->Bytes().data(), list.data(), list.size() * sizeof(std::uint32_t));
    return rewrite;
}
#endif
