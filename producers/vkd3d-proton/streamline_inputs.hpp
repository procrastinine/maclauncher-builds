// SPDX-License-Identifier: MIT
#pragma once
#include "streamline_camera.hpp"
#include <array>
#include <atomic>
#include <mutex>
namespace ngx_streamline {
struct TagImage {
  bool supplied=false;void *resource=nullptr,*commands=nullptr;sl::Extent extent{};
};
struct TagBatch {bool valid=true,reset=false;std::array<TagImage,2>images;};
struct SceneCache {
  struct Marker {uint64_t age=0;uint32_t frame=0,view=0;};
  struct Tags {uint64_t age=0;uint32_t frame=0,view=0;bool framed=false;std::array<TagImage,2>images;};
  std::mutex mutex;uint64_t age=0;std::atomic<bool>active{false};std::atomic<uint64_t>epoch{1};
  ngx_streamline::CameraCache<128,ngx_streamline::SceneMatrices> matrices;
  std::array<Marker,128> closed{};std::array<Tags,32> tags{};
  void clear(){matrices.clear();closed={};tags={};age=0;++epoch;}
  bool wasEvaluated(uint32_t frame,uint32_t view)const{for(const auto &m:closed)if(m.age&&m.frame==frame&&(m.view==view||m.view==UINT32_MAX))return true;return false;}
  void close(uint32_t frame,uint32_t view){auto target=&closed[0];for(auto &m:closed){if(m.age&&m.frame==frame&&m.view==view)return;if(m.age<target->age)target=&m;}*target={++age,frame,view};}
  uint64_t begin(bool next)noexcept{if(!next&&!active.load(std::memory_order_acquire))return 0;try{std::lock_guard guard(mutex);if(active.load()!=next){if(!next)clear();else ++epoch;active.store(next,std::memory_order_release);}return next?epoch.load():0;}catch(...){return 0;}}
  bool enabled(bool next)noexcept{return begin(next)!=0;}
  uint64_t token()const noexcept{return epoch.load(std::memory_order_acquire);}
  bool current(uint64_t token)const noexcept{return token&&active.load(std::memory_order_acquire)&&epoch.load(std::memory_order_acquire)==token;}
  void constants(uint32_t frame,uint32_t view,const ngx_streamline::SceneMatrices *value,bool accepted,uint64_t requestEpoch){
    std::lock_guard guard(mutex);if(!current(requestEpoch))return;matrices.remember(frame,view,accepted?value:nullptr);
  }
  void remember(bool framed,uint32_t frame,uint32_t view,TagBatch batch,bool accepted,uint64_t requestEpoch){
    std::lock_guard guard(mutex);if(!current(requestEpoch))return;if(framed&&wasEvaluated(frame,view))return;
    auto target=&tags[0];for(auto &entry:tags){if(entry.age&&entry.framed==framed&&entry.frame==frame&&entry.view==view){target=&entry;break;}if(entry.age<target->age)target=&entry;}
    if(!target->age||target->framed!=framed||target->frame!=frame||target->view!=view)*target={};
    target->age=++age;target->frame=frame;target->view=view;target->framed=framed;
    if(!accepted||!batch.valid||batch.reset){target->images={};return;}
    for(unsigned i=0;i<2;++i)if(batch.images[i].supplied)target->images[i]=std::move(batch.images[i]);
  }
  std::array<TagImage,2> take(uint32_t frame,uint32_t view,ngx_streamline::SceneMatrices &camera,bool &valid,void *commands=nullptr){
    std::lock_guard guard(mutex);valid=matrices.lookup(frame,view,camera);std::array<TagImage,2>result;close(frame,view);
    // Unframed eValidUntilEvaluate inputs belong only to the next evaluation,
    // with exact explicit command identity. No constants choose their frame.
    for(auto &entry:tags)if(entry.age&&!entry.framed){if(entry.view==view&&commands)for(unsigned i=0;i<2;++i)if(entry.images[i].supplied&&entry.images[i].commands==commands)result[i]=std::move(entry.images[i]);entry={};}
    for(auto &entry:tags)if(entry.age&&entry.framed&&entry.frame==frame&&entry.view==view){for(unsigned i=0;i<2;++i)if(entry.images[i].supplied)result[i]=std::move(entry.images[i]);entry={};break;}return result;
  }
  void discard(uint32_t frame){std::lock_guard guard(mutex);for(auto &entry:tags)if(entry.age&&(!entry.framed||entry.frame==frame))entry={};close(frame,UINT32_MAX);}
};
inline int TagSlot(sl::BufferType type){return type==sl::kBufferTypeHUDLessColor?0:type==sl::kBufferTypeUIColorAndAlpha?1:-1;}
inline TagBatch CaptureTags(const sl::ResourceTag *tags,uint32_t count,void *commands,bool allow_present=true,bool immediate=false){
  TagBatch result;result.reset=!tags;if(count>256||(count&&!tags)){result.valid=false;return result;}
  for(uint32_t i=0;i<count;++i){const auto &tag=tags[i];if(tag.structType!=sl::ResourceTag::s_structType||tag.structVersion!=1){result.valid=false;return result;}const int slot=TagSlot(tag.type);if(slot<0)continue;auto &image=result.images[slot];image={};image.supplied=true;
    // Valid-now inputs are consumed only by an inline late-scene copy on this command list.
    if(!tag.resource||(tag.lifecycle!=sl::eValidUntilEvaluate&&tag.lifecycle!=sl::eValidUntilPresent&&!(immediate&&commands&&tag.lifecycle==sl::eOnlyValidNow)))continue;
    if(!allow_present&&(tag.lifecycle!=sl::eValidUntilEvaluate||!commands))continue;
    if(tag.lifecycle==sl::eValidUntilEvaluate&&!commands)continue;
    auto extension=tag.next;unsigned links=0;bool precision=true;while(extension&&links++<32){if(extension->structType==sl::PrecisionInfo::s_structType){auto p=static_cast<const sl::PrecisionInfo*>(extension);precision&=p->structVersion==1&&p->conversionFormula==sl::PrecisionInfo::eNoTransform;}else precision=false;extension=extension->next;}if(extension||!precision)continue;
    const auto &resource=*tag.resource;if(resource.structType!=sl::Resource::s_structType||resource.structVersion!=1||resource.type!=sl::ResourceType::eTex2d||!resource.native)continue;
    // These two lifecycles guarantee the borrowed input through the next
    // evaluation. Do not cast or AddRef an API-ambiguous native handle here.
    // Typed NGX dispatch validates it synchronously inside that evaluation.
    const auto &e=tag.extent;image.resource=resource.native;image.commands=commands;image.extent=e;
  }return result;
}
}
