// SPDX-License-Identifier: GPL-2.0-only
#pragma once
#include "Recompiler.hpp"
#include <algorithm>
#include <chrono>
#include <future>
#include <list>
#include <map>
#include <mutex>
#include <string>
#include <tuple>

namespace ShaderRecompiler::GeneratedBarycentric {

// Module holders are shared and copy-on-write. Keep the actual words as well as
// their hashes: equal hashes alone must never admit another shader's helper.
struct Key {
    SharedSpirv vertex;
    SharedSpirv fragment;
    std::vector<std::uint32_t> fields;
    std::vector<std::string> extensions;
    bool operator<(const Key& other) const {
        const auto av = vertex.ContentHash(), af = fragment.ContentHash();
        const auto bv = other.vertex.ContentHash(), bf = other.fragment.ContentHash();
        const auto a = std::tie(av.low, av.high, af.low, af.high, fields, extensions);
        const auto b = std::tie(bv.low, bv.high, bf.low, bf.high, other.fields, other.extensions);
        if (a < b) return true;
        if (b < a) return false;
        if (vertex.Words().data() != other.vertex.Words().data()) {
            const auto order = std::lexicographical_compare_three_way(vertex.Words().begin(), vertex.Words().end(), other.vertex.Words().begin(), other.vertex.Words().end());
            if (order != 0) return order < 0;
        }
        return fragment.Words().data() != other.fragment.Words().data() &&
            std::lexicographical_compare(fragment.Words().begin(), fragment.Words().end(), other.fragment.Words().begin(), other.fragment.Words().end());
    }
    std::size_t Bytes() const {
        std::size_t bytes = sizeof(Key) + (vertex.size() + fragment.size() + fields.size()) * sizeof(std::uint32_t);
        for (const auto& extension : extensions) bytes += sizeof(std::string) + extension.size();
        return bytes;
    }
};

inline Key MakeKey(const RecompileResult& vertex, const RecompileResult& fragment, const SpirvTarget& target) {
    Key key{vertex.spirv, fragment.spirv, {}, {}};
    auto& out = key.fields;
    const auto add = [&](auto value) { out.push_back(static_cast<std::uint32_t>(value)); };
    add(vertex.parameterExports.size());
    for (const auto value : vertex.parameterExports) add(value);
    add(fragment.fragmentParameters.size());
    for (const auto& value : fragment.fragmentParameters) {
        add(value.location); add(value.sourceLocation); add(value.flat); add(value.perVertex);
        add(value.custom); add(value.flatP10); add(value.vertexOrder); add(value.flatP20);
    }
    const auto& emulation = fragment.barycentricEmulation;
    add(emulation.active); add(emulation.smooth); add(emulation.linear); add(emulation.smoothOffset);
    // Capture all target values by value, including span contents and optional
    // limits. A replacement device/target cannot reuse a less restrictive key.
    add(target.vulkanVersion); add(target.spirvVersion); add(target.subgroupSize); add(target.bdaAbiVersion);
    add(target.supportedCapabilities.size());
    for (const auto value : target.supportedCapabilities) add(value);
    for (const auto value : target.supportedExtensions) key.extensions.emplace_back(value);
    add(target.fragmentShaderBarycentricEnabled);
    for (const auto value : target.maxWorkgroupSize) add(value);
    add(target.maxWorkgroupInvocations); add(target.maxWorkgroupSharedMemoryBytes);
    add(target.mesh.has_value());
    if (target.mesh) {
        const auto& value = *target.mesh;
        for (const auto size : value.maxWorkgroupSize) add(size);
        add(value.maxWorkgroupInvocations); add(value.maxSharedMemoryBytes); add(value.maxOutputVertices);
        add(value.maxOutputPrimitives); add(value.maxOutputComponents); add(value.maxOutputMemoryBytes);
        add(value.outputPerVertexGranularity); add(value.outputPerPrimitiveGranularity);
    }
    add(target.tessellation.has_value());
    if (target.tessellation) {
        const auto& value = *target.tessellation;
        add(value.maxPatchSize); add(value.maxControlPerVertexInputComponents); add(value.maxControlPerVertexOutputComponents);
        add(value.maxControlPerPatchOutputComponents); add(value.maxControlTotalOutputComponents);
        add(value.maxEvaluationInputComponents); add(value.maxEvaluationOutputComponents);
    }
    add(target.nonConstantImageOffsets); add(target.srgbDecodeFormats); add(target.narrowSubgroupClock);
    add(target.fixedPushSlots); add(target.float64DenormPreserve); add(target.registrationModules);
    add(target.registrationWordLimit); add(target.vertexSubgroups); add(target.float16DenormPreserve);
    add(target.spannedWaves); add(target.robustBufferAccess2); add(target.depthRangeRemap);
    add(target.float32FlushToZero); add(target.waveLdsMemoryBarriers); add(target.float32DenormPreserve);
    add(target.fusedExactArithmetic); add(target.largePixelFunctionLdsBuffer); add(target.pixelFunctionStorageDwords);
    add(target.deviceScopeLdsMemoryBarriers);
    return key;
}

inline std::size_t ResultBytes(const RecompileResult& value) { return sizeof(value) + value.spirv.size() * sizeof(std::uint32_t); }
inline std::size_t ResultBytes(const BarycentricTessellationShaders& value) { return ResultBytes(value.control) + ResultBytes(value.evaluation); }

template<class Value>
class Cache {
    struct Entry {
        std::shared_future<std::shared_ptr<const Value>> ready;
        std::size_t bytes;
        typename std::list<Key>::iterator recent;
    };
    std::mutex mutex;
    std::map<Key, Entry> entries;
    std::list<Key> recent;
    std::size_t bytes = 0;
    const std::size_t maxEntries;
    const std::size_t maxBytes;

    void Trim() {
        for (auto at = recent.begin(); (entries.size() > maxEntries || bytes > maxBytes) && at != recent.end();) {
            const auto found = entries.find(*at);
            if (found->second.ready.wait_for(std::chrono::seconds(0)) != std::future_status::ready) { ++at; continue; }
            bytes -= found->second.bytes;
            entries.erase(found);
            at = recent.erase(at);
        }
    }
public:
    explicit Cache(std::size_t maxEntries = 256, std::size_t maxBytes = 32u * 1024u * 1024u) : maxEntries(maxEntries), maxBytes(maxBytes) {}
    template<class Build>
    Value Get(Key key, Build&& build) {
        std::shared_future<std::shared_ptr<const Value>> future;
        std::shared_ptr<std::promise<std::shared_ptr<const Value>>> owner;
        {
            std::lock_guard lock(mutex);
            const auto found = entries.find(key);
            if (found != entries.end()) {
                recent.splice(recent.end(), recent, found->second.recent);
                future = found->second.ready;
            } else {
                owner = std::make_shared<std::promise<std::shared_ptr<const Value>>>();
                future = owner->get_future().share();
                recent.push_back(key);
                const auto cost = key.Bytes() * 2 + sizeof(Entry);
                entries.emplace(key, Entry{future, cost, std::prev(recent.end())});
                bytes += cost;
                Trim();
            }
        }
        if (owner) {
            try {
                auto value = std::make_shared<const Value>(build());
                {
                    std::lock_guard lock(mutex);
                    auto& entry = entries.find(key)->second;
                    const auto cost = ResultBytes(*value);
                    entry.bytes += cost;
                    bytes += cost;
                }
                owner->set_value(std::move(value));
            } catch (...) { owner->set_exception(std::current_exception()); }
            std::lock_guard lock(mutex);
            Trim();
        }
        return *future.get();
    }
};

} // namespace ShaderRecompiler::GeneratedBarycentric
