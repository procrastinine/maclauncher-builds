export const changes = [
{file: "core/libs/prx/libSceAgcDriver/Execution/src/Driver/Draw/Draw.cpp", replacements: [
[`    }
    const auto& graphics = decode->state;
    auto& pixel = tail.pixel;
    pixel = decode->pixel;
`, `    }
    const auto& graphics = decode->state;
    if (graphics.stages.mesh && localDevice->Target().meshAsCompute) {
        const auto& mesh = *graphics.stages.mesh;
        const auto sharedBytes = static_cast<std::uint64_t>(mesh.ldsSizeDwords) * 4u + static_cast<std::uint64_t>(mesh.maxVertices) * 4u + 8u;
        const char* reason = !localDevice->Target().meshAsCompute ? "geometry-path draws" : drawParameters.indirect ? "indirect geometry-path draws" : sharedBytes > localDevice->Target().maxWorkgroupSharedMemoryBytes ? "geometry-path draws whose workgroup memory exceeds the compute limit" : nullptr;
        if (reason != nullptr) {
            static std::once_flag reported;
            std::call_once(reported, [reason] { std::fprintf(stderr, "[gpu] the device has no mesh shaders; %s are skipped\\n", reason); });
            return DrawVerdict::Nothing;
        }
    }
    auto& pixel = tail.pixel;
    pixel = decode->pixel;
`],
[`        }
    }
    std::vector<Graphics::GuestMemorySnapshot> snapshots;
    const auto snapshot = [&] {
`, `        }
    }
    if (!programs.empty() && programResults.front() != nullptr && programResults.front()->meshEmulation == ShaderRecompiler::MeshEmulationRole::Compute) {
        static const ShaderRecompiler::RecompileResult noFragment;
        const auto* fragment = programResults.back() != nullptr && programs.back().binary.stage == Stage::Fragment ? programResults.back() : &noFragment;
        results.push_back(ShaderRecompiler::BuildMeshPassthroughVertexShader(*programResults.front(), *fragment, localDevice->Target(), graphics.layerExports != 0));
        stages.insert(stages.begin() + 1, Graphics::CompiledShader{Stage::Vertex, &results.back(), 0});
    }
    std::vector<Graphics::GuestMemorySnapshot> snapshots;
    const auto snapshot = [&] {
`]
]},
{file: "core/libs/prx/libSceAgcDriver/Execution/src/VulkanDevice.cpp", replacements: [
[`    target.vertexSubgroups = (state->subgroup.supportedStages & VK_SHADER_STAGE_VERTEX_BIT) != 0;
`, `    target.vertexSubgroups = (state->subgroup.supportedStages & VK_SHADER_STAGE_VERTEX_BIT) != 0;
#ifdef __APPLE__
    target.meshAsCompute = !state->meshShader && state->pushDescriptor;
#endif
`],
[`    bool drawIndirectCount = false;`, `    bool drawIndirectCount = false;
    bool pushDescriptor = false;`],
[`    if (state->drawIndirectCount) deviceExtensions.push_back(VK_KHR_DRAW_INDIRECT_COUNT_EXTENSION_NAME);`, `    if (state->drawIndirectCount) deviceExtensions.push_back(VK_KHR_DRAW_INDIRECT_COUNT_EXTENSION_NAME);
#ifdef __APPLE__
    state->pushDescriptor = hasExtension(VK_KHR_PUSH_DESCRIPTOR_EXTENSION_NAME);
    if (state->pushDescriptor) deviceExtensions.push_back(VK_KHR_PUSH_DESCRIPTOR_EXTENSION_NAME);
#endif`],
[`    context.meshWave32 = state->meshWave32;`, `    context.meshWave32 = state->meshWave32;
    context.pushDescriptor = state->pushDescriptor;`]
]},
{file: "core/libs/prx/libSceAgcDriver/Graphics/include/Pipeline.hpp", replacements: [
[`    void PushConstants(VkCommandBuffer commands, VkShaderStageFlags stages, std::span<const std::byte, PipelinePushConstantBytes> bytes) const;
    // Forgets the Vulkan objects without destroying them: for entries of a device that is already gone.
`, `    void PushConstants(VkCommandBuffer commands, VkShaderStageFlags stages, std::span<const std::byte, PipelinePushConstantBytes> bytes) const;
    bool EmulatesMesh() const { return computePipeline != VK_NULL_HANDLE; }
    void DispatchMesh(VkCommandBuffer commands, std::uint32_t groups, std::uint32_t instances) const;
    // Forgets the Vulkan objects without destroying them: for entries of a device that is already gone.
`],
[`    VkPipeline secondChannel = VK_NULL_HANDLE;
    std::size_t attachments = 0;
`, `    VkPipeline secondChannel = VK_NULL_HANDLE;
    VkPipeline computePipeline = VK_NULL_HANDLE;
    VkDescriptorSetLayout meshBuffersLayout = VK_NULL_HANDLE;
    VkDescriptorSetLayout emptySetLayout = VK_NULL_HANDLE;
    std::size_t attachments = 0;
`]
]},
{file: "core/libs/prx/libSceAgcDriver/Graphics/include/Shaders.hpp", replacements: [
[`
inline VkPipelineStageFlags PipelineStages(std::span<const CompiledShader> shaders) {
`, `
inline bool EmulatedMesh(const CompiledShader& shader) {
    return shader.program != nullptr && shader.program->meshEmulation == ShaderRecompiler::MeshEmulationRole::Compute;
}

inline VkShaderStageFlagBits VulkanStage(const CompiledShader& shader) {
    return EmulatedMesh(shader) ? VK_SHADER_STAGE_COMPUTE_BIT : VulkanStage(shader.stage);
}

inline VkPipelineStageFlags PipelineStages(std::span<const CompiledShader> shaders) {
`],
[`    for (const auto& shader : shaders) {
        switch (VulkanStage(shader.stage)) {
            case VK_SHADER_STAGE_VERTEX_BIT: result |= VK_PIPELINE_STAGE_VERTEX_SHADER_BIT; break;
`, `    for (const auto& shader : shaders) {
        switch (VulkanStage(shader)) {
            case VK_SHADER_STAGE_VERTEX_BIT: result |= VK_PIPELINE_STAGE_VERTEX_SHADER_BIT; break;
`],
[`            case VK_SHADER_STAGE_FRAGMENT_BIT: result |= VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT; break;
            default: throw std::runtime_error("AGC graphics: invalid graphics pipeline stage");
`, `            case VK_SHADER_STAGE_FRAGMENT_BIT: result |= VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT; break;
            case VK_SHADER_STAGE_COMPUTE_BIT: result |= VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT; break;
            default: throw std::runtime_error("AGC graphics: invalid graphics pipeline stage");
`],
[`        Require(shader.program != nullptr, "missing compiled shader");
        if (!shader.program->pushConstants.empty() || shader.program->readsDepthRemapPush || shader.stage == ShaderRecompiler::ShaderStage::Mesh || shader.stage == ShaderRecompiler::ShaderStage::TessellationControl) result |= VulkanStage(shader.stage);
    }
`, `        Require(shader.program != nullptr, "missing compiled shader");
        if (!shader.program->pushConstants.empty() || shader.program->readsDepthRemapPush || shader.stage == ShaderRecompiler::ShaderStage::Mesh || shader.stage == ShaderRecompiler::ShaderStage::TessellationControl) result |= VulkanStage(shader);
    }
`]
]},
{file: "core/libs/prx/libSceAgcDriver/Graphics/src/Draw.cpp", replacements: [
[`            const auto& program = *shader.program;
            const bool generated = ((state.rectList || patches) && (shader.stage == Stage::TessellationControl || shader.stage == Stage::TessellationEvaluation)) || shader.stage == Stage::Geometry;
            if (!generated && program.PipelineVariantId() == 0) {
`, `            const auto& program = *shader.program;
            const bool generated = ((state.rectList || patches) && (shader.stage == Stage::TessellationControl || shader.stage == Stage::TessellationEvaluation)) || shader.stage == Stage::Geometry || program.meshEmulation == ShaderRecompiler::MeshEmulationRole::Passthrough;
            if (!generated && program.PipelineVariantId() == 0) {
`],
[`    std::vector<std::uint32_t> restartTable;
    std::uint32_t expandedIndexCount = 0;
`, `    std::vector<std::uint32_t> restartTable;
    const ShaderRecompiler::RecompileResult* emulatedMesh = nullptr;
    std::uint32_t expandedIndexCount = 0;
`],
[`        APS5_LOG_CHARS_OUT_DEBUG("Mesh path");
        Require(context.meshShader, "device does not support mesh shaders");
        const auto& mesh = *state.stages.mesh;
`, `        APS5_LOG_CHARS_OUT_DEBUG("Mesh path");
        const auto emulated = std::find_if(shaders.begin(), shaders.end(), [](const CompiledShader& shader) { return EmulatedMesh(shader); });
        if (emulated != shaders.end()) inputs.emulatedMesh = emulated->program;
        Require(context.meshShader || (inputs.emulatedMesh != nullptr && args == nullptr), "device does not support mesh shaders");
        const auto& mesh = *state.stages.mesh;
`],
[`            APS5_LOG_OUT_DEBUG("Mesh primitives=%u groups=%u", primitives, inputs.meshGroups);
            Require(inputs.meshGroups <= context.meshLimits.maxMeshWorkGroupCount[0] && draw.instanceCount <= context.meshLimits.maxMeshWorkGroupCount[1] && static_cast<std::uint64_t>(inputs.meshGroups) * draw.instanceCount <= context.meshLimits.maxMeshWorkGroupTotalCount, "mesh draw exceeds workgroup count limits");
        }
`, `            APS5_LOG_OUT_DEBUG("Mesh primitives=%u groups=%u", primitives, inputs.meshGroups);
            if (inputs.emulatedMesh != nullptr) {
                Require(inputs.meshGroups <= context.limits.maxComputeWorkGroupCount[0] && draw.instanceCount <= context.limits.maxComputeWorkGroupCount[1], "emulated mesh draw exceeds compute workgroup count limits");
            } else {
            Require(inputs.meshGroups <= context.meshLimits.maxMeshWorkGroupCount[0] && draw.instanceCount <= context.meshLimits.maxMeshWorkGroupCount[1] && static_cast<std::uint64_t>(inputs.meshGroups) * draw.instanceCount <= context.meshLimits.maxMeshWorkGroupTotalCount, "mesh draw exceeds workgroup count limits");
            }
        }
`],
[`    const auto* args = indirect != nullptr ? indirect->args : nullptr;
    if (state.stages.mesh && (args != nullptr || state.tessellationCapture != nullptr)) {
`, `    const auto* args = indirect != nullptr ? indirect->args : nullptr;
    if (inputs.emulatedMesh != nullptr) {
        const auto slots = ShaderRecompiler::EmulatedMeshSlots(*state.stages.mesh);
        context.Resolved(&DeviceFunctions::cmdDraw, "vkCmdDraw")(commands, inputs.meshGroups * draw.instanceCount * slots.primitives * 3u, 1, 0, 0);
        return;
    }
    if (state.stages.mesh && (args != nullptr || state.tessellationCapture != nullptr)) {
`],
[`    std::memcpy(block.data() + ShaderRecompiler::MeshDrawPushOffsetBytes, words.data(), sizeof(words));
    pipeline.PushConstants(commands, stages | VK_SHADER_STAGE_MESH_BIT_EXT, block);
`, `    std::memcpy(block.data() + ShaderRecompiler::MeshDrawPushOffsetBytes, words.data(), sizeof(words));
    if (pipeline.EmulatesMesh()) {
        pipeline.PushConstants(commands, stages, block);
        return;
    }
    pipeline.PushConstants(commands, stages | VK_SHADER_STAGE_MESH_BIT_EXT, block);
`],
[`
bool WriteOnlyPasses() {
`, `
void pushMeshBuffers(const Context& context, VkCommandBuffer commands, VkPipelineBindPoint bindPoint, VkPipelineLayout layout, const std::array<VkBuffer, 3>& buffers) {
    std::array<VkDescriptorBufferInfo, 3> infos{};
    std::array<VkWriteDescriptorSet, 3> writes{};
    for (std::uint32_t binding = 0; binding < buffers.size(); ++binding) {
        infos[binding] = {buffers[binding], 0, VK_WHOLE_SIZE};
        writes[binding] = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, nullptr, VK_NULL_HANDLE, binding, 0, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, nullptr, &infos[binding], nullptr};
    }
    context.Resolved(&DeviceFunctions::cmdPushDescriptorSet, "vkCmdPushDescriptorSetKHR")(commands, bindPoint, layout, ShaderRecompiler::MeshEmulationDescriptorSet, static_cast<std::uint32_t>(writes.size()), writes.data());
}

std::array<VkBuffer, 3> recordMeshEmulation(const Context& context, VkCommandBuffer commands, Recorder& recorder, const State& state, const Pm4::DrawParameters& draw, std::span<const CompiledShader> shaders, const DrawInputs& inputs, const RecordedDraw& record, const ShaderResources& resources, const std::shared_ptr<ShaderResources::DrawBindings>& drawBindings, const std::shared_ptr<Buffer>& meshArguments, const std::function<void(std::uint32_t)>& countBarrier) {
    Require(record.pipeline->EmulatesMesh(), "an emulated mesh draw got a pipeline without its compute stage");
    const auto slots = ShaderRecompiler::EmulatedMeshSlots(*state.stages.mesh);
    const auto groups = static_cast<std::uint64_t>(inputs.meshGroups) * draw.instanceCount;
    const auto recordWords = static_cast<std::uint64_t>(inputs.emulatedMesh->parameterExports.size()) + 1u;
    Require(groups <= std::numeric_limits<std::uint32_t>::max() / (static_cast<std::uint64_t>(slots.primitives) * 3u), "emulated mesh vertex count exceeds the draw representation");
    Require(groups * slots.vertices <= context.limits.maxStorageBufferRange / (recordWords * 16u) && groups * slots.primitives <= context.limits.maxStorageBufferRange / 16u, "emulated mesh records exceed storage buffer range limits");
    constexpr VkBufferUsageFlags usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
    auto vertices = std::make_shared<Buffer>(context, static_cast<std::size_t>(groups * slots.vertices * recordWords * 16u), usage);
    auto primitives = std::make_shared<Buffer>(context, static_cast<std::size_t>(groups * slots.primitives * 16u), usage);
    auto arguments = meshArguments != nullptr ? meshArguments : std::make_shared<Buffer>(context, ShaderRecompiler::MeshArgumentBytes, usage);
    recorder.Keep(vertices);
    recorder.Keep(primitives);
    recorder.Keep(arguments);
    const std::array<VkBuffer, 3> buffers{vertices->Handle(), primitives->Handle(), arguments->Handle()};
    const VkMemoryBarrier before{VK_STRUCTURE_TYPE_MEMORY_BARRIER, nullptr, VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT | VK_ACCESS_HOST_WRITE_BIT | VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_UNIFORM_READ_BIT};
    context.Resolved(&DeviceFunctions::cmdPipelineBarrier, "vkCmdPipelineBarrier")(commands, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT | VK_PIPELINE_STAGE_HOST_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &before, 0, nullptr, 0, nullptr);
    countBarrier(1);
    if (drawBindings != nullptr) {
        const auto set = drawBindings->allocation.set;
        const auto fragmentSet = drawBindings->fragmentAllocation.set;
        if (set != VK_NULL_HANDLE) context.Resolved(&DeviceFunctions::cmdBindDescriptorSets, "vkCmdBindDescriptorSets")(commands, VK_PIPELINE_BIND_POINT_COMPUTE, record.pipeline->Layout(), 0, 1, &set, 0, nullptr);
        if (fragmentSet != VK_NULL_HANDLE) context.Resolved(&DeviceFunctions::cmdBindDescriptorSets, "vkCmdBindDescriptorSets")(commands, VK_PIPELINE_BIND_POINT_COMPUTE, record.pipeline->Layout(), ShaderRecompiler::RuntimeAbi::FragmentDescriptorSet, 1, &fragmentSet, 0, nullptr);
    } else {
        resources.Bind(commands, VK_PIPELINE_BIND_POINT_COMPUTE, record.pipeline->Layout());
    }
    pushMeshBuffers(context, commands, VK_PIPELINE_BIND_POINT_COMPUTE, record.pipeline->Layout(), buffers);
    pushDrawConstants(*record.pipeline, commands, state, draw, shaders, resources, record.pushBytes, record.pushStages, meshArguments != nullptr ? meshArguments->DeviceAddress() : 0, !inputs.restartTable.empty());
    record.pipeline->DispatchMesh(commands, inputs.meshGroups, draw.instanceCount);
    const VkMemoryBarrier after{VK_STRUCTURE_TYPE_MEMORY_BARRIER, nullptr, VK_ACCESS_SHADER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT};
    context.Resolved(&DeviceFunctions::cmdPipelineBarrier, "vkCmdPipelineBarrier")(commands, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_VERTEX_SHADER_BIT, 0, 1, &after, 0, nullptr, 0, nullptr);
    countBarrier(1);
    return buffers;
}

bool WriteOnlyPasses() {
`],
[`    if (UsesMeshWindow(shaders)) PrepareMeshWindow(context);
    const auto start = recorder->StartDrawPass(passKey, capture || readsTarget || gpuIndirect || meshIndirect || captured || PixelFunctionLdsSubgroup(shaders) != 0u, fenced, passAccess);
    for (const auto& target : record.multisampleTargets) KeepMultisampleTarget_nid_no_patch(target);
`, `    if (UsesMeshWindow(shaders)) PrepareMeshWindow(context);
    const auto start = recorder->StartDrawPass(passKey, capture || readsTarget || gpuIndirect || meshIndirect || captured || inputs.emulatedMesh != nullptr || PixelFunctionLdsSubgroup(shaders) != 0u, fenced, passAccess);
    for (const auto& target : record.multisampleTargets) KeepMultisampleTarget_nid_no_patch(target);
`],
[`    std::shared_ptr<Buffer> meshArguments;
    VkBuffer argumentBuffer = VK_NULL_HANDLE;
`, `    std::shared_ptr<Buffer> meshArguments;
    std::array<VkBuffer, 3> meshBuffers{};
    VkBuffer argumentBuffer = VK_NULL_HANDLE;
`],
[`        }
        // Earlier recorded work (dispatches, the previous draw) wrote the images in the general
`, `        }
        if (inputs.emulatedMesh != nullptr) meshBuffers = recordMeshEmulation(context, commands, *recorder, state, draw, shaders, inputs, record, resources, drawBindings, meshArguments, countBarrier);
        // Earlier recorded work (dispatches, the previous draw) wrote the images in the general
`],
[`    APS5_LOG_CHARS_OUT_DEBUG("Resources bound");
    pushDrawConstants(*record.pipeline, commands, state, draw, shaders, resources, record.pushBytes, record.pushStages, meshArguments != nullptr ? meshArguments->DeviceAddress() : 0, !inputs.restartTable.empty());
`, `    APS5_LOG_CHARS_OUT_DEBUG("Resources bound");
    if (inputs.emulatedMesh != nullptr) pushMeshBuffers(context, commands, VK_PIPELINE_BIND_POINT_GRAPHICS, record.pipeline->Layout(), meshBuffers);
    pushDrawConstants(*record.pipeline, commands, state, draw, shaders, resources, record.pushBytes, record.pushStages, meshArguments != nullptr ? meshArguments->DeviceAddress() : 0, !inputs.restartTable.empty());
`],
[`    Require(lean || !multisampled, "multisampled draws are only rendered as recorded draws");
    for (const auto& binding : targets) {
`, `    Require(lean || !multisampled, "multisampled draws are only rendered as recorded draws");
    Require(lean || inputs.emulatedMesh == nullptr, "emulated mesh draws are only rendered as recorded draws");
    for (const auto& binding : targets) {
`],
[`        // hit's proof is the template's ProveCurrent and nothing needs completion work.
        if (recipeOut != nullptr && DrawRecipes() && cacheable && !outcome.waited && args == nullptr && resources->Reusable() && resolved.moved.empty() && !multisampled && !pipeline->ReordersSamples()) {
            auto recipe = std::make_shared<DrawRecipe>();
`, `        // hit's proof is the template's ProveCurrent and nothing needs completion work.
        if (recipeOut != nullptr && DrawRecipes() && cacheable && !outcome.waited && args == nullptr && resources->Reusable() && resolved.moved.empty() && !multisampled && inputs.emulatedMesh == nullptr && !pipeline->ReordersSamples()) {
            auto recipe = std::make_shared<DrawRecipe>();
`]
]},
{file: "core/libs/prx/libSceAgcDriver/Graphics/src/Pipeline.cpp", replacements: [
[`
bool libraryKeys(PipelineLibraryKeys& keys, const Context& context, const State& state, const VertexInputLayout& input, const PipelineSetLayouts& resources, std::span<const CompiledShader> shaders) {
    using Stage = ShaderRecompiler::ShaderStage;
    if (!context.graphicsPipelineLibrary || context.pipelineExecutableInfo || (state.stages.tessellation && !context.tessellationPipelineCache) || state.depthBiasPerFace || state.rectList || BarycentricPatches(state, shaders) || SplitsAlternateAlpha(state) || std::ranges::any_of(shaders, [](const CompiledShader& shader) { return shader.program != nullptr && shader.program->functionLdsBuffer; }) || UsesMeshWindow(shaders) || FragmentInterlock(shaders)) return false;
    keys = {};
    for (const auto& shader : shaders) {
`, `
bool libraryKeys(PipelineLibraryKeys& keys, const Context& context, const State& state, const VertexInputLayout& input, const PipelineSetLayouts& resources, std::span<const CompiledShader> shaders) {
    using Stage = ShaderRecompiler::ShaderStage;
    if (std::ranges::any_of(shaders, [](const CompiledShader& shader) { return EmulatedMesh(shader); })) return false;
    if (!context.graphicsPipelineLibrary || context.pipelineExecutableInfo || (state.stages.tessellation && !context.tessellationPipelineCache) || state.depthBiasPerFace || state.rectList || BarycentricPatches(state, shaders) || SplitsAlternateAlpha(state) || std::ranges::any_of(shaders, [](const CompiledShader& shader) { return shader.program != nullptr && shader.program->functionLdsBuffer; }) || UsesMeshWindow(shaders) || FragmentInterlock(shaders)) return false;
    keys = {};
    for (const auto& shader : shaders) {
`],
[`        Require(context.tessellationShader, "device does not support tessellation shaders");
        Require(state.stages.tessellation->inputControlPoints <= context.limits.maxTessellationPatchSize && state.stages.tessellation->outputControlPoints <= context.limits.maxTessellationPatchSize, "tessellation patch exceeds device limits");
    }
    if (state.stages.mesh) {
        Require(context.meshShader, "device does not support VK_EXT_mesh_shader");
        const auto& mesh = *state.stages.mesh;
        const auto invocations = state.stages.vertexWaveSize == 64u && context.subgroup.subgroupSize == 32u ? mesh.threadsPerGroup / 2u : mesh.threadsPerGroup;
        ValidateMeshLimits(context, mesh, invocations);
    }
    const auto pushStages = PushConstantStages(shaders);
    Require(pushStages == 0 || context.limits.maxPushConstantsSize >= PushBlockBytes(dynamicRendering), "graphics push constant range exceeds device limit");
`, `        Require(context.tessellationShader, "device does not support tessellation shaders");
        Require(state.stages.tessellation->inputControlPoints <= context.limits.maxTessellationPatchSize && state.stages.tessellation->outputControlPoints <= context.limits.maxTessellationPatchSize, "tessellation patch exceeds device limits");
    }
    const auto emulatedMesh = std::find_if(shaders.begin(), shaders.end(), [](const CompiledShader& shader) { return EmulatedMesh(shader); });
    const bool emulated = emulatedMesh != shaders.end();
    Require(!emulated || context.pushDescriptor, "emulated mesh records require push descriptors");
    if (state.stages.mesh) {
        const auto& mesh = *state.stages.mesh;
        const auto invocations = state.stages.vertexWaveSize == 64u && context.subgroup.subgroupSize == 32u ? mesh.threadsPerGroup / 2u : mesh.threadsPerGroup;
        if (emulated) {
            Require(invocations <= context.limits.maxComputeWorkGroupInvocations && invocations <= context.limits.maxComputeWorkGroupSize[0], "emulated mesh workgroup exceeds the compute limits");
            Require(static_cast<std::uint64_t>(mesh.ldsSizeDwords) * 4 + static_cast<std::uint64_t>(mesh.maxVertices) * 4 + 8 <= context.limits.maxComputeSharedMemorySize, "emulated mesh LDS exceeds the compute shared memory limit");
        } else {
            Require(context.meshShader, "device does not support VK_EXT_mesh_shader");
            ValidateMeshLimits(context, mesh, invocations);
        }
    }
    const auto pushStages = PushConstantStages(shaders);
    Require(pushStages == 0 || context.limits.maxPushConstantsSize >= PushBlockBytes(dynamicRendering), "graphics push constant range exceeds device limit");
`],
[`        for (std::uint32_t i = 0; i < shaders.size(); ++i) {
            const auto& shader = *shaders[i].program;
            _modules[i] = CreateShaderModule(context, shader.spirv.data(), shader.spirv.size() * sizeof(std::uint32_t), "vkCreateShaderModule graphics");
            const auto stage = VulkanStage(shaders[i].stage);
            stages[i].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
            stages[i].stage = stage;
            stages[i].module = _modules[i];
            stages[i].pName = "main";
            if (shaders[i].stage == ShaderRecompiler::ShaderStage::Mesh && context.meshWave32 && shader.hostSubgroupSize == 32u) stages[i].pNext = &meshSubgroup;
            specializations.emplace_back(shader);
            stages[i].pSpecializationInfo = specializations.back().Info();
        }
`, `        for (std::uint32_t i = 0; i < shaders.size(); ++i) {
            const auto& shader = *shaders[i].program;
            _modules[i] = CreateShaderModule(context, shader.spirv.data(), shader.spirv.size() * sizeof(std::uint32_t), "vkCreateShaderModule graphics");
            const auto stage = VulkanStage(shaders[i]);
            stages[i].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
            stages[i].stage = stage;
            stages[i].module = _modules[i];
            stages[i].pName = "main";
            if (!emulated && shaders[i].stage == ShaderRecompiler::ShaderStage::Mesh && context.meshWave32 && shader.hostSubgroupSize == 32u) stages[i].pNext = &meshSubgroup;
            specializations.emplace_back(shader);
            stages[i].pSpecializationInfo = specializations.back().Info();
        }
`],
[`        // layout, so later draws bind their own ShaderResources' set under it.
        const bool pixelLds = std::ranges::any_of(shaders, [](const CompiledShader& shader) { return shader.program != nullptr && shader.program->functionLdsBuffer; });
        const bool meshWindow = UsesMeshWindow(shaders);
        const auto pixelLdsLayouts = pixelLds || meshWindow ? PixelFunctionLdsSetLayouts(context) : PixelFunctionLdsLayouts{};
        const std::array<VkDescriptorSetLayout, 4> setLayouts{resources.main, (pixelLds || meshWindow) && !resources.split ? pixelLdsLayouts.empty : resources.fragment, pixelLds ? pixelLdsLayouts.buffer : pixelLdsLayouts.empty, meshWindow ? MeshWindowSetLayout(context) : VK_NULL_HANDLE};
        const VkPushConstantRange push{pushStages, 0, PipelinePushSlotBytes};
        const std::array<VkPushConstantRange, 2> slots{{{pushStagesOf(context), 0, PipelinePushSlotBytes}, {VK_SHADER_STAGE_FRAGMENT_BIT, PipelinePushSlotBytes, PipelinePushSlotBytes}}};
        VkPipelineLayoutCreateInfo layoutInfo{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
        layoutInfo.flags = pixelLds || meshWindow || !resources.split ? 0 : VK_PIPELINE_LAYOUT_CREATE_INDEPENDENT_SETS_BIT_EXT;
        layoutInfo.setLayoutCount = meshWindow ? 4u : pixelLds ? 3u : resources.split ? 2u : 1u;
        layoutInfo.pSetLayouts = setLayouts.data();
        layoutInfo.pushConstantRangeCount = dynamicRendering ? static_cast<std::uint32_t>(slots.size()) : pushStages != 0 ? 1 : 0;
        layoutInfo.pPushConstantRanges = dynamicRendering ? slots.data() : pushStages != 0 ? &push : nullptr;
        Check(context.Function<PFN_vkCreatePipelineLayout>("vkCreatePipelineLayout")(context.device, &layoutInfo, nullptr, &layout), "vkCreatePipelineLayout graphics");
        std::vector<VkAttachmentDescription> colors;
        std::vector<VkAttachmentReference> references(state.blends.size(), VkAttachmentReference{VK_ATTACHMENT_UNUSED, attachmentLayout});
        for (std::uint32_t index = 0; index < state.colors.size(); ++index) {
`, `        // layout, so later draws bind their own ShaderResources' set under it.
        const bool pixelLds = std::ranges::any_of(shaders, [](const CompiledShader& shader) { return shader.program != nullptr && shader.program->functionLdsBuffer; });
        const bool meshWindow = UsesMeshWindow(shaders);
        Require(!emulated || !pixelLds, "an emulated mesh pipeline with a pixel function LDS buffer is unsupported");
        Require(!emulated || !meshWindow, "an emulated mesh pipeline with a mesh window buffer is unsupported");
        const auto pixelLdsLayouts = pixelLds || meshWindow ? PixelFunctionLdsSetLayouts(context) : PixelFunctionLdsLayouts{};
        std::array<VkDescriptorSetLayout, 4> setLayouts{resources.main, (pixelLds || meshWindow) && !resources.split ? pixelLdsLayouts.empty : resources.fragment, pixelLds ? pixelLdsLayouts.buffer : pixelLdsLayouts.empty, meshWindow ? MeshWindowSetLayout(context) : VK_NULL_HANDLE};
        if (emulated) {
            const auto createSetLayout = [&](std::span<const VkDescriptorSetLayoutBinding> bindings, VkDescriptorSetLayoutCreateFlags flags) {
                VkDescriptorSetLayoutCreateInfo info{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
                info.flags = flags;
                info.bindingCount = static_cast<std::uint32_t>(bindings.size());
                info.pBindings = bindings.data();
                VkDescriptorSetLayout created = VK_NULL_HANDLE;
                Check(context.Function<PFN_vkCreateDescriptorSetLayout>("vkCreateDescriptorSetLayout")(context.device, &info, nullptr, &created), "vkCreateDescriptorSetLayout emulated mesh");
                return created;
            };
            std::array<VkDescriptorSetLayoutBinding, 3> bindings{};
            for (std::uint32_t binding = 0; binding < bindings.size(); ++binding) bindings[binding] = {binding, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT | VK_SHADER_STAGE_VERTEX_BIT, nullptr};
            meshBuffersLayout = createSetLayout(bindings, VK_DESCRIPTOR_SET_LAYOUT_CREATE_PUSH_DESCRIPTOR_BIT_KHR);
            if (!resources.split) emptySetLayout = createSetLayout({}, 0);
            setLayouts[ShaderRecompiler::RuntimeAbi::FragmentDescriptorSet] = resources.split ? resources.fragment : emptySetLayout;
            setLayouts[ShaderRecompiler::MeshEmulationDescriptorSet] = meshBuffersLayout;
        }
        const VkPushConstantRange push{pushStages, 0, PipelinePushSlotBytes};
        const std::array<VkPushConstantRange, 2> slots{{{pushStagesOf(context) | (emulated ? VK_SHADER_STAGE_COMPUTE_BIT : 0u), 0, PipelinePushSlotBytes}, {VK_SHADER_STAGE_FRAGMENT_BIT, PipelinePushSlotBytes, PipelinePushSlotBytes}}};
        VkPipelineLayoutCreateInfo layoutInfo{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
        layoutInfo.flags = pixelLds || meshWindow || !resources.split ? 0 : VK_PIPELINE_LAYOUT_CREATE_INDEPENDENT_SETS_BIT_EXT;
        layoutInfo.setLayoutCount = meshWindow ? 4u : emulated || pixelLds ? 3u : resources.split ? 2u : 1u;
        layoutInfo.pSetLayouts = setLayouts.data();
        layoutInfo.pushConstantRangeCount = dynamicRendering ? static_cast<std::uint32_t>(slots.size()) : pushStages != 0 ? 1 : 0;
        layoutInfo.pPushConstantRanges = dynamicRendering ? slots.data() : pushStages != 0 ? &push : nullptr;
        Check(context.Function<PFN_vkCreatePipelineLayout>("vkCreatePipelineLayout")(context.device, &layoutInfo, nullptr, &layout), "vkCreatePipelineLayout graphics");
        if (emulated) {
            const auto index = static_cast<std::size_t>(emulatedMesh - shaders.begin());
            VkComputePipelineCreateInfo computeInfo{VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
            computeInfo.stage = stages[index];
            computeInfo.layout = layout;
            Check(context.Function<PFN_vkCreateComputePipelines>("vkCreateComputePipelines")(context.device, context.pipelineCache, 1, &computeInfo, nullptr, &computePipeline), "vkCreateComputePipelines emulated mesh");
            stages.erase(stages.begin() + static_cast<std::ptrdiff_t>(index));
        }
        std::vector<VkAttachmentDescription> colors;
        std::vector<VkAttachmentReference> references(state.blends.size(), VkAttachmentReference{VK_ATTACHMENT_UNUSED, attachmentLayout});
        for (std::uint32_t index = 0; index < state.colors.size(); ++index) {
`],
[`            tessellation.patchControlPoints = state.stages.tessellation ? state.stages.tessellation->inputControlPoints : 3u;
            pipelineInfo.pTessellationState = &tessellation;
        }
        pipelineInfo.pVertexInputState = state.stages.mesh ? nullptr : &input;
        pipelineInfo.pInputAssemblyState = state.stages.mesh ? nullptr : &assembly;
        pipelineInfo.pViewportState = &viewports;
        pipelineInfo.pRasterizationState = &raster;
        pipelineInfo.pMultisampleState = &samples;
`, `            tessellation.patchControlPoints = state.stages.tessellation ? state.stages.tessellation->inputControlPoints : 3u;
            pipelineInfo.pTessellationState = &tessellation;
        }
        const VkPipelineVertexInputStateCreateInfo noInput{VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
        VkPipelineInputAssemblyStateCreateInfo triangles{VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};
        triangles.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
        pipelineInfo.pVertexInputState = emulated ? &noInput : state.stages.mesh ? nullptr : &input;
        pipelineInfo.pInputAssemblyState = emulated ? &triangles : state.stages.mesh ? nullptr : &assembly;
        pipelineInfo.pViewportState = &viewports;
        pipelineInfo.pRasterizationState = &raster;
        pipelineInfo.pMultisampleState = &samples;
`],
[`    if (pipeline) context.Function<PFN_vkDestroyPipeline>("vkDestroyPipeline")(context.device, pipeline, nullptr);
    if (backFaces) context.Function<PFN_vkDestroyPipeline>("vkDestroyPipeline")(context.device, backFaces, nullptr);
    if (secondChannel) context.Function<PFN_vkDestroyPipeline>("vkDestroyPipeline")(context.device, secondChannel, nullptr);
    if (renderPass) context.Function<PFN_vkDestroyRenderPass>("vkDestroyRenderPass")(context.device, renderPass, nullptr);
    if (layout) context.Function<PFN_vkDestroyPipelineLayout>("vkDestroyPipelineLayout")(context.device, layout, nullptr);
    for (auto module : _modules) {
        if (module) context.Function<PFN_vkDestroyShaderModule>("vkDestroyShaderModule")(context.device, module, nullptr);
    }
    pipeline = VK_NULL_HANDLE;
    backFaces = VK_NULL_HANDLE;
    secondChannel = VK_NULL_HANDLE;
    renderPass = VK_NULL_HANDLE;
    layout = VK_NULL_HANDLE;
    _modules.clear();
}

`, `    if (pipeline) context.Function<PFN_vkDestroyPipeline>("vkDestroyPipeline")(context.device, pipeline, nullptr);
    if (backFaces) context.Function<PFN_vkDestroyPipeline>("vkDestroyPipeline")(context.device, backFaces, nullptr);
    if (secondChannel) context.Function<PFN_vkDestroyPipeline>("vkDestroyPipeline")(context.device, secondChannel, nullptr);
    if (computePipeline) context.Function<PFN_vkDestroyPipeline>("vkDestroyPipeline")(context.device, computePipeline, nullptr);
    if (renderPass) context.Function<PFN_vkDestroyRenderPass>("vkDestroyRenderPass")(context.device, renderPass, nullptr);
    if (layout) context.Function<PFN_vkDestroyPipelineLayout>("vkDestroyPipelineLayout")(context.device, layout, nullptr);
    if (meshBuffersLayout) context.Function<PFN_vkDestroyDescriptorSetLayout>("vkDestroyDescriptorSetLayout")(context.device, meshBuffersLayout, nullptr);
    if (emptySetLayout) context.Function<PFN_vkDestroyDescriptorSetLayout>("vkDestroyDescriptorSetLayout")(context.device, emptySetLayout, nullptr);
    for (auto module : _modules) {
        if (module) context.Function<PFN_vkDestroyShaderModule>("vkDestroyShaderModule")(context.device, module, nullptr);
    }
    pipeline = VK_NULL_HANDLE;
    backFaces = VK_NULL_HANDLE;
    secondChannel = VK_NULL_HANDLE;
    computePipeline = VK_NULL_HANDLE;
    renderPass = VK_NULL_HANDLE;
    layout = VK_NULL_HANDLE;
    meshBuffersLayout = VK_NULL_HANDLE;
    emptySetLayout = VK_NULL_HANDLE;
    _modules.clear();
}

`],
[`    pipeline = VK_NULL_HANDLE;
    backFaces = VK_NULL_HANDLE;
    secondChannel = VK_NULL_HANDLE;
    renderPass = VK_NULL_HANDLE;
    layout = VK_NULL_HANDLE;
    _modules.clear();
}

void Framebuffer::Abandon() noexcept {
    framebuffer = VK_NULL_HANDLE;
}
`, `    pipeline = VK_NULL_HANDLE;
    backFaces = VK_NULL_HANDLE;
    secondChannel = VK_NULL_HANDLE;
    computePipeline = VK_NULL_HANDLE;
    meshBuffersLayout = VK_NULL_HANDLE;
    emptySetLayout = VK_NULL_HANDLE;
    renderPass = VK_NULL_HANDLE;
    layout = VK_NULL_HANDLE;
    _modules.clear();
}

void Pipeline::DispatchMesh(VkCommandBuffer commands, std::uint32_t groups, std::uint32_t instances) const {
    Require(computePipeline != VK_NULL_HANDLE, "the pipeline does not emulate a mesh stage");
    context.Resolved(&DeviceFunctions::cmdBindPipeline, "vkCmdBindPipeline")(commands, VK_PIPELINE_BIND_POINT_COMPUTE, computePipeline);
    context.Resolved(&DeviceFunctions::cmdDispatch, "vkCmdDispatch")(commands, groups, instances, 1);
}

void Framebuffer::Abandon() noexcept {
    framebuffer = VK_NULL_HANDLE;
}
`],
[`void Pipeline::PushConstants(VkCommandBuffer commands, VkShaderStageFlags stages, std::span<const std::byte, PipelinePushConstantBytes> bytes) const {
    if (stages == 0) return;
    if (dynamicRendering) {
        context.Resolved(&DeviceFunctions::cmdPushConstants, "vkCmdPushConstants")(commands, layout, pushStagesOf(context), 0, PipelinePushSlotBytes, bytes.data());
        context.Resolved(&DeviceFunctions::cmdPushConstants, "vkCmdPushConstants")(commands, layout, VK_SHADER_STAGE_FRAGMENT_BIT, PipelinePushSlotBytes, PipelinePushSlotBytes, bytes.data() + PipelinePushSlotBytes);
        return;
    }
`, `void Pipeline::PushConstants(VkCommandBuffer commands, VkShaderStageFlags stages, std::span<const std::byte, PipelinePushConstantBytes> bytes) const {
    if (stages == 0) return;
    if (dynamicRendering) {
        context.Resolved(&DeviceFunctions::cmdPushConstants, "vkCmdPushConstants")(commands, layout, pushStagesOf(context) | (EmulatesMesh() ? VK_SHADER_STAGE_COMPUTE_BIT : 0u), 0, PipelinePushSlotBytes, bytes.data());
        context.Resolved(&DeviceFunctions::cmdPushConstants, "vkCmdPushConstants")(commands, layout, VK_SHADER_STAGE_FRAGMENT_BIT, PipelinePushSlotBytes, PipelinePushSlotBytes, bytes.data() + PipelinePushSlotBytes);
        return;
    }
`]
]},
{file: "core/libs/prx/libSceAgcDriver/Graphics/src/ShaderResources.cpp", replacements: [
[`            }
            const VkShaderStageFlags flags = VulkanStage(shader.stage);
            std::uint64_t stageStorageBuffers = 0;
`, `            }
            const VkShaderStageFlags flags = VulkanStage(shader);
            std::uint64_t stageStorageBuffers = 0;
`],
[`            tableElements[table.set] += elements;
            if (table.sampled) tableFlags[table.set] |= VulkanStage(table.stage);
            if (table.storage) storageTableFlags[table.set] |= VulkanStage(table.stage);
        }
`, `            tableElements[table.set] += elements;
            if (table.sampled) tableFlags[table.set] |= (table.program->meshEmulation == ShaderRecompiler::MeshEmulationRole::Compute ? VK_SHADER_STAGE_COMPUTE_BIT : VulkanStage(table.stage));
            if (table.storage) storageTableFlags[table.set] |= (table.program->meshEmulation == ShaderRecompiler::MeshEmulationRole::Compute ? VK_SHADER_STAGE_COMPUTE_BIT : VulkanStage(table.stage));
        }
`],
[`        Require(shader.program != nullptr, "missing compiled shader");
        const VkShaderStageFlags flags = VulkanStage(shader.stage);
        std::uint64_t stageStorageBuffers = 0;
`, `        Require(shader.program != nullptr, "missing compiled shader");
        const VkShaderStageFlags flags = VulkanStage(shader);
        std::uint64_t stageStorageBuffers = 0;
`]
]},
{file: "core/libs/prx/libSceAgcDriver/Graphics/src/ShaderValidation.cpp", replacements: [
[`    const bool rectListControl = state.rectList && control;
    if (rectListControl) {
`, `    const bool rectListControl = state.rectList && control;
    const bool meshCompute = mesh && shader.meshEmulation == ShaderRecompiler::MeshEmulationRole::Compute;
    const bool passthrough = vertex && shader.meshEmulation == ShaderRecompiler::MeshEmulationRole::Passthrough;
    if (rectListControl) {
`],
[`    }
    const auto model = mesh ? spv::ExecutionModelMeshEXT : control ? spv::ExecutionModelTessellationControl : evaluation ? spv::ExecutionModelTessellationEvaluation : geometry ? spv::ExecutionModelGeometry : vertex ? spv::ExecutionModelVertex : spv::ExecutionModelFragment;
    const auto& words = shader.spirv;
`, `    }
    const auto model = meshCompute ? spv::ExecutionModelGLCompute : mesh ? spv::ExecutionModelMeshEXT : control ? spv::ExecutionModelTessellationControl : evaluation ? spv::ExecutionModelTessellationEvaluation : geometry ? spv::ExecutionModelGeometry : vertex ? spv::ExecutionModelVertex : spv::ExecutionModelFragment;
    const auto& words = shader.spirv;
`],
[`    Module module;
    module.pointSizeOutput = (state.vertexPoints && stage == Stage::Vertex) || (mesh && state.stages.mesh.has_value() && state.stages.mesh->outputPrimitiveSize == 1u);
`, `    Module module;
    module.computeStage = meshCompute;
    module.pointSizeOutput = (state.vertexPoints && stage == Stage::Vertex) || (mesh && state.stages.mesh.has_value() && state.stages.mesh->outputPrimitiveSize == 1u);
`],
[`                if (isSubgroupCapability) {
                    Require((subgroup.supportedStages & VulkanStage(stage)) != 0, "subgroup capability " + std::to_string(instruction[1]) + " is unsupported for shader stage " + std::to_string(VulkanStage(stage)));
                    Require((subgroup.supportedOperations & subgroupOperations) == subgroupOperations, "device lacks operations for subgroup capability " + std::to_string(instruction[1]));
`, `                if (isSubgroupCapability) {
                    Require((subgroup.supportedStages & (meshCompute ? VK_SHADER_STAGE_COMPUTE_BIT : VulkanStage(stage))) != 0, "subgroup capability " + std::to_string(instruction[1]) + " is unsupported for shader stage " + std::to_string(VulkanStage(stage)));
                    Require((subgroup.supportedOperations & subgroupOperations) == subgroupOperations, "device lacks operations for subgroup capability " + std::to_string(instruction[1]));
`],
[`                }
                Require(extension == "SPV_KHR_float_controls" || (imageInt64Atomics && extension == "SPV_EXT_shader_image_int64") || (viewportIndexLayer && extension == "SPV_EXT_shader_viewport_index_layer") || (fragment && demoteToHelperInvocation && extension == "SPV_EXT_demote_to_helper_invocation") || (mesh && (extension == "SPV_EXT_mesh_shader" || extension == "SPV_KHR_physical_storage_buffer")) || (fragment && !primitiveLocations.empty() && extension == "SPV_EXT_mesh_shader") || (geometry && state.tessellationCapture && extension == "SPV_KHR_physical_storage_buffer") || ((descriptorIndexing || runtimeDescriptorArray) && extension == "SPV_EXT_descriptor_indexing") || (shader.bdaAbiVersion == ShaderRecompiler::BdaAbi::Version && (extension == "SPV_KHR_physical_storage_buffer" || extension == "SPV_KHR_8bit_storage")), "unsupported SPIR-V extension");
                break;
`, `                }
                Require(extension == "SPV_KHR_float_controls" || (imageInt64Atomics && extension == "SPV_EXT_shader_image_int64") || (viewportIndexLayer && extension == "SPV_EXT_shader_viewport_index_layer") || (fragment && demoteToHelperInvocation && extension == "SPV_EXT_demote_to_helper_invocation") || (passthrough && extension == "SPV_KHR_physical_storage_buffer") || (mesh && (extension == "SPV_EXT_mesh_shader" || extension == "SPV_KHR_physical_storage_buffer")) || (fragment && !primitiveLocations.empty() && extension == "SPV_EXT_mesh_shader") || (geometry && state.tessellationCapture && extension == "SPV_KHR_physical_storage_buffer") || ((descriptorIndexing || runtimeDescriptorArray) && extension == "SPV_EXT_descriptor_indexing") || (shader.bdaAbiVersion == ShaderRecompiler::BdaAbi::Version && (extension == "SPV_KHR_physical_storage_buffer" || extension == "SPV_KHR_8bit_storage")), "unsupported SPIR-V extension");
                break;
`],
[`        mode(spv::ExecutionModeLocalSize, {paired ? config.threadsPerGroup / 2u : config.threadsPerGroup, 1, 1});
        mode(spv::ExecutionModeOutputVertices, {config.maxVertices});
`, `        mode(spv::ExecutionModeLocalSize, {paired ? config.threadsPerGroup / 2u : config.threadsPerGroup, 1, 1});
        if (meshCompute) {
            Require(module.modes.size() == 1, "unsupported emulated mesh execution mode");
        } else {
        mode(spv::ExecutionModeOutputVertices, {config.maxVertices});
`],
[`        Require(module.modes.size() == 4, "unsupported mesh execution mode");
    } else if (barycentricPatches) {
`, `        Require(module.modes.size() == 4, "unsupported mesh execution mode");
        }
    } else if (barycentricPatches) {
`],
[`    std::map<std::pair<std::uint32_t, std::uint32_t>, bool> bufferViews;
    bool push = false;
`, `    std::map<std::pair<std::uint32_t, std::uint32_t>, bool> bufferViews;
    std::set<std::uint32_t> meshBuffers;
    bool push = false;
`],
[`            Require(binding->count != 0u && binding->count <= capacity && count != module.constants.end() && count->second == binding->count, "typed heap array length disagrees with compact binding");
        } else {
`, `            Require(binding->count != 0u && binding->count <= capacity && count != module.constants.end() && count->second == binding->count, "typed heap array length disagrees with compact binding");
        } else if ((meshCompute || passthrough) && variable.storage == spv::StorageClassStorageBuffer && decoration.set == ShaderRecompiler::MeshEmulationDescriptorSet) {
            Require(decoration.binding && *decoration.binding < (meshCompute ? 3u : 2u) && meshBuffers.insert(*decoration.binding).second, "invalid emulated mesh record buffer binding");
            const auto& block = module.Type(typeId);
            Require(block.size() == 3 && (block[0] & 0xffffu) == spv::OpTypeStruct && module.decorations[typeId].block && (module.Type(block[2])[0] & 0xffffu) == spv::OpTypeRuntimeArray, "emulated mesh record buffer must be a Block struct of one runtime array");
            const auto member = module.offsets.find({typeId, 0});
            Require(member != module.offsets.end() && member->second == 0, "emulated mesh record buffer member must have offset zero");
        } else {
`],
[`    for (const auto id : module.interface) Require(module.variables.contains(id), "entry point interface contains an unknown variable");
    if (mesh) Require(module.primitiveIndices == state.stages.mesh->outputPrimitiveSize, "mesh shader does not export primitive indices");
    if (fragment) Require(module.primitiveInputs == 0 || !primitiveLocations.empty(), "per-primitive pixel inputs need the barycentric emulation layout");
    if (fragment) Require(!module.meshCapability || module.primitiveInputs != 0, "a pixel shader declares mesh shading without a per-primitive input");
    if (stage == Stage::Vertex || mesh || ((evaluation || geometry) && !state.rasterizerDiscard)) Require(module.position, "vertex shader does not export position");
    return module;
`, `    for (const auto id : module.interface) Require(module.variables.contains(id), "entry point interface contains an unknown variable");
    if (mesh && !meshCompute) Require(module.primitiveIndices == state.stages.mesh->outputPrimitiveSize, "mesh shader does not export primitive indices");
    if (fragment) Require(module.primitiveInputs == 0 || !primitiveLocations.empty(), "per-primitive pixel inputs need the barycentric emulation layout");
    if (fragment) Require(!module.meshCapability || module.primitiveInputs != 0, "a pixel shader declares mesh shading without a per-primitive input");
    if (stage == Stage::Vertex || (mesh && !meshCompute) || ((evaluation || geometry) && !state.rasterizerDiscard)) Require(module.position, "vertex shader does not export position");
    return module;
`],
[`    Require(state.stages.mesh.has_value() == mesh && state.stages.tessellation.has_value() == tessellation, "graphics stage configuration disagrees with its path");
    Require(!mesh || meshShader, "device does not support mesh shaders");
    Require(!state.rectList || (state.stages.path == ShaderPath::Vertex && state.topology == VK_PRIMITIVE_TOPOLOGY_PATCH_LIST && state.cullMode == VK_CULL_MODE_NONE), "invalid rect-list pipeline state");
    const bool geometry = state.stages.path == ShaderPath::Vertex && !state.rectList && shaders.size() == 3u;
    const bool patches = BarycentricPatches(state, shaders) && shaders.back().program != nullptr && shaders.back().program->barycentricEmulation.active;
    const bool captured = tessellation && state.tessellationCapture != nullptr;
    Require(!captured || state.rasterizerDiscard, "a captured tessellation pass must discard its primitives");
    Require(geometry || shaders.size() == (tessellation || state.rectList || patches ? 4u : 2u), "incorrect graphics stage count");
    if (patches) Require(state.topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST || state.topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP, "emulated barycentrics through tessellation require a triangle list or strip");
`, `    Require(state.stages.mesh.has_value() == mesh && state.stages.tessellation.has_value() == tessellation, "graphics stage configuration disagrees with its path");
    Require(!state.rectList || (state.stages.path == ShaderPath::Vertex && state.topology == VK_PRIMITIVE_TOPOLOGY_PATCH_LIST && state.cullMode == VK_CULL_MODE_NONE), "invalid rect-list pipeline state");
    const bool geometry = state.stages.path == ShaderPath::Vertex && !state.rectList && shaders.size() == 3u;
    const bool emulated = mesh && !shaders.empty() && EmulatedMesh(shaders.front());
    // Without mesh shaders (MoltenVK) a mesh stage runs emulated as compute.
    Require(!mesh || meshShader || emulated, "device does not support mesh shaders");
    const bool patches = BarycentricPatches(state, shaders) && shaders.back().program != nullptr && shaders.back().program->barycentricEmulation.active;
    Require(geometry || shaders.size() == (tessellation || state.rectList || patches ? 4u : emulated ? 3u : 2u), "incorrect graphics stage count");
    Require(!emulated || shaders[1].program->meshEmulation == ShaderRecompiler::MeshEmulationRole::Passthrough, "an emulated mesh stage needs its pass-through vertex stage");
    const bool captured = tessellation && state.tessellationCapture != nullptr;
    Require(!captured || state.rasterizerDiscard, "a captured tessellation pass must discard its primitives");
    if (patches) Require(state.topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST || state.topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP, "emulated barycentrics through tessellation require a triangle list or strip");
`],
[`    for (std::size_t i = 0; i < shaders.size(); ++i) {
        const auto expected = state.rectList || patches ? (i == 0 ? Stage::Vertex : tessStages[i]) : tessellation ? tessStages[i] : geometry && i == 1 ? Stage::Geometry : i == shaders.size() - 1 ? Stage::Fragment : state.stages.path == ShaderPath::Geometry ? Stage::Mesh : Stage::Vertex;
        Require(shaders[i].program != nullptr, "missing compiled shader");
`, `    for (std::size_t i = 0; i < shaders.size(); ++i) {
        const auto expected = state.rectList || patches ? (i == 0 ? Stage::Vertex : tessStages[i]) : tessellation ? tessStages[i] : geometry && i == 1 ? Stage::Geometry : emulated && i == 1 ? Stage::Vertex : i == shaders.size() - 1 ? Stage::Fragment : state.stages.path == ShaderPath::Geometry ? Stage::Mesh : Stage::Vertex;
        Require(shaders[i].program != nullptr, "missing compiled shader");
`],
[`    bool meshCapability = false;`, `    bool meshCapability = false;
    bool computeStage = false;`],
[`Require((subgroup.supportedStages & VulkanStage(stage)) != 0 && (subgroup.supportedOperations & VK_SUBGROUP_FEATURE_BASIC_BIT) != 0, "subgroup local invocation ID is unsupported for this shader stage");`, `Require((subgroup.supportedStages & (computeStage ? VK_SHADER_STAGE_COMPUTE_BIT : VulkanStage(stage))) != 0 && (subgroup.supportedOperations & VK_SUBGROUP_FEATURE_BASIC_BIT) != 0, "subgroup local invocation ID is unsupported for this shader stage");`]
]},
{file: "core/shader/recompiler/CMakeLists.txt", replacements: [
[`            \${CMAKE_CURRENT_FUNCTION_LIST_DIR}/SpirvBackend/src/RectListShaders.cpp
            \${CMAKE_CURRENT_FUNCTION_LIST_DIR}/SpirvBackend/src/BarycentricGeometryShader.cpp
`, `            \${CMAKE_CURRENT_FUNCTION_LIST_DIR}/SpirvBackend/src/RectListShaders.cpp
            \${CMAKE_CURRENT_FUNCTION_LIST_DIR}/SpirvBackend/src/MeshPassthroughShader.cpp
            \${CMAKE_CURRENT_FUNCTION_LIST_DIR}/SpirvBackend/src/BarycentricGeometryShader.cpp
`],
[`            BuildBarycentricTessellationShaders
            BuildPreparedShaderKey
`, `            BuildBarycentricTessellationShaders
            BuildMeshPassthroughVertexShader
            BuildPreparedShaderKey
`],
[`            DepthBitsTextureWidth
            HashBytes
`, `            DepthBitsTextureWidth
            EmulatedMeshSlots
            HashBytes
`]
]},
{file: "core/shader/recompiler/CacheKey.hpp", replacements: [
[`        append(key, value.float64DenormPreserve);
        append(key, value.depthRangeRemap);
`, `        append(key, value.float64DenormPreserve);
        append(key, value.meshAsCompute);
        append(key, value.depthRangeRemap);
`]
]},
{file: "core/shader/recompiler/Recompiler.cpp", replacements: [
[`    targetOptions.float64DenormPreserve = request.target.float64DenormPreserve;
    targetOptions.depthRangeRemap = request.target.depthRangeRemap;
`, `    targetOptions.float64DenormPreserve = request.target.float64DenormPreserve;
    targetOptions.meshAsCompute = request.target.meshAsCompute && program.Resources().stage == IrShaderStage::Mesh;
    targetOptions.depthRangeRemap = request.target.depthRangeRemap;
`],
[`    result.registrationModule = registration;
    if (request.shader.stage == ShaderStage::Mesh && request.graphics) result.meshBarycentrics = request.graphics->meshBarycentrics;
`, `    result.registrationModule = registration;
    if (targetOptions.meshAsCompute) result.meshEmulation = MeshEmulationRole::Compute;
    if (request.shader.stage == ShaderStage::Mesh && request.graphics) result.meshBarycentrics = request.graphics->meshBarycentrics;
`],
[`        if (op == spv::OpDecorate && count == 4u && materialized[cursor + 2u] == spv::DecorationBinding) bindingNumbers.emplace(materialized[cursor + 1u], materialized[cursor + 3u]);
        if (op == spv::OpDecorate && count == 4u && materialized[cursor + 2u] == spv::DecorationDescriptorSet && (materialized[cursor + 3u] == PixelFunctionLdsDescriptorSet || materialized[cursor + 3u] == MeshWindowDescriptorSet)) functionLdsBuffer.insert(materialized[cursor + 1u]);
        if (op == spv::OpVariable && count >= 4u && !functionLdsBuffer.contains(materialized[cursor + 2u])) {
`, `        if (op == spv::OpDecorate && count == 4u && materialized[cursor + 2u] == spv::DecorationBinding) bindingNumbers.emplace(materialized[cursor + 1u], materialized[cursor + 3u]);
        if (op == spv::OpDecorate && count == 4u && materialized[cursor + 2u] == spv::DecorationDescriptorSet && (materialized[cursor + 3u] == PixelFunctionLdsDescriptorSet || materialized[cursor + 3u] == MeshWindowDescriptorSet || materialized[cursor + 3u] == MeshEmulationDescriptorSet)) functionLdsBuffer.insert(materialized[cursor + 1u]);
        if (op == spv::OpVariable && count >= 4u && !functionLdsBuffer.contains(materialized[cursor + 2u])) {
`]
]},
{file: "core/shader/recompiler/Recompiler.hpp", replacements: [
[`    bool float64DenormPreserve = false;
    bool registrationModules = false;
`, `    bool float64DenormPreserve = false;
    bool meshAsCompute = false;
    bool registrationModules = false;
`],
[`
inline constexpr std::uint32_t MeshDrawPushOffsetBytes = 104;
`, `
inline constexpr std::uint32_t MeshEmulationDescriptorSet = 2;

inline constexpr std::uint32_t MeshDrawPushOffsetBytes = 104;
`],
[`
struct CompiledShaderArtifact {
`, `
enum class MeshEmulationRole : std::uint32_t { None, Compute, Passthrough };
struct MeshEmulationSlots { std::uint32_t vertices; std::uint32_t primitives; };

struct CompiledShaderArtifact {
`],
[`    BarycentricEmulation barycentricEmulation;
    std::optional<MeshBarycentricLayout> meshBarycentrics;
`, `    BarycentricEmulation barycentricEmulation;
    MeshEmulationRole meshEmulation = MeshEmulationRole::None;
    std::optional<MeshBarycentricLayout> meshBarycentrics;
`],
[`
struct GeometryStageLimits {
`, `
[[nodiscard]] MeshEmulationSlots EmulatedMeshSlots(const MeshConfiguration& mesh);
[[nodiscard]] RecompileResult BuildMeshPassthroughVertexShader(const RecompileResult& mesh, const RecompileResult& fragment, const SpirvTarget& target, bool layered);

struct GeometryStageLimits {
`]
]},
{file: "core/shader/recompiler/ShaderDiskCache.cpp", replacements: [
[`    writer.Value(result.barycentricEmulation.smoothOffset);
    writer.Value(result.meshBarycentrics.has_value());
`, `    writer.Value(result.barycentricEmulation.smoothOffset);
    writer.Value(static_cast<std::uint32_t>(result.meshEmulation));
    writer.Value(result.meshBarycentrics.has_value());
`],
[`    reader.Value(result.barycentricEmulation.smoothOffset);
    bool hasMeshBarycentrics = false;
`, `    reader.Value(result.barycentricEmulation.smoothOffset);
    std::uint32_t meshEmulation = 0;
    reader.Value(meshEmulation);
    if (meshEmulation > static_cast<std::uint32_t>(MeshEmulationRole::Passthrough)) throw std::runtime_error("invalid mesh emulation role in the shader cache");
    result.meshEmulation = static_cast<MeshEmulationRole>(meshEmulation);
    bool hasMeshBarycentrics = false;
`]
]},
{file: "core/shader/recompiler/SpirvBackend/include/SpirvBackend/SpirvEmitter.hpp", replacements: [
[`    bool float64DenormPreserve = false;
    bool depthRangeRemap = false;
`, `    bool float64DenormPreserve = false;
    bool meshAsCompute = false;
    bool depthRangeRemap = false;
`]
]},
{file: "core/shader/recompiler/SpirvBackend/include/SpirvBackend/SpirvEmitterState.hpp", replacements: [
[`    SpirvTableAccess tableAccess;
    SpirvEmitterState(const IrProgram& program, const ShaderStageInputInfo& inputInfo);

`, `    SpirvTableAccess tableAccess;
    SpirvEmitterState(const IrProgram& program, const ShaderStageInputInfo& inputInfo, bool meshAsCompute = false);

`],
[`    bool float64DenormPreserve = false;
    bool depthRangeRemap = false;
`, `    bool float64DenormPreserve = false;
    bool meshAsCompute = false;
    bool depthRangeRemap = false;
`],
[`    std::uint32_t meshPrimitiveData = 0;
    std::uint32_t meshPrimitives = 0;
`, `    std::uint32_t meshPrimitiveData = 0;
    std::array<std::uint32_t, 3> meshEmulationBuffers{};
    std::uint32_t meshPrimitives = 0;
`]
]},
{file: "core/shader/recompiler/SpirvBackend/src/MeshPassthroughShader.cpp", copy: "MeshPassthroughShader.cpp"},
{file: "core/shader/recompiler/SpirvBackend/src/SpirvEmitter.cpp", replacements: [
[`
SpirvEmitterState::SpirvEmitterState(const IrProgram& program, const ShaderStageInputInfo& inputInfo) : module(program.Resources().stage == IrShaderStage::Mesh ? 0x00010400u : 0x00010300u), program(program), inputInfo(inputInfo), requirements(AnalyzeProgramRequirements(program)) {
}
`, `
SpirvEmitterState::SpirvEmitterState(const IrProgram& program, const ShaderStageInputInfo& inputInfo, bool meshAsCompute) : module(program.Resources().stage == IrShaderStage::Mesh && !meshAsCompute ? 0x00010400u : 0x00010300u), program(program), inputInfo(inputInfo), requirements(AnalyzeProgramRequirements(program)), meshAsCompute(meshAsCompute && program.Resources().stage == IrShaderStage::Mesh) {
}
`],
[`    ValidateBdaTarget(program, target);
    SpirvEmitterState state(program, inputInfo);
    state.module.RequireVersion(target.spirvVersion);
`, `    ValidateBdaTarget(program, target);
    SpirvEmitterState state(program, inputInfo, target.meshAsCompute);
    state.module.RequireVersion(target.spirvVersion);
`],
[`    EmitProgram(state);
    state.module.EmitEntryPoint(ExecutionModelForStage(state.program.Resources().stage), state.mainFunc, "main", state.interfaceVariables);
    if (info != nullptr) {
`, `    EmitProgram(state);
    state.module.EmitEntryPoint(state.meshAsCompute ? static_cast<std::uint32_t>(spv::ExecutionModelGLCompute) : ExecutionModelForStage(state.program.Resources().stage), state.mainFunc, "main", state.interfaceVariables);
    if (info != nullptr) {
`]
]},
{file: "core/shader/recompiler/SpirvBackend/src/SpirvMemory/SpirvEmitterHelpers.cpp", replacements: [
[`
void EmitBaseHeader(SpirvModule& module, const IrProgram& program) {
    module.EmitCapability(spv::CapabilityShader);
    const bool physical = program.Info().usesDma || program.Resources().stage == IrShaderStage::Mesh;
    if (physical) {
`, `
void EmitBaseHeader(SpirvModule& module, const IrProgram& program, bool meshAsCompute) {
    module.EmitCapability(spv::CapabilityShader);
    const bool physical = program.Info().usesDma || (program.Resources().stage == IrShaderStage::Mesh && !meshAsCompute);
    if (physical) {
`],
[`    }
    if (state.requirements.ldsLock && std::none_of(state.inputs.begin(), state.inputs.end(), [](const SpirvInputBinding& input) {
`, `    }
    if (state.meshAsCompute && std::none_of(state.inputs.begin(), state.inputs.end(), [](const SpirvInputBinding& input) { return input.kind == StageInputKind::WorkgroupId; })) {
        state.inputs.push_back(SpirvInputBinding {{StageInputKind::WorkgroupId, 0u, 3u, "gl_WorkGroupID", false}});
    }
    if (state.requirements.ldsLock && std::none_of(state.inputs.begin(), state.inputs.end(), [](const SpirvInputBinding& input) {
`]
]},
{file: "core/shader/recompiler/SpirvBackend/src/SpirvMemory/SpirvModuleSetup.cpp", replacements: [
[`        state.meshGuestFunc = state.module.AllocateId();
        state.module.EmitCapability(spv::CapabilityMeshShadingEXT);
`, `        state.meshGuestFunc = state.module.AllocateId();
    }
    if (StageOf(state) == IrShaderStage::Mesh && !state.meshAsCompute) {
        const auto& mesh = VertexInfo(state).mesh;
        state.module.EmitCapability(spv::CapabilityMeshShadingEXT);
`],
[`    state.entryLabel = state.module.AllocateId();
    EmitBaseHeader(state.module, state.program);
    for (const auto capability : state.requirements.capabilities) {
`, `    state.entryLabel = state.module.AllocateId();
    EmitBaseHeader(state.module, state.program, state.meshAsCompute);
    for (const auto capability : state.requirements.capabilities) {
`]
]},
{file: "core/shader/recompiler/SpirvBackend/src/SpirvModuleEmitter.cpp", replacements: [
[`
void DefineMeshOutputs(SpirvEmitterState& state) {
`, `
namespace {

[[noreturn]] void UnsupportedMeshCompute(const char* reason) {
#ifdef __APPLE__
    throw UnsupportedResourceBinding(std::string("compute mesh emulation: ") + reason);
#else
    FailEmit(reason);
#endif
}

void DefineMeshEmulationBuffers(SpirvEmitterState& state) {
    const std::array<std::uint32_t, 3> elements{TypeF32Vector(state, 4u), TypeU32Vector(state, 4u), TypeU32(state)};
    for (std::uint32_t binding = 0; binding < elements.size(); ++binding) {
        const auto array = state.module.DecoratedType(spv::OpTypeRuntimeArray, {{spv::OpDecorate, {spv::DecorationArrayStride, binding == 2u ? 4u : 16u}}}, elements[binding]);
        const auto block = state.module.DecoratedType(spv::OpTypeStruct, {{spv::OpDecorate, {spv::DecorationBlock}}, {spv::OpMemberDecorate, {0u, spv::DecorationOffset, 0u}}}, array);
        const auto variable = state.module.DefineGlobalVariable(TypePointer(state, spv::StorageClassStorageBuffer, block), spv::StorageClassStorageBuffer);
        state.module.AddAnnotation(spv::OpDecorate, variable, spv::DecorationDescriptorSet, MeshEmulationDescriptorSet);
        state.module.AddAnnotation(spv::OpDecorate, variable, spv::DecorationBinding, binding);
        if (binding == 2u) state.module.AddAnnotation(spv::OpDecorate, variable, spv::DecorationNonWritable);
        if (state.spirvVersion >= 0x00010400u) state.interfaceVariables.push_back(variable);
        state.meshEmulationBuffers[binding] = variable;
    }
}

std::uint32_t MeshEmulationElement(SpirvEmitterState& state, std::uint32_t binding, std::uint32_t type, std::uint32_t index) {
    const auto pointer = state.module.AllocateId();
    state.module.AddFunction(spv::OpAccessChain, TypePointer(state, spv::StorageClassStorageBuffer, type), pointer, state.meshEmulationBuffers.at(binding), ConstantU32(state, 0u), index);
    return pointer;
}

}

void DefineMeshOutputs(SpirvEmitterState& state) {
`],
[`    const auto& mesh = state.inputInfo.vertex->mesh;
    std::uint32_t clipDistanceCount = 0u;
`, `    const auto& mesh = state.inputInfo.vertex->mesh;
    if (state.meshAsCompute) {
        if (mesh.outputPrimitiveSize != 3u) UnsupportedMeshCompute("the output primitive is not a triangle");
        if (mesh.provokingVertex >= mesh.outputPrimitiveSize) UnsupportedMeshCompute("the provoking vertex is outside the output primitive");
        if (state.meshBarycentricVertex) UnsupportedMeshCompute("per-vertex barycentric outputs need a raster-stage interpolation route");
        if (std::ranges::none_of(state.outputs, [](const SpirvOutputBinding& output) { return output.kind == StageOutputKind::Position; })) UnsupportedMeshCompute("the shader exports no vertex position");
    }
    std::uint32_t clipDistanceCount = 0u;
`],
[`    for (const auto& output : state.outputs) {
        if (output.kind == StageOutputKind::ClipDistance) {
`, `    for (const auto& output : state.outputs) {
        if (state.meshAsCompute && IsMeshDistance(output.kind)) UnsupportedMeshCompute("clip and cull distances need scalar vertex records");
        if (output.kind == StageOutputKind::ClipDistance) {
`],
[`        output.meshDataVariable = MeshArray(state, shared ? spv::StorageClassWorkgroup : spv::StorageClassPrivate, type, shared ? mesh.maxVertices : state.laneCount);
        if (state.meshBarycentricVertex && output.kind == StageOutputKind::Parameter && std::ranges::find(state.meshExportedLocations, output.location) == state.meshExportedLocations.end()) {
`, `        output.meshDataVariable = MeshArray(state, shared ? spv::StorageClassWorkgroup : spv::StorageClassPrivate, type, shared ? mesh.maxVertices : state.laneCount);
        if (state.meshAsCompute) {
            continue;
        }
        if (state.meshBarycentricVertex && output.kind == StageOutputKind::Parameter && std::ranges::find(state.meshExportedLocations, output.location) == state.meshExportedLocations.end()) {
`],
[`    state.meshPrimitiveData = MeshArray(state, spv::StorageClassPrivate, TypeU32(state), state.laneCount);
    state.meshPrimitives = MeshArray(state, spv::StorageClassOutput, mesh.outputPrimitiveSize == 1u ? TypeU32(state) : TypeU32Vector(state, mesh.outputPrimitiveSize), mesh.maxPrimitives);
`, `    state.meshPrimitiveData = MeshArray(state, spv::StorageClassPrivate, TypeU32(state), state.laneCount);
    if (state.numWorkgroupsVariable == 0u) {
        state.numWorkgroupsVariable = DefineInterfaceVariable(state, TypeU32Vector(state, 3u), spv::StorageClassInput, "gl_NumWorkGroups");
        state.module.AddAnnotation(spv::OpDecorate, state.numWorkgroupsVariable, spv::DecorationBuiltIn, spv::BuiltInNumWorkgroups);
    }
    if (state.meshAsCompute) {
        DefineMeshEmulationBuffers(state);
        return;
    }
    state.meshPrimitives = MeshArray(state, spv::StorageClassOutput, mesh.outputPrimitiveSize == 1u ? TypeU32(state) : TypeU32Vector(state, mesh.outputPrimitiveSize), mesh.maxPrimitives);
`],
[`    state.module.AddAnnotation(spv::OpDecorate, state.meshCull, spv::DecorationPerPrimitiveEXT);
    if (state.numWorkgroupsVariable == 0u) {
        state.numWorkgroupsVariable = DefineInterfaceVariable(state, TypeU32Vector(state, 3u), spv::StorageClassInput, "gl_NumWorkGroups");
        state.module.AddAnnotation(spv::OpDecorate, state.numWorkgroupsVariable, spv::DecorationBuiltIn, spv::BuiltInNumWorkgroups);
    }
`, `    state.module.AddAnnotation(spv::OpDecorate, state.meshCull, spv::DecorationPerPrimitiveEXT);
}

namespace {

void StoreMeshRecord(SpirvEmitterState& state, std::uint32_t binding, std::uint32_t record, std::uint32_t slot, std::uint32_t type, std::uint32_t value) {
    state.module.AddFunction(spv::OpStore, MeshEmulationElement(state, binding, type, Binary(state, spv::OpIAdd, TypeU32(state), record, ConstantU32(state, slot))), value);
}

void EmitMeshComputeRecords(SpirvEmitterState& state, std::uint32_t vertices, std::uint32_t primitives) {
    const auto& mesh = state.inputInfo.vertex->mesh;
    const MeshEmulationSlots slots{std::min(mesh.maxVertices, mesh.threadsNum[0]), std::min(mesh.maxPrimitives, mesh.threadsNum[0])};
    std::uint32_t parameters = 0;
    for (const auto& output : state.outputs) {
        if (output.kind == StageOutputKind::Parameter) ++parameters;
    }
    const auto groupsX = state.module.AllocateId();
    const auto groupsXPointer = state.module.AllocateId();
    state.module.AddFunction(spv::OpAccessChain, TypePointer(state, spv::StorageClassInput, TypeU32(state)), groupsXPointer, state.numWorkgroupsVariable, ConstantU32(state, 0u));
    state.module.AddFunction(spv::OpLoad, TypeU32(state), groupsX, groupsXPointer);
    const auto group = Binary(state, spv::OpIAdd, TypeU32(state), Binary(state, spv::OpIMul, TypeU32(state), EmitInputComponentU32(state, StageInputKind::WorkgroupId, 1u), groupsX), EmitInputComponentU32(state, StageInputKind::WorkgroupId, 0u));
    const auto firstVertex = Binary(state, spv::OpIMul, TypeU32(state), group, ConstantU32(state, slots.vertices));
    const auto firstPrimitive = Binary(state, spv::OpIMul, TypeU32(state), group, ConstantU32(state, slots.primitives));
    const auto anyVertex = state.module.AllocateId();
    state.module.AddFunction(spv::OpExtInst, TypeU32(state), anyVertex, GlslStd450(state), GLSLstd450UMax, vertices, ConstantU32(state, 1u));
    const auto lastVertex = Binary(state, spv::OpISub, TypeU32(state), anyVertex, ConstantU32(state, 1u));
    const auto vec4 = TypeF32Vector(state, 4u);
    const auto uvec4 = TypeU32Vector(state, 4u);
    for (std::uint32_t half = 0; half < state.laneCount; half++) {
        state.laneHalf = half;
        const auto index = EmitLocalInvocationIndex(state);
        const auto isVertex = state.module.AllocateId();
        state.module.AddFunction(spv::OpULessThan, TypeBool(state), isVertex, index, vertices);
        EmitIfCondition(state, isVertex, [&]() {
            const auto record = Binary(state, spv::OpIMul, TypeU32(state), Binary(state, spv::OpIAdd, TypeU32(state), firstVertex, index), ConstantU32(state, 1u + parameters));
            std::uint32_t slot = 1;
            for (const auto& output : state.outputs) {
                // Position and parameters are vec4 records. Layer is packed with
                // the primitive; scalar point size is unused for triangles.
                if (output.kind != StageOutputKind::Position && output.kind != StageOutputKind::Parameter) continue;
                const auto value = MeshLoad(state, output.meshDataVariable, spv::StorageClassPrivate, vec4, ConstantU32(state, half));
                StoreMeshRecord(state, 0u, record, output.kind == StageOutputKind::Position ? 0u : slot++, vec4, value);
            }
        });
        const auto isSlot = state.module.AllocateId();
        state.module.AddFunction(spv::OpULessThan, TypeBool(state), isSlot, index, ConstantU32(state, slots.primitives));
        EmitIfCondition(state, isSlot, [&]() {
            const auto packed = MeshLoad(state, state.meshPrimitiveData, spv::StorageClassPrivate, TypeU32(state), ConstantU32(state, half));
            std::array<std::uint32_t, 3> vertex {};
            for (std::uint32_t component = 0; component < 3u; component++) {
                const auto field = state.module.AllocateId();
                state.module.AddFunction(spv::OpBitFieldUExtract, TypeU32(state), field, packed, ConstantU32(state, component * 10u), ConstantU32(state, 9u));
                vertex.at(component) = state.module.AllocateId();
                state.module.AddFunction(spv::OpExtInst, TypeU32(state), vertex.at(component), GlslStd450(state), GLSLstd450UMin, field, lastVertex);
            }
            auto layer = ConstantU32(state, 0u);
            for (const auto& output : state.outputs) {
                if (output.kind == StageOutputKind::Layer) layer = MeshLoad(state, output.meshDataVariable, spv::StorageClassWorkgroup, TypeU32(state), vertex.at(mesh.provokingVertex));
            }
            const auto inRange = state.module.AllocateId();
            state.module.AddFunction(spv::OpULessThan, TypeBool(state), inRange, index, primitives);
            const auto nullBit = Binary(state, spv::OpBitwiseAnd, TypeU32(state), packed, ConstantU32(state, 0x80000000u));
            const auto kept = state.module.AllocateId();
            state.module.AddFunction(spv::OpIEqual, TypeBool(state), kept, nullBit, ConstantU32(state, 0u));
            const auto drawn = state.module.AllocateId();
            state.module.AddFunction(spv::OpLogicalAnd, TypeBool(state), drawn, inRange, kept);
            const auto triangle = state.module.AllocateId();
            state.module.AddFunction(spv::OpCompositeConstruct, uvec4, triangle, Binary(state, spv::OpIAdd, TypeU32(state), firstVertex, vertex[0]), Binary(state, spv::OpIAdd, TypeU32(state), firstVertex, vertex[1]), Binary(state, spv::OpIAdd, TypeU32(state), firstVertex, vertex[2]), layer);
            const auto culled = state.module.AllocateId();
            state.module.AddFunction(spv::OpCompositeConstruct, uvec4, culled, ConstantU32(state, 0u), ConstantU32(state, 0u), ConstantU32(state, 0u), ConstantU32(state, 0x80000000u));
            const auto value = state.module.AllocateId();
            const auto selected = state.module.AllocateId();
            state.module.AddFunction(spv::OpCompositeConstruct, TypeBoolVector(state, 4u), selected, drawn, drawn, drawn, drawn);
            state.module.AddFunction(spv::OpSelect, uvec4, value, selected, triangle, culled);
            StoreMeshRecord(state, 1u, Binary(state, spv::OpIAdd, TypeU32(state), firstPrimitive, index), 0u, uvec4, value);
        });
    }
`],
[`
void EmitPixelEntryPoint(SpirvEmitterState& state) {
`, `
}

void EmitPixelEntryPoint(SpirvEmitterState& state) {
`],
[`    const auto primitives = clamp(MeshLoad(state, state.meshAllocation, spv::StorageClassWorkgroup, TypeU32(state), ConstantU32(state, 1u)), mesh.maxPrimitives);
    state.module.AddFunction(spv::OpSetMeshOutputsEXT, vertices, primitives);
`, `    const auto primitives = clamp(MeshLoad(state, state.meshAllocation, spv::StorageClassWorkgroup, TypeU32(state), ConstantU32(state, 1u)), mesh.maxPrimitives);
    if (state.meshAsCompute) {
        EmitMeshComputeRecords(state, vertices, primitives);
        state.laneHalf = 0;
        state.module.AddFunction(spv::OpReturn);
        state.module.AddFunction(spv::OpFunctionEnd);
        return;
    }
    state.module.AddFunction(spv::OpSetMeshOutputsEXT, vertices, primitives);
`],
[`
std::uint32_t MeshPushAddress(SpirvEmitterState& state, std::uint32_t first) {
`, `
std::uint32_t MeshArgumentPushWord(SpirvEmitterState& state, std::uint32_t dword) {
    const auto pointer = state.module.AllocateId();
    state.module.AddFunction(spv::OpAccessChain, TypePushConstantElementPointer(state), pointer, state.pushConstantVariable, ConstantU32(state, 0u), ConstantU32(state, MeshDrawPushOffsetBytes / 4u + dword));
    const auto value = state.module.AllocateId();
    state.module.AddFunction(spv::OpLoad, TypeU32(state), value, pointer);
    return value;
}

std::uint32_t MeshPushAddress(SpirvEmitterState& state, std::uint32_t first) {
`],
[`std::uint32_t MeshArgumentAddress(SpirvEmitterState& state) {
    const auto push = [&](std::uint32_t dword) {
        const auto pointer = state.module.AllocateId();
        state.module.AddFunction(spv::OpAccessChain, TypePushConstantElementPointer(state), pointer, state.pushConstantVariable, ConstantU32(state, 0u), ConstantU32(state, MeshDrawPushOffsetBytes / 4u + dword));
        const auto value = state.module.AllocateId();
        state.module.AddFunction(spv::OpLoad, TypeU32(state), value, pointer);
        return Unary(state, spv::OpUConvert, TypeScalarU64(state), value);
    };
    const auto low = push(MeshArgumentAddressDword);
    const auto high = push(MeshArgumentAddressDword + 1u);
    return Binary(state, spv::OpBitwiseOr, TypeScalarU64(state), low, Binary(state, spv::OpShiftLeftLogical, TypeScalarU64(state), high, ConstantU32(state, 32u)));
`, `std::uint32_t MeshArgumentAddress(SpirvEmitterState& state) {
    if (state.meshAsCompute) return 0u;
    const auto low = Unary(state, spv::OpUConvert, TypeScalarU64(state), MeshArgumentPushWord(state, MeshArgumentAddressDword));
    const auto high = Unary(state, spv::OpUConvert, TypeScalarU64(state), MeshArgumentPushWord(state, MeshArgumentAddressDword + 1u));
    return Binary(state, spv::OpBitwiseOr, TypeScalarU64(state), low, Binary(state, spv::OpShiftLeftLogical, TypeScalarU64(state), high, ConstantU32(state, 32u)));
`],
[`std::uint32_t LoadMeshArgumentWord(SpirvEmitterState& state, std::uint32_t address, std::uint32_t dword) {
    const auto element = Binary(state, spv::OpIAdd, TypeScalarU64(state), address, Binary(state, spv::OpShiftLeftLogical, TypeScalarU64(state), Unary(state, spv::OpUConvert, TypeScalarU64(state), dword), ConstantU32(state, 2u)));
`, `std::uint32_t LoadMeshArgumentWord(SpirvEmitterState& state, std::uint32_t address, std::uint32_t dword) {
    if (state.meshAsCompute) {
        const auto loaded = state.module.AllocateId();
        state.module.AddFunction(spv::OpLoad, TypeU32(state), loaded, MeshEmulationElement(state, 2u, TypeU32(state), dword));
        return loaded;
    }
    const auto element = Binary(state, spv::OpIAdd, TypeScalarU64(state), address, Binary(state, spv::OpShiftLeftLogical, TypeScalarU64(state), Unary(state, spv::OpUConvert, TypeScalarU64(state), dword), ConstantU32(state, 2u)));
`],
[`    const auto address = MeshArgumentAddress(state);
    const auto present = Binary(state, spv::OpINotEqual, TypeBool(state), address, BdaConstant(state, 0u));
    const auto before = state.currentLabel;
`, `    const auto address = MeshArgumentAddress(state);
    const auto present = state.meshAsCompute ? Binary(state, spv::OpINotEqual, TypeBool(state), Binary(state, spv::OpBitwiseOr, TypeU32(state), MeshArgumentPushWord(state, MeshArgumentAddressDword), MeshArgumentPushWord(state, MeshArgumentAddressDword + 1u)), ConstantU32(state, 0u)) : Binary(state, spv::OpINotEqual, TypeBool(state), address, BdaConstant(state, 0u));
    const auto before = state.currentLabel;
`],
[`    EmitLabel(state, loadLabel);
    const auto element = Binary(state, spv::OpIAdd, TypeScalarU64(state), address, BdaConstant(state, 4ull * index));
    const auto pointer = state.module.AllocateId();
    state.module.AddFunction(spv::OpConvertUToPtr, TypePointer(state, spv::StorageClassPhysicalStorageBuffer, TypeU32(state)), pointer, element);
    const auto loaded = state.module.AllocateId();
    state.module.AddFunction(spv::OpLoad, TypeU32(state), loaded, pointer, spv::MemoryAccessAlignedMask, 4u);
    state.module.AddFunction(spv::OpBranch, merge);
`, `    EmitLabel(state, loadLabel);
    const auto loaded = LoadMeshArgumentWord(state, address, ConstantU32(state, index));
    state.module.AddFunction(spv::OpBranch, merge);
`]
]},
{file: "core/libs/prx/libSceAgcDriver/Graphics/include/Context.hpp", replacements: [
[`    PFN_vkCmdDraw cmdDraw = nullptr;
    PFN_vkCmdDrawIndexed cmdDrawIndexed = nullptr;
`, `    PFN_vkCmdDraw cmdDraw = nullptr;
    PFN_vkCmdPushDescriptorSetKHR cmdPushDescriptorSet = nullptr;
    PFN_vkCmdDrawIndexed cmdDrawIndexed = nullptr;
`],
[`    bool meshWave32 = false;`, `    bool meshWave32 = false;
    bool pushDescriptor = false;`]
]},
{file: "core/libs/prx/libSceAgcDriver/Graphics/src/Resources.cpp", replacements: [
[`    functions.cmdDraw = context.Function<PFN_vkCmdDraw>("vkCmdDraw");
    functions.cmdDrawIndexed = context.Function<PFN_vkCmdDrawIndexed>("vkCmdDrawIndexed");
`, `    functions.cmdDraw = context.Function<PFN_vkCmdDraw>("vkCmdDraw");
    if (context.pushDescriptor) functions.cmdPushDescriptorSet = context.Function<PFN_vkCmdPushDescriptorSetKHR>("vkCmdPushDescriptorSetKHR");
    functions.cmdDrawIndexed = context.Function<PFN_vkCmdDrawIndexed>("vkCmdDrawIndexed");
`]
]},
{file: "core/shader/recompiler/SpirvBackend/include/SpirvBackend/SpirvEmitterHelpers.hpp", replacements: [
[`void CheckBindings(const IrProgram& program, const CompiledBindingLayout& bindings);
void EmitBaseHeader(SpirvModule& module, const IrProgram& program);
void DefineInputs(SpirvEmitterState& state);
`, `void CheckBindings(const IrProgram& program, const CompiledBindingLayout& bindings);
void EmitBaseHeader(SpirvModule& module, const IrProgram& program, bool meshAsCompute = false);
void DefineInputs(SpirvEmitterState& state);
`]
]}
];
