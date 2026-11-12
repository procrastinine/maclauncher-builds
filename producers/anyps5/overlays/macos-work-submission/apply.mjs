import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
        throw Error('AnyPS5 work submission boundary changed: ' + before.slice(0, 96));
    return source.replace(before, after);
}
const apple = (before, after) => '#ifdef __APPLE__\n' + after + '\n#else\n' + before + '\n#endif';

export async function applyWorkSubmissionOverlay(root) {
    const changes = [];
    const edit = async (relative, transform) => {
        const file = path.join(root, relative);
        await fs.writeFile(file, transform(await fs.readFile(file, 'utf8')));
        changes.push(relative);
    };
    const graphics = 'core/libs/prx/libSceAgcDriver/Graphics/';
    const driver = 'core/libs/prx/libSceAgcDriver/Execution/src/Driver/';
    await edit(graphics + 'include/Context.hpp', source => {
        source = replace(source, '#include <optional>', '#include <optional>\n#include <set>');
        return replace(source, 'inline void Require(bool condition, const std::string& reason) {', `#ifdef __APPLE__
struct UnrenderableDraw : std::runtime_error {
    using std::runtime_error::runtime_error;
};

inline void ReportSkippedWork(const char* kind, const char* reason) {
    static std::mutex mutex;
    static std::set<std::string> reported;
    std::lock_guard lock(mutex);
    if (reported.insert(reason).second) std::fprintf(stderr, "[gpu] %s skipped: %s\\n", kind, reason);
}
#endif

inline void Require(bool condition, const std::string& reason) {`);
    });
    await edit('core/shader/recompiler/Recompiler.hpp', source => {
        source = replace(source, '#include <span>', '#include <span>\n#include <stdexcept>');
        return replace(source, 'struct SpirvTarget {', `#ifdef __APPLE__
struct UnsupportedResourceBinding : std::runtime_error {
    using std::runtime_error::runtime_error;
};
#endif

struct SpirvTarget {`);
    });
    await edit(graphics + 'src/ShaderResources.cpp', source => {
        for (const [condition, reason] of [
            ['descriptor.Type() == 0u', 'buffer descriptor uses an unsupported type'],
            ['byteSize <= context.limits.maxStorageBufferRange', 'shader buffer exceeds descriptor range limit'],
            ['target == nullptr || !overlap(address, size, target->MemoryAddress(), target->bytes)', 'shader buffer aliases the render target'],
        ]) {
            const before = '    Require(' + condition + ', "' + reason + '");';
            source = replace(source, before, apple(before, '    if (!(' + condition + ')) throw UnrenderableDraw("AGC graphics: ' + reason + '");'));
        }
        return source;
    });
    await edit(graphics + 'src/GuestSamplerResource.cpp', source => {
        const signature = 'GuestSamplerResource DecodeSamplerResource(std::span<const std::uint32_t> words, bool unnormalizedProven, bool forceDegammaPaired, bool integerBorder) {';
        source = replace(source, signature, signature + '\n#ifdef __APPLE__\n    try {\n#endif');
        return replace(source, '    return result;\n}\n\nbool HoldsLodAtZero', `    return result;
#ifdef __APPLE__
    } catch (const std::runtime_error& error) {
        throw UnrenderableDraw(error.what());
    }
#endif
}

bool HoldsLodAtZero`);
    });
    await edit(graphics + 'src/Sampler.cpp', source => {
        const first = source.indexOf('    void Sampler::Validate(');
        const last = source.indexOf('\n    Sampler::Sampler(', first);
        if (first < 0 || last < 0) throw Error('AnyPS5 sampler validation boundary changed');
        let validation = source.slice(first, last);
        validation = validation.replace(' {\n', ` {
#ifdef __APPLE__
        const auto refuse = [](bool condition, const char* reason) {
            if (!condition) throw UnrenderableDraw(std::string("AGC graphics: ") + reason);
        };
#else
        const auto refuse = [](bool condition, const char* reason) { Require(condition, reason); };
#endif
`);
        validation = validation.replaceAll('        Require(', '        refuse(').replaceAll('            Require(', '            refuse(');
        const bias = '        refuse(ShaderAppliesLodBias(descriptor) || (descriptor.lodBias >= -context.limits.maxSamplerLodBias && descriptor.lodBias <= context.limits.maxSamplerLodBias), "guest sampler descriptor requests a LOD bias beyond the device limit");';
        validation = replace(validation, bias, '#ifndef __APPLE__\n' + bias + '\n#endif');
        source = source.slice(0, first) + validation + source.slice(last);
        const before = '        info.mipLodBias = ShaderAppliesLodBias(descriptor) ? 0.0f : descriptor.lodBias;';
        return replace(source, before, apple(before, '        info.mipLodBias = ShaderAppliesLodBias(descriptor) ? 0.0f : std::clamp(descriptor.lodBias, -context.limits.maxSamplerLodBias, context.limits.maxSamplerLodBias);'));
    });
    await edit('core/shader/recompiler/Optimization/src/ResourceMaterializer.cpp', source => {
        const first = source.indexOf('        if (decoded.Type() != 0u) {', source.indexOf('void materializeTables('));
        const last = source.indexOf('\n    }\n    if (snapshot.flattenedSrt', first);
        if (first < 0 || last < 0) throw Error('AnyPS5 buffer materialization boundary changed');
        const before = source.slice(first, last);
        const after = `        const bool otherType = decoded.Type() != 0u;
        if (otherType || (plan.stage != IrShaderStage::Compute && decoded.AddTid())) {
            static std::atomic<bool> reportedType{false}, reportedAddTid{false};
            if (!(otherType ? reportedType : reportedAddTid).exchange(true)) std::fprintf(stderr, "[recompiler] a %s buffer descriptor (%08x %08x %08x %08x) is bound as a null buffer\\n", otherType ? "non-buffer" : "graphics-stage ADD_TID", decoded.fields[0], decoded.fields[1], decoded.fields[2], decoded.fields[3]);
            std::fill_n(snapshot.buffers.at(i).dwords.begin(), 4, 0u);
        }`;
        source = source.slice(0, first) + apple(before, after) + source.slice(last);
        const failure = '    if (!match.mode.has_value()) throw std::runtime_error(match.detail);';
        return replace(source, failure, apple(failure, '    if (!match.mode.has_value()) throw UnsupportedResourceBinding(match.detail);'));
    });
    await edit(driver + 'Diagnostics.cpp', source => {
        const before = '    static const bool skip = std::getenv("APS5_SKIP_REFUSED_DRAWS") != nullptr;\n    return skip;';
        source = replace(source, before, apple(before, '    return true;'));
        const log = '    std::fprintf(stderr, "[gpu] APS5_SKIP_REFUSED_DRAWS: skipping the draws that use shader 0x%llx: %.*s\\n", static_cast<unsigned long long>(refused.address), static_cast<int>(line.size()), line.data());';
        return replace(source, log, apple(log, log.replace('APS5_SKIP_REFUSED_DRAWS: ', '')));
    });
    await edit(driver + 'Packets/PacketExecution.cpp', source => {
        const dispatch = '            if (opcode == 0x15) timed(&WorkerProfile::dispatchMs, [&] { dispatch(queue, packet, submission); });\n            else timed(&WorkerProfile::dispatchMs, [&] { dispatchIndirect(queue, packet, submission); });';
        source = replace(source, dispatch, '#ifdef __APPLE__\n            try {\n#endif\n' + dispatch + `
#ifdef __APPLE__
            } catch (const Graphics::UnrenderableDraw& error) {
                Graphics::ReportSkippedWork("dispatch", error.what());
            } catch (const ShaderRecompiler::UnsupportedResourceBinding& error) {
                Graphics::ReportSkippedWork("dispatch", error.what());
            }
#endif`);
        const rejected = '                        throw std::runtime_error(rejected);';
        source = replace(source, rejected, apple(rejected, '                        throw Graphics::UnrenderableDraw(rejected);'));
        const catchRefused = '                } catch (const RefusedDraw& refused) {';
        return replace(source, catchRefused, `#ifdef __APPLE__
                } catch (const Graphics::UnrenderableDraw& error) {
                    CaptureTrace::Log("draw-skipped submission=%llu offset=%zu reason=%.256s", static_cast<unsigned long long>(submission.serial), cursor, error.what());
                    countSkip(Graphics::DrawSkip::Thrown);
                    Graphics::ReportSkippedWork("draw", error.what());
                } catch (const ShaderRecompiler::UnsupportedResourceBinding& error) {
                    CaptureTrace::Log("draw-skipped submission=%llu offset=%zu reason=%.256s", static_cast<unsigned long long>(submission.serial), cursor, error.what());
                    countSkip(Graphics::DrawSkip::Thrown);
                    Graphics::ReportSkippedWork("draw", error.what());
#endif
` + catchRefused);
    });
    await edit(driver + 'Dispatch/Dispatch.cpp', source => {
        const before = '            throw std::runtime_error(where + reason);';
        source = replace(source, before, `#ifdef __APPLE__
            if (dynamic_cast<const ShaderRecompiler::UnsupportedResourceBinding*>(&error)) throw ShaderRecompiler::UnsupportedResourceBinding(where + reason);
#endif
` + before);
        const rethrow = '    const auto rethrow = [&](const std::exception& error) {';
        source = replace(source, rethrow, rethrow + `
#ifdef __APPLE__
        if (dynamic_cast<const Graphics::UnrenderableDraw*>(&error) || dynamic_cast<const ShaderRecompiler::UnsupportedResourceBinding*>(&error)) {
            Graphics::ReportSkippedWork("dispatch", error.what());
            return true;
        }
#endif`);
        const deferred = '            } catch (const std::exception& error) {\n                char where[64];';
        return replace(source, deferred, `#ifdef __APPLE__
            } catch (const Graphics::UnrenderableDraw& error) {
                Graphics::ReportSkippedWork("dispatch", error.what());
            } catch (const ShaderRecompiler::UnsupportedResourceBinding& error) {
                Graphics::ReportSkippedWork("dispatch", error.what());
#endif
` + deferred);
    });
    await edit('core/shader/recompiler/CMakeLists.txt', source => replace(source,
        '    set(shaderCacheReviewedNames',
        // This exception classifies submission failures; it adds no shader input.
        '    set(shaderCacheReviewedNames\n            UnsupportedResourceBinding'));
    return changes;
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * scoped unrenderable draws:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/1e20f7ed49367daf273f2f44fad7c2d2713b6b50
 * unsupported bindings and one-time reporting:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/4c068b498ffe2b1099f94396395465da47bb4032
 * sampler refusals, dispatch handling and LOD limits:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/d9660e737773ef94f05732f534444a82fee62e98
 * typed sampler and descriptor failures:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/82dec53d861a2fc5377f3dde3b9454d233277910
 */
