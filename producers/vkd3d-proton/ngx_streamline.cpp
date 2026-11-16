// SPDX-License-Identifier: MIT
// The NGX core's Streamline camera capture. Streamline passes the game's camera only in slSetConstants; its DLSS
// plugin gives NGX no camera. The core runs in the game's process, loaded by the game's own sl.dlss, so it captures
// the camera in the game's own Streamline interposer, which stays NVIDIA's signed file: in-memory detours on the
// interposer's slSetConstants and slEvaluateFeature exports. slSetConstants copies validated perspective constants
// for its frame token and viewport. slEvaluateFeature(kFeatureDLSS) selects the copy of its frame token and viewport
// as the camera of the evaluations on its thread, calls the original and restores the previous camera. Both always
// return the original result unchanged. Streamline's DLSS feature is 0; NGX numbers its features separately.
// A game that sets Streamline constants but evaluates Super Resolution through NGX itself (Unreal Engine's DLSS
// plugin beside its Streamline plugin) gets the camera of the same frame's constants on that direct evaluation:
// DirectEvaluationCamera binds them by equal jitter offset and declines anything else.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>

#include <cstdio>
#include <cstring>
#include <array>
#include <atomic>
#include <mutex>
#include <memory>
#include <d3d11.h>
#include <d3d12.h>
#include <wrl/client.h>

#include <MinHook.h>
#include <sl_core_api.h>

#include "ngx_camera.h"
#include "streamline_camera.hpp"
#include "streamline_inputs.hpp"
#include "vkd3d_metalfx.h"
#include "streamline_scene.hpp"
#include "streamline_demand.hpp"
#include "common/lane.hpp"

static_assert(sizeof(void *) == 8, "the NGX core is x64");

namespace {
using Microsoft::WRL::ComPtr;
std::unique_ptr<ngx_streamline::SceneDemand> scene_demand;
std::once_flag demand_once;
void InitDemand(){std::call_once(demand_once,[]{scene_demand=std::make_unique<ngx_streamline::SceneDemand>();});}
bool SceneActive()noexcept{return scene_demand&&scene_demand->active();}
thread_local ngx::TemporalScene *selected_scene=nullptr;
struct SceneScope {ngx::TemporalScene *previous=selected_scene;explicit SceneScope(ngx::TemporalScene *next){selected_scene=next;}~SceneScope(){selected_scene=previous;}};
struct CameraScope {RSTemporalCamera previous;explicit CameraScope(const RSTemporalCamera *value):previous(ngx::ExchangeTemporalCamera(value)){}~CameraScope(){ngx::RestoreTemporalCamera(previous);}};

using ngx_streamline::TagImage;using ngx_streamline::TagBatch;using ngx_streamline::SceneCache;using ngx_streamline::CaptureTags;
using SetConstants = sl::Result (*)(const sl::Constants &, const sl::FrameToken &, const sl::ViewportHandle &);
using EvaluateFeature = sl::Result (*)(sl::Feature, const sl::FrameToken &, const sl::BaseStructure **, uint32_t,
                                       sl::CommandBuffer *);

// The interposers hooked in this process: one, or another after the game unloads and loads Streamline again.
constexpr unsigned kSlots = 4;
struct Slot {
  HMODULE module = nullptr;
  void *set_target = nullptr, *evaluate_target = nullptr;
  SetConstants set = nullptr;
  EvaluateFeature evaluate = nullptr;
  void *tag_target=nullptr,*framed_target=nullptr;
  PFun_slSetTag *tag=nullptr;PFun_slSetTagForFrame *framed=nullptr;
  SceneCache scene;
};
Slot slots[kSlots];
SRWLOCK install_lock = SRWLOCK_INIT;

ngx_streamline::CameraCache<128> cameras;
ngx_streamline::DirectCameras direct_cameras;
SRWLOCK camera_lock = SRWLOCK_INIT;
// slEvaluateFeature calls on this thread: NGX evaluations inside them are Streamline's, never direct ones
thread_local unsigned streamline_evaluations = 0;
std::atomic<bool> streamline_hooked{false};
struct EvaluationDepth {EvaluationDepth(){++streamline_evaluations;}~EvaluationDepth(){--streamline_evaluations;}};

sl::Result Capture(Slot &slot,SetConstants original, const sl::Constants &values, const sl::FrameToken &frame,
                   const sl::ViewportHandle &view) {
  const uint32_t frame_id = uint32_t(frame), view_id = uint32_t(view);
  RSTemporalCamera camera, projected;
  const bool valid = ngx_streamline::camera(values, frame_id, view_id, camera);
  bool projection_valid = false;
  try{projection_valid = ngx_streamline::projectionCamera(values, frame_id, view_id, projected);}catch(...){}
  const auto epoch=slot.scene.begin(SceneActive());const bool extra=epoch!=0;ngx_streamline::SceneMatrices matrices;bool matrix_valid=false;
  if(extra)try{matrix_valid=ngx_streamline::matrices(values,matrices);}catch(...){}
  const sl::Result result = original(values, frame, view);
  AcquireSRWLockExclusive(&camera_lock);
  cameras.remember(frame_id, view_id, valid && result == sl::Result::eOk ? &camera : nullptr);
  direct_cameras.remember(frame_id, view_id, values.jitterOffset.x, values.jitterOffset.y,
                          projection_valid && result == sl::Result::eOk ? &projected : nullptr);
  ReleaseSRWLockExclusive(&camera_lock);
  if(extra)try{slot.scene.begin(SceneActive());slot.scene.constants(frame_id,view_id,matrix_valid?&matrices:nullptr,result==sl::Result::eOk,epoch);}catch(...){}
  return result;
}

sl::Result Select(Slot &slot,EvaluateFeature original, sl::Feature feature, const sl::FrameToken &frame,
                  const sl::BaseStructure **inputs, uint32_t count, sl::CommandBuffer *commands) {
  EvaluationDepth depth;
  if (feature != sl::kFeatureDLSS){if(slot.scene.enabled(SceneActive()))try{slot.scene.discard(uint32_t(frame));}catch(...){}SceneScope none(nullptr);return original(feature, frame, inputs, count, commands);}
  uint32_t view_id = 0;
  RSTemporalCamera camera;
  bool valid = ngx_streamline::viewport(inputs, count, view_id);
  if (valid) {
    AcquireSRWLockShared(&camera_lock);
    valid = cameras.lookup(uint32_t(frame), view_id, camera);
    ReleaseSRWLockShared(&camera_lock);
  }
  ngx::TemporalScene scene;std::array<TagImage,2> retained;
  const auto epoch=slot.scene.begin(SceneActive());if(epoch)try{if(ngx_streamline::viewport(inputs,count,view_id)){
    ngx_streamline::SceneMatrices full;bool has_matrices=false;retained=slot.scene.take(uint32_t(frame),view_id,full,has_matrices,commands);
    scene.commands=commands;scene.captureOwner=&slot.scene;scene.captureEpoch=epoch;scene.packet.frameId=uint64_t(uint32_t(frame))+1;scene.packet.viewportId=view_id;
    if(has_matrices){scene.packet.flags|=NGX_SCENE_MATRICES;std::memcpy(scene.packet.worldToView,full.worldToView,sizeof(full.worldToView));std::memcpy(scene.packet.viewToClip,full.viewToClip,sizeof(full.viewToClip));}
    for(unsigned i=0;i<2;++i)scene.images[i]={retained[i].resource,retained[i].commands,retained[i].extent.left,retained[i].extent.top,retained[i].extent.width,retained[i].extent.height};
  }else slot.scene.discard(uint32_t(frame));}catch(...){scene={};retained={};}
  // Both scopes restore nested evaluations, including C++ exception exits.
  CameraScope camera_scope(valid?&camera:nullptr);SceneScope scene_scope(scene.commands?&scene:nullptr);
  return original(feature,frame,inputs,count,commands);
}

template <unsigned N>
sl::Result SetConstantsHook(const sl::Constants &values, const sl::FrameToken &frame, const sl::ViewportHandle &view) {
  return Capture(slots[N],slots[N].set, values, frame, view);
}
template <unsigned N>
sl::Result EvaluateFeatureHook(sl::Feature feature, const sl::FrameToken &frame, const sl::BaseStructure **inputs,
                               uint32_t count, sl::CommandBuffer *commands) {
  return Select(slots[N],slots[N].evaluate, feature, frame, inputs, count, commands);
}
void AttachDuringEvaluation(TagBatch batch,bool accepted){if(!selected_scene)return;if(!accepted||!batch.valid||batch.reset){selected_scene->images={};return;}for(unsigned i=0;i<2;++i)if(batch.images[i].supplied){const auto &image=batch.images[i];selected_scene->images[i]={image.resource,image.commands,image.extent.left,image.extent.top,image.extent.width,image.extent.height};}}
template<unsigned N>sl::Result SetTagHook(const sl::ViewportHandle &view,const sl::ResourceTag *tags,uint32_t count,sl::CommandBuffer *commands){auto &slot=slots[N];const auto epoch=slot.scene.begin(SceneActive());if(!epoch||!commands)return slot.tag(view,tags,count,commands);const bool inline_scope=selected_scene&&selected_scene->captureOwner==&slot.scene&&selected_scene->commands==commands&&selected_scene->packet.viewportId==uint32_t(view);TagBatch batch;try{batch=CaptureTags(tags,count,commands,inline_scope);}catch(...){batch.valid=false;}const auto result=slot.tag(view,tags,count,commands);try{slot.scene.begin(SceneActive());if(slot.scene.current(epoch)){if(inline_scope)AttachDuringEvaluation(std::move(batch),result==sl::Result::eOk);else slot.scene.remember(false,0,uint32_t(view),std::move(batch),result==sl::Result::eOk,epoch);}}catch(...){}return result;}
template<unsigned N>sl::Result SetTagForFrameHook(const sl::FrameToken &frame,const sl::ViewportHandle &view,const sl::ResourceTag *tags,uint32_t count,sl::CommandBuffer *commands){auto &slot=slots[N];const auto epoch=slot.scene.begin(SceneActive());if(!epoch)return slot.framed(frame,view,tags,count,commands);TagBatch batch;try{batch=CaptureTags(tags,count,commands);}catch(...){batch.valid=false;}const auto result=slot.framed(frame,view,tags,count,commands);try{slot.scene.begin(SceneActive());if(!slot.scene.current(epoch))return result;if(selected_scene&&selected_scene->captureOwner==&slot.scene&&selected_scene->packet.frameId==uint64_t(uint32_t(frame))+1&&selected_scene->packet.viewportId==uint32_t(view)&&(!commands||selected_scene->commands==commands))AttachDuringEvaluation(std::move(batch),result==sl::Result::eOk);else slot.scene.remember(true,uint32_t(frame),uint32_t(view),std::move(batch),result==sl::Result::eOk,epoch);}catch(...){}return result;}
PFun_slSetTag *const tag_hooks[kSlots]={SetTagHook<0>,SetTagHook<1>,SetTagHook<2>,SetTagHook<3>};
PFun_slSetTagForFrame *const framed_hooks[kSlots]={SetTagForFrameHook<0>,SetTagForFrameHook<1>,SetTagForFrameHook<2>,SetTagForFrameHook<3>};
const SetConstants set_hooks[kSlots] = {SetConstantsHook<0>, SetConstantsHook<1>, SetConstantsHook<2>,
                                        SetConstantsHook<3>};
const EvaluateFeature evaluate_hooks[kSlots] = {EvaluateFeatureHook<0>, EvaluateFeatureHook<1>,
                                                EvaluateFeatureHook<2>, EvaluateFeatureHook<3>};

// whether MinHook's jump is still at the target: a module loaded again at the same address has its original code
bool Detoured(const void *target, const void *detour) {
  const auto code = static_cast<const uint8_t *>(target);
  if (code[0] != 0xE9)
    return false;
  int32_t offset;
  std::memcpy(&offset, code + 1, sizeof(offset));
  const auto relay = code + 5 + offset;
  // MinHook's x64 relay is an absolute indirect jump (FF 25 00000000) to the detour
  uint64_t address;
  std::memcpy(&address, relay + 6, sizeof(address));
  return relay[0] == 0xFF && relay[1] == 0x25 && address == uint64_t(uintptr_t(detour));
}

void HookTags(unsigned n,HMODULE module){
  auto &slot=slots[n];
  auto install=[&](const char *name,void *detour,void *&saved,void **original){
    auto target=reinterpret_cast<void*>(GetProcAddress(module,name));if(!target)return;
    if(saved==target&&Detoured(target,detour))return;
    MH_RemoveHook(target);
    if(MH_CreateHook(target,detour,original)!=MH_OK)return;
    if(MH_EnableHook(target)!=MH_OK){MH_RemoveHook(target);return;}saved=target;
  };
  install("slSetTag",reinterpret_cast<void*>(tag_hooks[n]),slot.tag_target,reinterpret_cast<void**>(&slot.tag));
  install("slSetTagForFrame",reinterpret_cast<void*>(framed_hooks[n]),slot.framed_target,reinterpret_cast<void**>(&slot.framed));
}

bool Hook(unsigned n, HMODULE module, void *set_target, void *evaluate_target) {
  Slot &slot = slots[n];
  for (void *target : {set_target, evaluate_target})
    MH_RemoveHook(target); // a target recorded for an earlier load of the module
  if (MH_CreateHook(set_target, reinterpret_cast<void *>(set_hooks[n]), reinterpret_cast<void **>(&slot.set)) !=
      MH_OK)
    return false;
  if (MH_CreateHook(evaluate_target, reinterpret_cast<void *>(evaluate_hooks[n]),
                    reinterpret_cast<void **>(&slot.evaluate)) != MH_OK) {
    MH_RemoveHook(set_target);
    return false;
  }
  if (MH_QueueEnableHook(set_target) != MH_OK || MH_QueueEnableHook(evaluate_target) != MH_OK ||
      MH_ApplyQueued() != MH_OK) {
    MH_RemoveHook(set_target);
    MH_RemoveHook(evaluate_target);
    return false;
  }
  slot.module = module;
  slot.set_target = set_target;
  slot.evaluate_target = evaluate_target;
  return true;
}
} // namespace

void ngx::HookStreamline() {
  try{InitDemand();}catch(...){}
  AcquireSRWLockExclusive(&install_lock);
  // a new Streamline session starts with new frame tokens
  AcquireSRWLockExclusive(&camera_lock);
  cameras.clear();
  direct_cameras.clear();
  ReleaseSRWLockExclusive(&camera_lock);
  HMODULE modules[1024];
  DWORD bytes = 0;
  if (!K32EnumProcessModules(GetCurrentProcess(), modules, sizeof(modules), &bytes))
    bytes = 0;
  static bool initialized = false;
  for (DWORD i = 0; i < bytes / sizeof(HMODULE) && i < 1024; i++) {
    const HMODULE module = modules[i];
    // the interposer is the module that exports Streamline's application API; its plugins export none of it
    auto set_target = reinterpret_cast<void *>(GetProcAddress(module, "slSetConstants"));
    auto evaluate_target = reinterpret_cast<void *>(GetProcAddress(module, "slEvaluateFeature"));
    if (!set_target || !evaluate_target || !GetProcAddress(module, "slInit") ||
        !GetProcAddress(module, "slGetNewFrameToken"))
      continue;
    unsigned n = kSlots;
    bool current = false;
    for (unsigned s = 0; s < kSlots; s++)
      if (slots[s].set_target == set_target && slots[s].evaluate_target == evaluate_target) {
        n = s;
        current = Detoured(set_target, reinterpret_cast<void *>(set_hooks[s])) &&
                  Detoured(evaluate_target, reinterpret_cast<void *>(evaluate_hooks[s]));
      }
    if (current){HookTags(n,module);
      continue;
    }
    for (unsigned s = 0; s < kSlots && n == kSlots; s++)
      if (!slots[s].module)
        n = s;
    if (n == kSlots) {
      lane::log("warn", "Streamline camera capture: no free hook for another interposer");
      continue;
    }
    if (!initialized) {
      // keep the core and its detours mapped while the interposer jumps into them
      HMODULE self;
      if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                              reinterpret_cast<LPCWSTR>(&ngx::HookStreamline), &self))
        break;
      const MH_STATUS status = MH_Initialize();
      if (status != MH_OK && status != MH_ERROR_ALREADY_INITIALIZED)
        break;
      initialized = true;
    }
    wchar_t name[MAX_PATH] = L"";
    GetModuleFileNameW(module, name, MAX_PATH);
    if (Hook(n, module, set_target, evaluate_target)) {
      {std::lock_guard guard(slots[n].scene.mutex);slots[n].scene.clear();}
      HookTags(n,module);
      streamline_hooked.store(true, std::memory_order_release);
      lane::log("info", "Streamline camera capture in %ls", name);
    } else
      lane::log("err", "Streamline camera capture: could not hook %ls", name);
  }
  ReleaseSRWLockExclusive(&install_lock);
}

const ngx::TemporalScene *ngx::CurrentTemporalScene()noexcept{if(!SceneActive()||!selected_scene)return nullptr;return !selected_scene->captureOwner||static_cast<SceneCache*>(selected_scene->captureOwner)->current(selected_scene->captureEpoch)?selected_scene:nullptr;}

bool ngx::DirectEvaluationCamera(float jitter_x, float jitter_y, RSTemporalCamera &camera) noexcept {
  camera = {};
  if (streamline_evaluations)
    return false;
  if (!streamline_hooked.load(std::memory_order_acquire))
    return false;
  AcquireSRWLockExclusive(&camera_lock);
  const auto result = direct_cameras.take(jitter_x, jitter_y, camera);
  ReleaseSRWLockExclusive(&camera_lock);
  // each outcome once per process: the first binding, and why evaluations had no camera
  static std::atomic<unsigned> reported{0};
  const unsigned bit = 1u << unsigned(result);
  if (!(reported.fetch_or(bit) & bit)) {
    using Direct = ngx_streamline::DirectCameras;
    static const char *const reasons[] = {"bound", "no Streamline constants since the previous evaluation",
                                          "constants of several frames or viewports since the previous evaluation",
                                          "the evaluation has no jitter offset", "the constants' projection is not a perspective camera",
                                          "the constants follow their frame's evaluation", "the constants' jitter is another frame's",
                                          "consecutive jitter offsets are each other's negation",
                                          "the first evaluation has no previous frame to exclude"};
    if (result == Direct::Bound) {
      char far_plane[32] = "infinite";
      if (!(camera.flags & RS_TEMPORAL_DEPTH_INFINITE))
        snprintf(far_plane, sizeof(far_plane), "%g", camera.farPlane);
      lane::log("info", "Streamline camera on a direct NGX evaluation: frame %llu viewport %llu near %g far %s fov %.4f",
                (unsigned long long)camera.frameId - 1, (unsigned long long)camera.viewportId, camera.nearPlane,
                far_plane, camera.verticalFov);
    } else
      lane::log("info", "No Streamline camera on a direct NGX evaluation (jitter %g, %g): %s", jitter_x, jitter_y,
                reasons[unsigned(result)]);
  }
  return result == ngx_streamline::DirectCameras::Bound;
}
