// SPDX-License-Identifier: GPL-2.0-only
#pragma once
#include "Recompiler.hpp"
#include <algorithm>
#include <cstdint>
#include <tuple>
#include <vector>

namespace AgcDriver::Graphics {

// Retain the immutable, copy-on-write module holders. Hashes order different
// modules quickly; actual words resolve equal hashes, including collisions.
// A holder address alone never admits a validation result.
struct ShaderValidationKey {
    std::vector<std::uint64_t> fields;
    std::vector<ShaderRecompiler::SharedSpirv> modules;

    void clear() { fields.clear(); modules.clear(); }
    void reserve(std::size_t size) { fields.reserve(size); }
    void push_back(std::uint64_t value) { fields.push_back(value); }

    bool operator==(const ShaderValidationKey& other) const {
        if (fields != other.fields || modules.size() != other.modules.size()) return false;
        for (std::size_t index = 0; index < modules.size(); ++index) {
            const auto a = modules[index].Words(), b = other.modules[index].Words();
            if (a.size() != b.size()) return false;
            if (a.data() != b.data() && !std::ranges::equal(a, b)) return false;
        }
        return true;
    }

    bool operator<(const ShaderValidationKey& other) const {
        if (fields != other.fields) return fields < other.fields;
        if (modules.size() != other.modules.size()) return modules.size() < other.modules.size();
        for (std::size_t index = 0; index < modules.size(); ++index) {
            const auto a = modules[index].Words(), b = other.modules[index].Words();
            if (a.data() == b.data() && a.size() == b.size()) continue;
            const auto ah = modules[index].ContentHash(), bh = other.modules[index].ContentHash();
            const auto left = std::tie(ah.low, ah.high), right = std::tie(bh.low, bh.high);
            if (left != right) return left < right;
            const auto order = std::lexicographical_compare_three_way(a.begin(), a.end(), b.begin(), b.end());
            if (order != 0) return order < 0;
        }
        return false;
    }
};

}
