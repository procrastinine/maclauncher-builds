#ifdef __APPLE__
// Keep a loop body outside its continue construct so SPIRV-Cross retains the
// header phi copies when lowering the loop to Metal.
std::vector<std::uint32_t> SplitContinueBodies(std::vector<std::uint32_t> words) {
    if (words.size() < 5) return words;
    struct Block { std::size_t label = 0, terminator = 0; };
    struct Loop { std::uint32_t header, merge, target; std::size_t instruction; };
    std::unordered_map<std::uint32_t, Block> blocks;
    std::unordered_map<std::uint32_t, std::vector<std::uint32_t>> predecessors;
    std::vector<Loop> loops;
    const auto labelOperands = [](spv::Op op, std::size_t count) {
        std::vector<std::size_t> operands;
        if (op == spv::OpBranch && count >= 2) operands.push_back(1);
        if (op == spv::OpBranchConditional && count >= 4) operands = {2, 3};
        // The emitter's switch selectors are 32-bit values.
        if (op == spv::OpSwitch && count >= 3)
            for (std::size_t operand = 2; operand < count; operand += 2) operands.push_back(operand);
        return operands;
    };
    std::uint32_t current = 0;
    for (std::size_t cursor = 5; cursor < words.size();) {
        const auto count = words[cursor] >> 16u;
        const auto op = static_cast<spv::Op>(words[cursor] & 0xffffu);
        if (count == 0 || count > words.size() - cursor) return words;
        if (op == spv::OpLabel && count == 2) {
            current = words[cursor + 1];
            blocks[current].label = cursor;
        } else if (op == spv::OpLoopMerge && current != 0 && count >= 4) {
            loops.push_back({current, words[cursor + 1], words[cursor + 2], cursor});
        } else if (current != 0 && (op == spv::OpBranch || op == spv::OpBranchConditional || op == spv::OpSwitch || op == spv::OpReturn || op == spv::OpReturnValue || op == spv::OpKill || op == spv::OpUnreachable || op == spv::OpTerminateInvocation)) {
            blocks[current].terminator = cursor;
            for (const auto operand : labelOperands(op, count)) {
                auto& entries = predecessors[words[cursor + operand]];
                if (std::ranges::find(entries, current) == entries.end()) entries.push_back(current);
            }
            current = 0;
        }
        cursor += count;
    }
    // Instruction replacements retain original offsets until the final pass.
    // Each loop is planned completely before any replacement becomes visible.
    std::unordered_map<std::size_t, std::vector<std::uint32_t>> replacements, inserts;
    auto bound = words[3];
    for (const auto& loop : loops) {
        const auto foundHeader = blocks.find(loop.header);
        const auto entries = predecessors.find(loop.target);
        if (loop.target == loop.header || foundHeader == blocks.end() || entries == predecessors.end()) continue;
        const auto& header = foundHeader->second;
        if (header.terminator == 0) continue;
        const bool exitTestOnly = std::ranges::all_of(entries->second, [&](std::uint32_t from) {
            if (from == loop.header) return true;
            const auto found = blocks.find(from);
            if (found == blocks.end() || found->second.terminator == 0) return false;
            const auto at = found->second.terminator;
            return static_cast<spv::Op>(words[at] & 0xffffu) == spv::OpBranchConditional && (words[at + 2] == loop.merge || words[at + 3] == loop.merge);
        });
        if (!exitTestOnly) continue;
        std::vector<std::uint32_t> backEdges;
        for (const auto from : predecessors[loop.header]) {
            const auto found = blocks.find(from);
            if (found != blocks.end() && found->second.label > header.label && found->second.terminator != 0) backEdges.push_back(from);
        }
        if (backEdges.empty()) continue;
        auto nextBound = bound;
        if (nextBound == std::numeric_limits<std::uint32_t>::max()) continue;
        const auto added = nextBound++;
        std::unordered_map<std::size_t, std::vector<std::uint32_t>> planned;
        std::vector<std::uint32_t> block{(2u << 16u) | spv::OpLabel, added};
        bool valid = true;
        for (std::size_t cursor = header.label; cursor < header.terminator;) {
            const auto count = words[cursor] >> 16u;
            if (static_cast<spv::Op>(words[cursor] & 0xffffu) == spv::OpPhi) {
                if (count < 5 || (count & 1u) == 0) { valid = false; break; }
                std::vector<std::uint32_t> kept(words.begin() + cursor, words.begin() + cursor + 3), incoming;
                for (std::size_t operand = 3; operand + 1 < count; operand += 2) {
                    const auto parent = words[cursor + operand + 1];
                    auto& destination = std::ranges::find(backEdges, parent) != backEdges.end() ? incoming : kept;
                    destination.insert(destination.end(), {words[cursor + operand], parent});
                }
                if (incoming.size() != backEdges.size() * 2) { valid = false; break; }
                auto value = incoming[0];
                if (backEdges.size() > 1) {
                    if (nextBound == std::numeric_limits<std::uint32_t>::max()) { valid = false; break; }
                    value = nextBound++;
                    block.insert(block.end(), {static_cast<std::uint32_t>((3 + incoming.size()) << 16u) | spv::OpPhi, words[cursor + 1], value});
                    block.insert(block.end(), incoming.begin(), incoming.end());
                }
                kept.insert(kept.end(), {value, added});
                kept[0] = static_cast<std::uint32_t>(kept.size() << 16u) | spv::OpPhi;
                planned.emplace(cursor, std::move(kept));
            }
            cursor += count;
        }
        if (!valid) continue;
        auto merge = std::vector<std::uint32_t>(words.begin() + loop.instruction, words.begin() + loop.instruction + (words[loop.instruction] >> 16u));
        merge[2] = added;
        planned.emplace(loop.instruction, std::move(merge));
        std::size_t last = 0;
        for (const auto from : backEdges) {
            const auto terminator = blocks.at(from).terminator;
            const auto count = words[terminator] >> 16u;
            const auto prior = replacements.find(terminator);
            auto branch = prior == replacements.end() ? std::vector<std::uint32_t>(words.begin() + terminator, words.begin() + terminator + count) : prior->second;
            for (const auto operand : labelOperands(static_cast<spv::Op>(branch[0] & 0xffffu), count))
                if (branch[operand] == loop.header) branch[operand] = added;
            planned.emplace(terminator, std::move(branch));
            last = std::max(last, terminator);
        }
        block.insert(block.end(), {(2u << 16u) | spv::OpBranch, loop.header});
        auto& insertion = inserts[last];
        insertion.insert(insertion.end(), block.begin(), block.end());
        for (auto& [at, replacement] : planned) replacements.insert_or_assign(at, std::move(replacement));
        bound = nextBound;
    }
    if (inserts.empty()) return words;
    words[3] = bound;
    std::vector<std::uint32_t> result(words.begin(), words.begin() + 5);
    for (std::size_t cursor = 5; cursor < words.size();) {
        const auto count = words[cursor] >> 16u;
        if (const auto replacement = replacements.find(cursor); replacement != replacements.end()) result.insert(result.end(), replacement->second.begin(), replacement->second.end());
        else result.insert(result.end(), words.begin() + cursor, words.begin() + cursor + count);
        if (const auto insertion = inserts.find(cursor); insertion != inserts.end()) result.insert(result.end(), insertion->second.begin(), insertion->second.end());
        cursor += count;
    }
    return result;
}
#endif

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * SPIR-V loop continue-body splitting:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/1ed3666b7ec7dadebab5e9814d783f9f72fdd56b
 */
