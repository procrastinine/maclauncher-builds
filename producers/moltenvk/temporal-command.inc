// SPDX-License-Identifier: MIT
// Included in MVKCommandPool.mm. This adapter only forwards scene information;
// the loaded graphics pipeline owns provider selection, history and encoding.
#include "MVKImage.h"
#include "temporal-map.hpp"
#include <dlfcn.h>
#include <mutex>
#include <unordered_map>
#include <array>
#include <atomic>
#import <MetalFX/MetalFX.h>
struct MVKTemporalPipeline {
    int (*process)(const RSTemporalFrame*,RSTemporalResult*)=nullptr;
    uint32_t (*method)()=nullptr;
    void (*release)(void*)=nullptr;
    MVKTemporalPipeline() {
        void* address=dlsym(RTLD_DEFAULT,"rsProcessTemporalFrame"); Dl_info info{};
        if(!address||!dladdr(address,&info)||!info.dli_fname)return;
        // Keep the exact graphics library loaded while its histories exist.
        void* library=dlopen(info.dli_fname,RTLD_NOW|RTLD_LOCAL|RTLD_NODELETE|RTLD_NOLOAD);
        if(!library)return;
        process=(decltype(process))dlsym(library,"rsProcessTemporalFrame");
        method=(decltype(method))dlsym(library,"rsGetTemporalMethod");
        release=(decltype(release))dlsym(library,"rsReleaseTemporalOwner");
        if(!process||!method||!release)process=nullptr;
    }
};
static const MVKTemporalPipeline& mvkTemporalPipeline(){static MVKTemporalPipeline pipeline;return pipeline;}
const char* mvkTemporalDriverInfo(id<MTLDevice> device){
    if(!mvkTemporalPipeline().process)return "";
    static void* framework=dlopen("/System/Library/Frameworks/MetalFX.framework/MetalFX",RTLD_LAZY|RTLD_LOCAL);
    Class descriptor=framework?NSClassFromString(@"MTLFXTemporalScalerDescriptor"):Nil;
    return descriptor&&[descriptor supportsDevice:device]?" temporal-sr":"";
}
struct MVKTemporalOwner {
    std::atomic<bool> reported{false};
    ~MVKTemporalOwner(){mvkTemporalPipeline().release(this);}
};
struct MVKTemporalState {
    std::mutex mutex;
    std::unordered_map<uint64_t,std::shared_ptr<MVKTemporalOwner>> owners;
};
static std::mutex mvkTemporalStateMutex;
void mvkTemporalFinish(MVKDevice* device){delete device->_temporal;device->_temporal=nullptr;}
struct MVKTemporalRecord {
    RSTemporalFrame frame{};
    std::array<id<MTLTexture>,TEMPORAL_IMAGES> textures{};
    std::shared_ptr<MVKTemporalOwner> owner;
    ~MVKTemporalRecord(){for(auto texture:textures)[texture release];}
};
VkResult MVKCmdTemporalFrame::setContent(MVKCommandBuffer* commands,const VkTemporalFrameInfoMVK* info){
    _frame.reset();
    if(!mvkTemporalPipeline().process||info->featureType!=TEMPORAL_SUPER_RESOLUTION)
        return VK_ERROR_FEATURE_NOT_PRESENT;
    if(!info->images[TEMPORAL_OUTPUT] || info->images[TEMPORAL_OUTPUT]==info->images[TEMPORAL_COLOR] ||
       info->images[TEMPORAL_OUTPUT]==info->images[TEMPORAL_DEPTH] ||
       info->images[TEMPORAL_OUTPUT]==info->images[TEMPORAL_MOTION])return VK_ERROR_INITIALIZATION_FAILED;
    auto record=std::make_shared<MVKTemporalRecord>();
    auto device=commands->getDevice();
    for(unsigned n=0;n<TEMPORAL_IMAGES;n++){
        if(!info->images[n])continue;
        auto image=(MVKImage*)info->images[n];
        if(image->getDevice()!=device||image->getPlaneCount()!=1||image->getSampleCount()!=VK_SAMPLE_COUNT_1_BIT)
            return VK_ERROR_FEATURE_NOT_PRESENT;
        auto texture=image->getMTLTexture();
        if(!texture||texture.textureType!=MTLTextureType2D||texture.framebufferOnly)
            return VK_ERROR_FEATURE_NOT_PRESENT;
        const auto format=info->formats[n]==VK_FORMAT_UNDEFINED?texture.pixelFormat:
            image->getPixelFormats()->getMTLPixelFormat(info->formats[n]);
        if(format==MTLPixelFormatInvalid)return VK_ERROR_FORMAT_NOT_SUPPORTED;
        if(format!=texture.pixelFormat){
            if(!(texture.usage&MTLTextureUsagePixelFormatView))return VK_ERROR_FORMAT_NOT_SUPPORTED;
            record->textures[n]=[texture newTextureViewWithPixelFormat:format];
        }else record->textures[n]=[texture retain];
        if(!record->textures[n])return VK_ERROR_FORMAT_NOT_SUPPORTED;
    }
    auto color=record->textures[TEMPORAL_COLOR],depth=record->textures[TEMPORAL_DEPTH];
    auto motion=record->textures[TEMPORAL_MOTION],output=record->textures[TEMPORAL_OUTPUT];
    if(!color||!depth||!motion||!output||color==output||depth==output||motion==output||
       !mvkTemporalMap(*info,color.width,color.height,depth.width,depth.height,motion.width,motion.height,
                       output.width,output.height,record->frame))return VK_ERROR_INITIALIZATION_FAILED;
    {
        std::lock_guard<std::mutex> lock(mvkTemporalStateMutex);
        if(!device->_temporal)device->_temporal=new MVKTemporalState;
    }
    {
        auto state=device->_temporal;std::lock_guard<std::mutex> lock(state->mutex);
        if(info->releaseFeatureIdCount&&!info->pReleaseFeatureIds)return VK_ERROR_INITIALIZATION_FAILED;
        for(uint32_t n=0;n<info->releaseFeatureIdCount;n++)state->owners.erase(info->pReleaseFeatureIds[n]);
        auto& owner=state->owners[info->featureId];if(!owner)owner=std::make_shared<MVKTemporalOwner>();
        record->owner=owner;
    }
    auto& f=record->frame;f.owner=record->owner.get();f.color=color;f.depth=depth;f.motion=motion;
    f.output=output;f.exposure=record->textures[TEMPORAL_EXPOSURE];
    commands->_hasTemporalFrame=true;
    _frame=std::move(record);return VK_SUCCESS;
}
void MVKCmdTemporalFrame::encode(MVKCommandEncoder* encoder){
    if(!_frame)return;
    auto commands=encoder->_mtlCmdBuffer;
    if(!commands||encoder->isInRenderPass()||commands.status>=MTLCommandBufferStatusCommitted){
        encoder->_cmdBuffer->setConfigurationResult(VK_ERROR_INITIALIZATION_FAILED);return;
    }
    encoder->endCurrentMetalEncoding();
    auto f=_frame->frame;f.commandBuffer=commands;f.commandBufferKind=0;
    const auto& pipeline=mvkTemporalPipeline();const auto selected=pipeline.method();
    f.method=selected?selected:RS_TEMPORAL_METALFX;
    RSTemporalResult result{};result.size=sizeof(result);result.version=1;
    const auto status=pipeline.process(&f,&result);
    if(!_frame->owner->reported.load(std::memory_order_relaxed)){
        MVKLogInfo("Temporal frame %llu: method %u, %ux%u to %ux%u, status %d encoded %u (%s)",
            (unsigned long long)f.frameId,f.method,f.renderWidth,f.renderHeight,f.outputWidth,f.outputHeight,
            status,result.encoded,result.reason);
        _frame->owner->reported.store(status==RS_TEMPORAL_OK&&result.encoded,std::memory_order_relaxed);
    }
    if(status!=RS_TEMPORAL_OK||!result.encoded){
        // Failed/preparing output is never treated as a completed upscale.
        encoder->_cmdBuffer->setConfigurationResult(VK_ERROR_INITIALIZATION_FAILED);
    }
}
MVKCommandTypePool<MVKCommand>* MVKCmdTemporalFrame::getTypePool(MVKCommandPool* pool){
    _frame.reset();return (MVKCommandTypePool<MVKCommand>*)&pool->_cmdTemporalFramePool;
}
