import fs from 'node:fs/promises';
import path from 'node:path';
import { applyPipelineStateCompatibility } from './compatibility.mjs';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 dynamic pipeline boundary changed: ' + before.slice(0, 80));
  return source.replace(before, after);
}
export async function applyPipelineStateOverlay(root) {
  const base = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics');
  const edit = async (relative, transform) => {
    const file = path.join(base, relative);
    await fs.writeFile(file, transform(await fs.readFile(file, 'utf8')));
  };
  await edit('include/Context.hpp', source => replace(source,
    '    PFN_vkCmdSetScissor cmdSetScissor = nullptr;',
    '    PFN_vkCmdSetScissor cmdSetScissor = nullptr;\n    PFN_vkCmdSetBlendConstants cmdSetBlendConstants = nullptr;'));
  await edit('src/Resources.cpp', source => replace(source,
    '    functions.cmdSetScissor = context.Function<PFN_vkCmdSetScissor>("vkCmdSetScissor");',
    '    functions.cmdSetScissor = context.Function<PFN_vkCmdSetScissor>("vkCmdSetScissor");\n    functions.cmdSetBlendConstants = context.Function<PFN_vkCmdSetBlendConstants>("vkCmdSetBlendConstants");'));
  await edit('src/PipelineLibrary.cpp', source => {
    source = replace(source, 'constexpr std::array<VkDynamicState, 15> dynamicStates{', 'constexpr std::array<VkDynamicState, 16> dynamicStates{');
    return replace(source, '    VK_DYNAMIC_STATE_SCISSOR,', '    VK_DYNAMIC_STATE_SCISSOR,\n    VK_DYNAMIC_STATE_BLEND_CONSTANTS,');
  });
  await edit('src/Pipeline.cpp', source => {
    source = replace(source, '        std::vector<VkDynamicState> dynamicStates{VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};',
      '        std::vector<VkDynamicState> dynamicStates{VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR, VK_DYNAMIC_STATE_BLEND_CONSTANTS};');
    source = replace(source, '        std::copy(state.blendConstants.begin(), state.blendConstants.end(), blend.blendConstants);\n', '');
    source = replace(source, '    for (const auto value : state.blendConstants) appendKey(keys.fragmentOutput, value);\n', '');
    source = replace(source, '    for (const auto value : state.blendConstants) append(key, value);\n', '');
    const scissor = '    context.Resolved(&DeviceFunctions::cmdSetScissor, "vkCmdSetScissor")(commands, 0, 1, &state.scissor);';
    if (source.split(scissor).length !== 3) throw Error('Unexpected AnyPS5 dynamic draw-state callers');
    // Both ordinary continuation and back-face continuation carry the current state.
    // The alternate-channel bind retains these dynamic values in the same command buffer.
    return source.replaceAll(scissor, scissor + '\n    context.Resolved(&DeviceFunctions::cmdSetBlendConstants, "vkCmdSetBlendConstants")(commands, state.blendConstants.data());');
  });
  await edit('include/Pipeline.hpp', source => replace(source,
    '// scissor, depth bounds and depth bias are dynamic state set at Begin, so pipelines are shared by draws that differ only there',
    '// scissor, blend constants, depth bounds and depth bias are dynamic state set at Begin, so pipelines are shared by draws that differ only there'));
  await applyPipelineJournalStateOverlay(root);
  await applyPipelineStateCompatibility(root);
}

export async function applyPipelineJournalStateOverlay(root) {
  const file = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics/src/PipelineJournal.cpp');
  let source = await fs.readFile(file, 'utf8');
  source = replace(source, 'constexpr std::uint32_t FileFormat = 12u;', 'constexpr std::uint32_t FileFormat = 13u;');
  source = replace(source, '    canonical.blendConstants = state.blendConstants;', '    canonical.blendConstants = {};');
  await fs.writeFile(file, source);
}
