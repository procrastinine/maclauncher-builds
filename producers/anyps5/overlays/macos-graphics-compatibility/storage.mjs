import {replace, apple} from './common.mjs';
export async function applyStorageCompatibility(edit) {
    const backend = 'core/shader/recompiler/SpirvBackend/';
    await edit(backend + 'include/SpirvBackend/SpirvEmitterState.hpp', source => replace(source, '    std::uint32_t srgbTableVariable = 0;', '    bool singleSampleImages = false;\n    std::uint32_t srgbTableVariable = 0;'));
    await edit(backend + 'src/SpirvEmitter.cpp', source => replace(source, '    state.hostSubgroupSize = target.subgroupSize;', `    state.hostSubgroupSize = target.subgroupSize;
#ifdef __APPLE__
    state.singleSampleImages = std::ranges::find(target.supportedCapabilities, static_cast<std::uint32_t>(spv::CapabilityStorageImageMultisample)) == target.supportedCapabilities.end();
#endif`));
    await edit(backend + 'src/SpirvMemory/SpirvDescriptors.cpp', source => {
        source = replace(source, '    const auto& info = RdnaImageDimensionInfoFor(image.dimension);\n    if (info.multisampled != 0u) {', `    const auto& info = RdnaImageDimensionInfoFor(image.dimension);
    const auto multisampled = state.singleSampleImages && image.resourceClass == ImageResourceClass::Storage && !image.targetMerge ? 0u : info.multisampled;
    if (multisampled != 0u) {`);
        source = replace(source, 'info.arrayed, info.multisampled, sampled, format);', 'info.arrayed, multisampled, sampled, format);');
        const read = '        state.module.AddFunction(spv::OpImageRead, texelType, texel, descriptor, coord, spv::ImageOperandsSampleMask, sample);';
        source = replace(source, read, '        if (state.singleSampleImages && image.resourceClass == ImageResourceClass::Storage && !image.targetMerge) state.module.AddFunction(spv::OpImageRead, texelType, texel, descriptor, coord);\n        else ' + read.trimStart());
        const write = '        state.module.AddFunction(spv::OpImageWrite, loadAt(arrayIndex), coord, texel, spv::ImageOperandsSampleMask, sample);';
        return replace(source, write, '        if (state.singleSampleImages && image.resourceClass == ImageResourceClass::Storage && !image.targetMerge) state.module.AddFunction(spv::OpImageWrite, loadAt(arrayIndex), coord, texel);\n        else ' + write.trimStart());
    });
    await edit(backend + 'src/SpirvImageEmitter.cpp', source => {
        const query = '    if (info.multisampled != 0u) {\n        state.module.AddFunction(spv::OpImageQuerySize, ImageViewSizeType(state, dimension), size, image);';
        source = replace(source, query, `    if (info.multisampled != 0u && state.singleSampleImages && access.image.resourceClass == ImageResourceClass::Storage && !access.image.targetMerge) {
        state.module.AddFunction(spv::OpImageQuerySizeLod, ImageViewSizeType(state, dimension), size, image, ConstantU32(state, 0u));
    } else if (info.multisampled != 0u) {
        state.module.AddFunction(spv::OpImageQuerySize, ImageViewSizeType(state, dimension), size, image);`);
        const fetch = '            state.module.AddFunction(spv::OpImageFetch, ImageVectorType(state, numericClass, 4), color, descriptor, coord, spv::ImageOperandsSampleMask, AddressU32(ctx, access, addressInfo.coordinateComponents));';
        source = replace(source, fetch, '            if (state.singleSampleImages && access.image.resourceClass == ImageResourceClass::Storage && !access.image.targetMerge) state.module.AddFunction(spv::OpImageFetch, ImageVectorType(state, numericClass, 4), color, descriptor, coord, spv::ImageOperandsLodMask, ConstantU32(state, 0u));\n            else ' + fetch.trimStart());
        const sample = '    if (RdnaImageDimensionInfoFor(access.image.dimension).multisampled == 0u) return ConstantU32(ctx.state, 0u);';
        return replace(source, sample, '    if (RdnaImageDimensionInfoFor(access.image.dimension).multisampled == 0u || (ctx.state.singleSampleImages && access.image.resourceClass == ImageResourceClass::Storage && !access.image.targetMerge)) return ConstantU32(ctx.state, 0u);');
    });
    await edit('core/libs/prx/libSceAgcDriver/Graphics/include/PlaceholderImages.hpp', source => {
        const condition = '    if (!storageImageMultisample && (shape.usage & VK_IMAGE_USAGE_STORAGE_BIT) != 0 && shape.samples != VK_SAMPLE_COUNT_1_BIT) return std::nullopt;';
        source = replace(source, '    const auto shape = PlaceholderImageShapeOf(heap);', '    auto shape = PlaceholderImageShapeOf(heap);');
        return replace(source, condition, apple(condition, '    if (!storageImageMultisample && (shape.usage & VK_IMAGE_USAGE_STORAGE_BIT) != 0) shape.samples = VK_SAMPLE_COUNT_1_BIT;'));
    });
}
