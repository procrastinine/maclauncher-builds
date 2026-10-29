import fs from 'node:fs/promises';
import path from 'node:path';
function replace(source,before,after){
 if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('AnyPS5 resource preparation source changed: '+before.slice(0,96));
 return source.replace(before,after);
}
export async function applyResourcePreparationOverlay(root){
 const base=path.join(root,'core/libs/prx/libSceAgcDriver/Graphics');
 await fs.copyFile(new URL('./ResourcePreparation.hpp',import.meta.url),path.join(base,'include/ResourcePreparation.hpp'));
 const header=path.join(base,'include/GuestBufferMemory.hpp');
 let memory=await fs.readFile(header,'utf8');
 memory=replace(memory,'    void AddReadable(std::uint64_t address, std::size_t bytes);',`    void AddReadable(std::uint64_t address, std::size_t bytes);
    void ReserveDescriptorRegions(std::size_t count) {
        if(count<=regions.max_size()-regions.size())regions.reserve(regions.size()+count);
    }`);
 await fs.writeFile(header,memory);
 const file=path.join(base,'src/ShaderResources.cpp');let source=await fs.readFile(file,'utf8');
 source='#include "prx/libSceAgcDriver/Graphics/include/ResourcePreparation.hpp"\n'+source;
 source=replace(source,'        std::set<std::uint32_t> occupied;',`        const auto capacity=CountResourcePreparation(shaders,std::max<std::size_t>(context.limits.maxDescriptorSetStorageBuffers,context.descriptorIndexingLimits.maxDescriptorSetUpdateAfterBindStorageBuffers),[](const std::uint32_t* words) {
            const ShaderRecompiler::ShaderBufferResource descriptor{{words[0],words[1]&~0x40000000u,words[2],words[3]}};
            return descriptor.Base48()!=0&&descriptor.GetSize()!=0;
        });
        if(capacity.bounded) {
            if(capacity.allocations<=allocations.max_size()-allocations.size())allocations.reserve(allocations.size()+capacity.allocations);
            if(capacity.bindings<=bindings.max_size()-bindings.size())bindings.reserve(bindings.size()+capacity.bindings);
            guestMemory.ReserveDescriptorRegions(capacity.regions);
        }
        std::set<std::uint32_t> occupied;`);
 source=replace(source,'                    Require(binding.guestDescriptor.size() == static_cast<std::uint64_t>(binding.count) * 4, "guest buffer descriptor must contain four DWORDs per array element");',`                    Require(binding.guestDescriptor.size() == static_cast<std::uint64_t>(binding.count) * 4, "guest buffer descriptor must contain four DWORDs per array element");
                    item.allocations.reserve(binding.count);`);
 source=replace(source,'    auto& counters = TextureCounts();\n    // The element\'s stage-A record,',`    item.imageAllocations.reserve(binding.count);
    auto& counters = TextureCounts();
    // The element's stage-A record,`);
 source=replace(source,'    if (sampledImage) {\n        Require(elementWords == 8,',`    if(samplerKind)item.imageAllocations.reserve(binding.count);
    if (sampledImage) {
        Require(elementWords == 8,`);
 source=replace(source,'    Binding item{{binding.binding, VK_DESCRIPTOR_TYPE_SAMPLER, context.samplerTableCapacity, flags, nullptr}, {}, {}, samplerTableFlags};',`    Binding item{{binding.binding, VK_DESCRIPTOR_TYPE_SAMPLER, context.samplerTableCapacity, flags, nullptr}, {}, {}, samplerTableFlags};
    item.imageAllocations.reserve(binding.count);`);
 source=replace(source,'    imageRecords.clear();\n    nextImageRecord = 0;',`    imageRecords.clear();
    std::size_t imageCount=0;bool boundedImages=true;
    for(const auto &deferred:deferredImages) {
        if(deferred.binding->count>imageRecords.max_size()-imageCount){boundedImages=false;break;}
        imageCount+=deferred.binding->count;
    }
    if(boundedImages)imageRecords.reserve(imageCount);
    nextImageRecord = 0;`);
 await fs.writeFile(file,source);
}
