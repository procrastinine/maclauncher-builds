// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';
export function applyDrawPassStateOverlay(root) {
    const adapt = (file, before, after) => {
        const target = path.join(root, file), source = fs.readFileSync(target, 'utf8');
        if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) throw Error('AnyPS5 draw state boundary changed: ' + file);
        fs.writeFileSync(target, source.replace(before, after));
    };
    const base = 'core/libs/prx/libSceAgcDriver/Graphics/';
    adapt(base + 'include/Recorder.hpp', '    void SealPassWriteOnly();',
        '    bool SetDrawPassState(VkCommandBuffer commands, const VkViewport& viewport, const VkRect2D& scissor, const std::array<float, 4>& blend);\n' +
        '    void InvalidateDrawPassState(VkCommandBuffer commands);\n' +
        '    void SealPassWriteOnly();');
    adapt(base + 'include/Recorder.hpp', '        struct RenderPass {\n            bool open = false;',
        '        struct RenderPass {\n' +
        '            bool drawStateValid = false;\n' +
        '            VkViewport viewport{};\n' +
        '            VkRect2D scissor{};\n' +
        '            std::array<float, 4> blend{};\n' +
        '            bool open = false;');
    adapt(base + 'src/Recorder.cpp', 'void Recorder::SealPassWriteOnly() {',
        'bool Recorder::SetDrawPassState(VkCommandBuffer commands, const VkViewport& viewport, const VkRect2D& scissor, const std::array<float, 4>& blend) {\n' +
        '    if (open == nullptr || open->commands != commands) return false;\n' +
        '    auto& pass = open->renderPass;\n' +
        '    // Only a continued pass may reuse values. EndRenderPass resets this entire\n' +
        '    // structure, and every new Batch starts empty, including reused command handles.\n' +
        '    const bool reuse = pass.open && pass.drawStateValid;\n' +
        '    static_assert(sizeof(VkViewport) == 6 * sizeof(float));\n' +
        '    static_assert(sizeof(VkRect2D) == 4 * sizeof(std::uint32_t));\n' +
        '    if (!reuse || std::memcmp(&pass.viewport, &viewport, sizeof(viewport)) != 0)\n' +
        '        context.Resolved(&DeviceFunctions::cmdSetViewport, "vkCmdSetViewport")(commands, 0, 1, &viewport);\n' +
        '    if (!reuse || std::memcmp(&pass.scissor, &scissor, sizeof(scissor)) != 0)\n' +
        '        context.Resolved(&DeviceFunctions::cmdSetScissor, "vkCmdSetScissor")(commands, 0, 1, &scissor);\n' +
        '    if (!reuse || std::memcmp(pass.blend.data(), blend.data(), sizeof(blend)) != 0)\n' +
        '        context.Resolved(&DeviceFunctions::cmdSetBlendConstants, "vkCmdSetBlendConstants")(commands, blend.data());\n' +
        '    pass.viewport = viewport;\n' +
        '    pass.scissor = scissor;\n' +
        '    pass.blend = blend;\n' +
        '    pass.drawStateValid = true;\n' +
        '    return true;\n' +
        '}\n\n' +
        'void Recorder::InvalidateDrawPassState(VkCommandBuffer commands) {\n' +
        '    if (open != nullptr && open->commands == commands) open->renderPass.drawStateValid = false;\n' +
        '}\n\nvoid Recorder::SealPassWriteOnly() {');
    adapt(base + 'src/Pipeline.cpp', '#include "prx/libSceAgcDriver/Graphics/include/Pipeline.hpp"',
        '#include "prx/libSceAgcDriver/Graphics/include/Pipeline.hpp"\n#include "prx/libSceAgcDriver/Graphics/include/Recorder.hpp"');
    const original = '    context.Resolved(&DeviceFunctions::cmdSetViewport, "vkCmdSetViewport")(commands, 0, 1, &state.viewport);\n' +
        '    context.Resolved(&DeviceFunctions::cmdSetScissor, "vkCmdSetScissor")(commands, 0, 1, &state.scissor);\n' +
        '    context.Resolved(&DeviceFunctions::cmdSetBlendConstants, "vkCmdSetBlendConstants")(commands, state.blendConstants.data());';
    const pipeline = path.join(root, base + 'src/Pipeline.cpp');
    let source = fs.readFileSync(pipeline, 'utf8');
    if (source.split(original).length !== 3) throw Error('AnyPS5 draw-state writer count changed.');
    source = source.replaceAll(original,
        '    if (context.recorder == nullptr || !context.recorder->SetDrawPassState(commands, state.viewport, state.scissor, state.blendConstants)) {\n' +
        original.split('\n').map(line => '    ' + line).join('\n') + '\n    }');
    fs.writeFileSync(pipeline, source);
    adapt(base + 'src/SampleOrder.cpp',
        '        context.Resolved(&DeviceFunctions::cmdSetViewport, "vkCmdSetViewport")(commands, 0, 1, &viewport);',
        '        if (context.recorder != nullptr) context.recorder->InvalidateDrawPassState(commands);\n' +
        '        context.Resolved(&DeviceFunctions::cmdSetViewport, "vkCmdSetViewport")(commands, 0, 1, &viewport);');
}
