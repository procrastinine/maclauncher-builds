#pragma once
#include <cstddef>
#include <limits>
#include <type_traits>

namespace AgcDriver::Graphics {
struct ResourcePreparationCapacity {
    std::size_t allocations=0,regions=0,bindings=0;
    bool bounded=true;
};
// One resource binding contributes at most one prepared binding. Buffer arrays
// contribute one allocation per element and a region for each nonempty descriptor; the scalar buffer
// roles contribute one allocation. Image-table bindings can merge across stages.
// Invalid or overflowing metadata leaves capacity unchanged; the existing build
// validates that metadata and reports its original resource error.
template<class Shaders,class RegionCandidate>
ResourcePreparationCapacity CountResourcePreparation(Shaders shaders,std::size_t storageLimit,RegionCandidate regionCandidate) {
    ResourcePreparationCapacity result;
    const auto add=[&](std::size_t &count,std::size_t extra) {
        if(extra>std::numeric_limits<std::size_t>::max()-count)result.bounded=false;
        else count+=extra;
    };
    for(const auto &shader:shaders) {
        if(!shader.program){result.bounded=false;continue;}
        add(result.bindings,shader.program->bindings.size());
        for(const auto &binding:shader.program->bindings) {
            using Role=std::remove_cvref_t<decltype(binding.role)>;
            if(binding.role==Role::GuestBuffers) {
                const bool shaped=binding.count<=storageLimit&&binding.guestDescriptor.size()%4u==0&&binding.guestDescriptor.size()/4u==binding.count;
                if(!shaped)result.bounded=false;
                add(result.allocations,binding.count);
                if(shaped)for(std::size_t i=0;i<binding.count;++i)if(regionCandidate(binding.guestDescriptor.data()+i*4u))add(result.regions,1);
            } else if(binding.role==Role::Gds) {
                add(result.allocations,1);add(result.regions,1);
            } else if(binding.role==Role::BdaPagetable||binding.role==Role::FaultBuffer||binding.role==Role::ShaderData||binding.role==Role::FlattenedSrt||binding.role==Role::ImageTableMap) {
                add(result.allocations,1);
            }
        }
    }
    if(result.allocations>storageLimit)result.bounded=false;
    return result;
}
}
