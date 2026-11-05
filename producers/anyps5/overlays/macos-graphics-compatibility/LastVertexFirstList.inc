// Rotate each primitive's last vertex to its first slot while preserving winding.
inline std::vector<std::uint32_t> LastVertexFirstList(VkPrimitiveTopology topology, std::span<const std::uint32_t> indices, std::optional<std::uint32_t> restart, bool quads = false) {
    std::vector<std::uint32_t> list;
    const auto emit = [&](std::span<const std::uint32_t> run) {
        const auto n = run.size();
        if (quads) {
            for (std::size_t i = 0; i + 4 <= n; i += 4) list.insert(list.end(), {run[i + 3], run[i], run[i + 1], run[i + 3], run[i + 1], run[i + 2]});
            return;
        }
        switch (topology) {
        case VK_PRIMITIVE_TOPOLOGY_LINE_LIST:
            for (std::size_t i = 0; i + 2 <= n; i += 2) list.insert(list.end(), {run[i + 1], run[i]});
            break;
        case VK_PRIMITIVE_TOPOLOGY_LINE_STRIP:
            for (std::size_t i = 0; i + 2 <= n; ++i) list.insert(list.end(), {run[i + 1], run[i]});
            break;
        case VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST:
            for (std::size_t i = 0; i + 3 <= n; i += 3) list.insert(list.end(), {run[i + 2], run[i], run[i + 1]});
            break;
        case VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP:
            for (std::size_t i = 0; i + 3 <= n; ++i)
                if (i % 2 == 0) list.insert(list.end(), {run[i + 2], run[i], run[i + 1]});
                else list.insert(list.end(), {run[i + 2], run[i + 1], run[i]});
            break;
        case VK_PRIMITIVE_TOPOLOGY_TRIANGLE_FAN:
            for (std::size_t i = 0; i + 3 <= n; ++i) list.insert(list.end(), {run[i + 2], run[0], run[i + 1]});
            break;
        default:
            Require(false, "last provoking vertex is unsupported for this primitive topology");
        }
    };
    std::size_t begin = 0;
    for (std::size_t i = 0; i <= indices.size(); ++i) {
        if (i < indices.size() && (!restart || indices[i] != *restart)) continue;
        emit(indices.subspan(begin, i - begin));
        begin = i + 1;
    }
    return list;
}
