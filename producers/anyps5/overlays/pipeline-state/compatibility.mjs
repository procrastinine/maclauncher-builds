import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw new Error('AnyPS5 dynamic pipeline compatibility changed: ' + before.slice(0, 80));
  return source.replace(before, after);
}

export async function applyPipelineStateCompatibility(root) {
  const file = path.join(root, 'core/libs/prx/libSceAgcDriver/tests/Graphics.cpp');
  let source = await fs.readFile(file, 'utf8');
  const dynamicCheck = `
    if (const auto* dynamic = infos[0].pDynamicState) {
        Require(std::find(dynamic->pDynamicStates, dynamic->pDynamicStates + dynamic->dynamicStateCount, VK_DYNAMIC_STATE_BLEND_CONSTANTS) != dynamic->pDynamicStates + dynamic->dynamicStateCount,
            "the pipeline or library did not declare dynamic blend constants");
    }`;
  for (const message of ['mock expects exactly one graphics pipeline per call', 'the sample location mock expects one pipeline per call']) {
    const check = '    Require(count == 1, "' + message + '");';
    source = replace(source, check, check + dynamicCheck);
  }
  source = replace(source, 'PFN_vkVoidFunction VKAPI_CALL mockProc(VkDevice, const char* name) {',
    `std::vector<std::array<float, 4>> capturedBlendConstants;
VKAPI_ATTR void VKAPI_CALL mockSetBlendConstants(VkCommandBuffer, const float* values) {
    capturedBlendConstants.push_back({values[0], values[1], values[2], values[3]});
}

PFN_vkVoidFunction VKAPI_CALL mockProc(VkDevice, const char* name) {`);
  source = replace(source, '        {"vkCmdBindPipeline", reinterpret_cast<PFN_vkVoidFunction>(mockCmdBindPipeline)},',
    '        {"vkCmdBindPipeline", reinterpret_cast<PFN_vkVoidFunction>(mockCmdBindPipeline)},\n        {"vkCmdSetBlendConstants", reinterpret_cast<PFN_vkVoidFunction>(mockSetBlendConstants)},');
  source = replace(source, '        {"vkCmdSetScissor", reinterpret_cast<PFN_vkVoidFunction>(sampleLocationSetScissor)}',
    '        {"vkCmdSetScissor", reinterpret_cast<PFN_vkVoidFunction>(sampleLocationSetScissor)},\n        {"vkCmdSetBlendConstants", reinterpret_cast<PFN_vkVoidFunction>(mockSetBlendConstants)}');
  source = replace(source, '            pipeline.Begin(makeHandle<VkCommandBuffer>(), *framebuffer, {64, 64}, state);',
    `            const auto commands = makeHandle<VkCommandBuffer>();
            state.blendConstants = {0.125f, 0.25f, 0.5f, 0.75f};
            pipeline.Begin(commands, *framebuffer, {64, 64}, state);
            Require(!capturedBlendConstants.empty() && capturedBlendConstants.back() == state.blendConstants, "begin did not set the current blend constants");
            state.blendConstants = {0.75f, 0.5f, 0.25f, 0.125f};
            pipeline.Continue(commands, state);
            Require(capturedBlendConstants.back() == state.blendConstants, "continuation retained another draw's blend constants");`);
  source = replace(source, '    Require(again == first && mock.pipelineCreateCount == created, "creating the buffer pool dropped a cached pipeline of the live device");',
    `    Require(again == first && mock.pipelineCreateCount == created, "creating the buffer pool dropped a cached pipeline of the live device");
    State constants{};
    constants.blendConstants = {0.125f, 0.25f, 0.5f, 0.75f};
    auto changedConstants = CachedPipeline(context, constants, VertexInputLayout{}, resources, shaders);
    Require(changedConstants == first && mock.pipelineCreateCount == created, "changing dynamic blend constants compiled another pipeline");
    const auto librariesBefore = PipelineLibraryCountersOf(context.device);
    Require(Pipeline::Prebuild(context, constants, VertexInputLayout{}, resources, shaders), "the blend-constant pipeline libraries were not reusable");
    const auto librariesAfter = PipelineLibraryCountersOf(context.device);
    Require(librariesBefore.built == librariesAfter.built, "changing dynamic blend constants compiled another pipeline library");
    std::vector<std::byte> originalKey, dynamicKey, staticKey;
    BuildPipelineStoreKey(originalKey, context, State{}, VertexInputLayout{}, resources, shaders, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL);
    BuildPipelineStoreKey(dynamicKey, context, constants, VertexInputLayout{}, resources, shaders, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL);
    Require(originalKey == dynamicKey, "blend constants remained in the static pipeline key");
    constants.topology = constants.topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST ? VK_PRIMITIVE_TOPOLOGY_LINE_LIST : VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
    BuildPipelineStoreKey(staticKey, context, constants, VertexInputLayout{}, resources, shaders, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL);
    Require(staticKey != dynamicKey, "the dynamic key also lost a static primitive-topology distinction");
    changedConstants.reset();`);
  const canonicalCheck = source.split('\n').find(line => line.includes('"the canonical state kept or dropped the wrong fields"'));
  if (!canonicalCheck) throw new Error('AnyPS5 canonical pipeline state check is missing');
  source = replace(source, canonicalCheck, canonicalCheck + '\n        Require(recipe.state.blendConstants == std::array<float, 4>{}, "the canonical recipe retained dynamic blend constants");');
  await fs.writeFile(file, source);
  return ['core/libs/prx/libSceAgcDriver/tests/Graphics.cpp'];
}
