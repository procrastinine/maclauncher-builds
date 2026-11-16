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
// DirectEvaluationCamera binds them by equal jitter offset and declines anything else. Constants set after their
// frame's evaluation (Unreal Engine's order) are matched to that evaluation the same way and reported.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
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
#include "ngx_late_camera_file.h"
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
std::unique_ptr<ngx_late_camera::File> late_file;
std::once_flag late_once;
// a direct NGX evaluation happened in this process (Streamline-evaluated games never report projections)
std::atomic<bool> direct_evaluated{false};
SRWLOCK camera_lock = SRWLOCK_INIT;
// The latest direct evaluation's frame in VKD3D-Proton and the camera of the constants that followed it, for the late
// scene of the HUD-less and UI images that the game tags after it (vkd3d_metalfx.h LateScene). Under camera_lock.
using LateFrame = ngx_streamline::LateFrame<ID3D12MetalFXScaler>;
LateFrame late_frame;
uint64_t followed_evaluation = 0;
RSTemporalCamera followed_camera{};
// slEvaluateFeature calls on this thread: NGX evaluations inside them are Streamline's, never direct ones
thread_local unsigned streamline_evaluations = 0;
std::atomic<bool> streamline_hooked{false};
struct EvaluationDepth {EvaluationDepth(){++streamline_evaluations;}~EvaluationDepth(){--streamline_evaluations;}};
// Diagnostic lines go to the NGX core's log and to the debugger output (Wine's debugstr channel): a game without a
// console has no stderr.
void Report(const char *format, ...) {
  char text[512];
  va_list values;
  va_start(values, format);
  vsnprintf(text, sizeof(text), format, values);
  va_end(values);
  lane::log("info", "%s", text);
  OutputDebugStringA((std::string("vkd3d-ngx: ") + text + "\n").c_str());
}
// Why the constants' projection gives no camera, once per reason, with the matrix and the declarations.
void ReportProjection(ngx_streamline::Projection reason, const sl::Constants &values) {
  static std::atomic<unsigned> reported{0};
  const unsigned bit = 1u << unsigned(reason);
  if (reported.fetch_or(bit) & bit)
    return;
  static const char *const reasons[] = {"", "not Streamline constants", "orthographic", "not finite", "not a perspective shape",
                                        "depth direction", "near, far or field of view"};
  const float *m = &values.cameraViewToClip.row[0].x;
  Report("Streamline projection gives no camera (%s): version %u depthInverted %d orthographic %d "
         "[%g %g %g %g | %g %g %g %g | %g %g %g %g | %g %g %g %g]",
         reasons[unsigned(reason)], unsigned(values.structVersion), int(values.depthInverted), int(values.orthographicProjection),
         double(m[0]), double(m[1]), double(m[2]), double(m[3]), double(m[4]), double(m[5]), double(m[6]), double(m[7]),
         double(m[8]), double(m[9]), double(m[10]), double(m[11]), double(m[12]), double(m[13]), double(m[14]), double(m[15]));
}
// Constants that follow their frame's direct evaluation (Unreal Engine's order): each outcome once per process, and
// after 1000 such constants how many followed their evaluation exactly.
void ReportFollow(ngx_streamline::DirectCameras::Follow result, float jitter_x, float jitter_y, uint64_t evaluation,
                  const RSTemporalCamera &camera) {
  using Direct = ngx_streamline::DirectCameras;
  if (result == Direct::NoEvaluation)
    return;
  static std::atomic<unsigned> reported{0}, total{0}, followed{0};
  const unsigned count = total.fetch_add(1) + 1, exact = followed.fetch_add(result == Direct::Followed ? 1 : 0) +
                                                        (result == Direct::Followed ? 1 : 0);
  if (count == 1000)
    Report("Streamline constants after direct NGX evaluations: %u of %u follow their evaluation exactly", exact, count);
  const unsigned bit = 1u << unsigned(result);
  if (reported.fetch_or(bit) & bit)
    return;
  static const char *const reasons[] = {"followed", "", "constants of several frames or viewports since the evaluation",
                                        "no jitter offset", "the constants' projection is not a perspective camera",
                                        "the constants' jitter is not the latest evaluation's",
                                        "the jitter offset matches both latest evaluations"};
  if (result == Direct::Followed) {
    char far_plane[32] = "infinite";
    if (!(camera.flags & RS_TEMPORAL_DEPTH_INFINITE))
      snprintf(far_plane, sizeof(far_plane), "%g", camera.farPlane);
    Report("Streamline constants follow direct NGX evaluation %llu exactly: frame %llu near %g far %s fov %.4f",
           (unsigned long long)evaluation, (unsigned long long)camera.frameId - 1, double(camera.nearPlane), far_plane,
           double(camera.verticalFov));
  } else
    Report("Streamline constants (jitter %g, %g) follow no direct NGX evaluation exactly: %s", double(jitter_x),
           double(jitter_y), reasons[unsigned(result)]);
}

sl::Result Capture(Slot &slot,SetConstants original, const sl::Constants &values, const sl::FrameToken &frame,
                   const sl::ViewportHandle &view) {
  const uint32_t frame_id = uint32_t(frame), view_id = uint32_t(view);
  RSTemporalCamera camera, projected;
  const bool valid = ngx_streamline::camera(values, frame_id, view_id, camera);
  auto projection = ngx_streamline::Projection::Structure;
  try{projection = ngx_streamline::projectionReason(values, frame_id, view_id, projected);}catch(...){}
  const bool projection_valid = projection == ngx_streamline::Projection::Valid;
  if (!projection_valid && direct_evaluated.load(std::memory_order_relaxed))
    ReportProjection(projection, values);
  const auto epoch=slot.scene.begin(SceneActive());const bool extra=epoch!=0;ngx_streamline::SceneMatrices matrices;bool matrix_valid=false;
  if(extra)try{matrix_valid=ngx_streamline::matrices(values,matrices);}catch(...){}
  const sl::Result result = original(values, frame, view);
  AcquireSRWLockExclusive(&camera_lock);
  cameras.remember(frame_id, view_id, valid && result == sl::Result::eOk ? &camera : nullptr);
  direct_cameras.remember(frame_id, view_id, values.jitterOffset.x, values.jitterOffset.y,
                          projection_valid && result == sl::Result::eOk ? &projected : nullptr);
  uint64_t evaluation = 0;
  float evaluation_jitter[2]{};
  RSTemporalCamera followed;
  const auto follow = direct_cameras.follow(evaluation, evaluation_jitter, followed);
  bool published = false;
  if (follow == ngx_streamline::DirectCameras::Followed) {
    followed_evaluation = evaluation;
    followed_camera = followed;
    std::call_once(late_once, [] { late_file = std::make_unique<ngx_late_camera::File>(); });
    if (auto mailbox = late_file->get()) {
      ngx_late_camera::publish(*mailbox, evaluation_jitter[0], evaluation_jitter[1], evaluation, followed);
      published = true;
    }
  }
  ReleaseSRWLockExclusive(&camera_lock);
  ReportFollow(follow, values.jitterOffset.x, values.jitterOffset.y, evaluation, followed);
  if (follow == ngx_streamline::DirectCameras::Followed) {
    static std::atomic<unsigned> reported{0};
    if (!(reported.fetch_or(published ? 1u : 2u) & (published ? 1u : 2u)))
      Report(published ? "Late camera published for generation in effect-plan.temporal-camera"
                       : "No late camera file beside the effect plan; generation receives no camera");
  }
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
sl::Result SetTagScene(Slot &slot,const sl::ViewportHandle &view,const sl::ResourceTag *tags,uint32_t count,sl::CommandBuffer *commands){const auto epoch=slot.scene.begin(SceneActive());if(!epoch||!commands)return slot.tag(view,tags,count,commands);const bool inline_scope=selected_scene&&selected_scene->captureOwner==&slot.scene&&selected_scene->commands==commands&&selected_scene->packet.viewportId==uint32_t(view);TagBatch batch;try{batch=CaptureTags(tags,count,commands,inline_scope);}catch(...){batch.valid=false;}const auto result=slot.tag(view,tags,count,commands);try{slot.scene.begin(SceneActive());if(slot.scene.current(epoch)){if(inline_scope)AttachDuringEvaluation(std::move(batch),result==sl::Result::eOk);else slot.scene.remember(false,0,uint32_t(view),std::move(batch),result==sl::Result::eOk,epoch);}}catch(...){}return result;}
sl::Result SetTagForFrameScene(Slot &slot,const sl::FrameToken &frame,const sl::ViewportHandle &view,const sl::ResourceTag *tags,uint32_t count,sl::CommandBuffer *commands){const auto epoch=slot.scene.begin(SceneActive());if(!epoch)return slot.framed(frame,view,tags,count,commands);TagBatch batch;try{batch=CaptureTags(tags,count,commands);}catch(...){batch.valid=false;}const auto result=slot.framed(frame,view,tags,count,commands);try{slot.scene.begin(SceneActive());if(!slot.scene.current(epoch))return result;if(selected_scene&&selected_scene->captureOwner==&slot.scene&&selected_scene->packet.frameId==uint64_t(uint32_t(frame))+1&&selected_scene->packet.viewportId==uint32_t(view)&&(!commands||selected_scene->commands==commands))AttachDuringEvaluation(std::move(batch),result==sl::Result::eOk);else slot.scene.remember(true,uint32_t(frame),uint32_t(view),std::move(batch),result==sl::Result::eOk,epoch);}catch(...){}return result;}
// A command list's late scene interface (a C interface), released at scope end; null without one.
struct MetalFX1 {
  ID3D12GraphicsCommandListMetalFX1 *iface = nullptr;
  explicit MetalFX1(IUnknown *list) noexcept {
    void *found = nullptr;
    if (list && SUCCEEDED(list->QueryInterface(IID_ID3D12GraphicsCommandListMetalFX1, &found)))
      iface = static_cast<ID3D12GraphicsCommandListMetalFX1 *>(found);
  }
  ~MetalFX1() {
    if (iface)
      iface->lpVtbl->Release(iface);
  }
  MetalFX1(const MetalFX1 &) = delete;
  MetalFX1 &operator=(const MetalFX1 &) = delete;
};
// The HUD-less color and UI color and alpha that a game tags after its direct NGX evaluation of a frame (Unreal
// Engine's Streamline plugin tags them after its own DLSS pass) are that frame's: tags between one direct evaluation
// and the next name the latest one. They are recorded as its late scene in the tagging command list, where their
// contents are complete, with the camera of the constants that followed the same evaluation. Only while MacLauncher's
// late camera file exists (an enabled frame-generation row consumes the scene) and never inside slEvaluateFeature.
void ReportLateTag(unsigned reason, const char *text) {
  static std::atomic<unsigned> reported{0};
  const unsigned bit = 1u << reason;
  if (!(reported.fetch_or(bit) & bit))
    Report("No late tagged scene: %s", text);
}
void LateTags(const sl::ResourceTag *tags, uint32_t count, sl::CommandBuffer *commands) noexcept {
  try {
    if (!commands) { ReportLateTag(0, "tag call has no command list"); return; }
    if (selected_scene || streamline_evaluations) { ReportLateTag(1, "tag call belongs to a Streamline evaluation"); return; }
    if (!direct_evaluated.load(std::memory_order_acquire)) { ReportLateTag(2, "no direct evaluation yet"); return; }
    std::call_once(late_once, [] { late_file = std::make_unique<ngx_late_camera::File>(); });
    if (!late_file->get()) { ReportLateTag(3, "no enabled late camera channel"); return; }
    const TagBatch batch = CaptureTags(tags, count, commands);
    if (!batch.valid || batch.reset || (!batch.images[0].resource && !batch.images[1].resource)) {
      ReportLateTag(4, "tag batch has no readable HUD-less or UI image"); return;
    }
    AcquireSRWLockShared(&camera_lock);
    const LateFrame frame = late_frame;
    const bool camera = frame.evaluation && followed_evaluation == frame.evaluation;
    const RSTemporalCamera followed = followed_camera;
    ReleaseSRWLockShared(&camera_lock);
    if (!frame.scaler || !frame.frame) { ReportLateTag(5, "no direct scaler frame"); return; }
    // a D3D12 game's tags name its command list and resources (the evaluation was recorded through the same device)
    MetalFX1 metalfx(static_cast<IUnknown *>(static_cast<void *>(commands)));
    if (!metalfx.iface) { ReportLateTag(6, "tag command list has no late scene interface"); return; }
    VKD3D_METALFX_LATE_SCENE_DESC desc = {};
    desc.FrameId = frame.frame;
    desc.HudLess = static_cast<ID3D12Resource *>(batch.images[0].resource);
    desc.UI = static_cast<ID3D12Resource *>(batch.images[1].resource);
    if (camera) {
      desc.CameraValid = TRUE;
      desc.DepthReversed = bool(followed.flags & RS_TEMPORAL_DEPTH_REVERSED);
      desc.DepthInfinite = bool(followed.flags & RS_TEMPORAL_DEPTH_INFINITE);
      desc.NearPlane = followed.nearPlane;
      desc.FarPlane = followed.farPlane;
      desc.VerticalFov = followed.verticalFov;
    }
    const HRESULT result = metalfx.iface->lpVtbl->LateScene(metalfx.iface, &desc, frame.scaler);
    static std::atomic<unsigned> reported{0};
    const unsigned bit = SUCCEEDED(result) ? 1u : 2u;
    if (!(reported.fetch_or(bit) & bit))
      Report(SUCCEEDED(result) ? "Late scene recorded for frame %llu: HUD-less %s, UI %s, camera %s"
                               : "Late scene of frame %llu not recorded: HUD-less %s, UI %s, camera %s (0x%08lx)",
             (unsigned long long)frame.frame, desc.HudLess ? "yes" : "no", desc.UI ? "yes" : "no", camera ? "yes" : "no",
             (unsigned long)result);
  } catch (...) {
  }
}
template<unsigned N>sl::Result SetTagHook(const sl::ViewportHandle &view,const sl::ResourceTag *tags,uint32_t count,sl::CommandBuffer *commands){
  const auto result=SetTagScene(slots[N],view,tags,count,commands);if(result==sl::Result::eOk)LateTags(tags,count,commands);return result;}
template<unsigned N>sl::Result SetTagForFrameHook(const sl::FrameToken &frame,const sl::ViewportHandle &view,const sl::ResourceTag *tags,uint32_t count,sl::CommandBuffer *commands){
  const auto result=SetTagForFrameScene(slots[N],frame,view,tags,count,commands);if(result==sl::Result::eOk)LateTags(tags,count,commands);return result;}
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
    Report("Streamline late scene tag capture installed: %s", name);
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
      OutputDebugStringW((std::wstring(L"vkd3d-ngx: Streamline camera capture in ") + name + L"\n").c_str());
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
  direct_evaluated.store(true, std::memory_order_relaxed);
  // the late camera file exists before this frame's generation looks for it
  std::call_once(late_once, [] { late_file = std::make_unique<ngx_late_camera::File>(); });
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
      Report("Streamline camera on a direct NGX evaluation: frame %llu viewport %llu near %g far %s fov %.4f",
             (unsigned long long)camera.frameId - 1, (unsigned long long)camera.viewportId, double(camera.nearPlane),
             far_plane, double(camera.verticalFov));
    } else
      Report("No Streamline camera on a direct NGX evaluation (jitter %g, %g): %s", double(jitter_x), double(jitter_y),
             reasons[unsigned(result)]);
  }
  return result == ngx_streamline::DirectCameras::Bound;
}

void ngx::DirectEvaluationLateCamera(ID3D12GraphicsCommandList *list, ID3D12MetalFXScaler *scaler) noexcept {
  if (!list || !scaler || streamline_evaluations || !late_file || !late_file->get())
    return;
  MetalFX1 metalfx(list);
  if (!metalfx.iface)
    return;
  const uint64_t current_frame = metalfx.iface->lpVtbl->TemporalFrameId(metalfx.iface, scaler);
  AcquireSRWLockShared(&camera_lock);
  const LateFrame frame = late_frame;
  const bool matches = frame.matches(scaler, current_frame, followed_evaluation);
  const RSTemporalCamera camera = followed_camera;
  ReleaseSRWLockShared(&camera_lock);
  if (!matches)
    return;
  VKD3D_METALFX_LATE_SCENE_DESC desc = {};
  desc.FrameId = frame.frame;
  desc.CameraValid = TRUE;
  desc.DepthReversed = bool(camera.flags & RS_TEMPORAL_DEPTH_REVERSED);
  desc.DepthInfinite = bool(camera.flags & RS_TEMPORAL_DEPTH_INFINITE);
  desc.NearPlane = camera.nearPlane;
  desc.FarPlane = camera.farPlane;
  desc.VerticalFov = camera.verticalFov;
  const HRESULT result = metalfx.iface->lpVtbl->LateScene(metalfx.iface, &desc, scaler);
  static std::atomic<unsigned> reported{0};
  const unsigned bit = SUCCEEDED(result) ? 1u : 2u;
  if (!(reported.fetch_or(bit) & bit))
    Report(SUCCEEDED(result) ? "Late camera scene recorded for frame %llu before the next evaluation"
                             : "Late camera scene of frame %llu not recorded (0x%08lx)",
           (unsigned long long)frame.frame, (unsigned long)result);
}

void ngx::DirectEvaluationFrame(ID3D12GraphicsCommandList *list, ID3D12MetalFXScaler *scaler) noexcept {
  if (!list || !scaler || streamline_evaluations || !streamline_hooked.load(std::memory_order_acquire))
    return;
  MetalFX1 metalfx(list);
  if (!metalfx.iface)
    return;
  const uint64_t frame = metalfx.iface->lpVtbl->TemporalFrameId(metalfx.iface, scaler);
  AcquireSRWLockExclusive(&camera_lock);
  late_frame = {scaler, frame, direct_cameras.evaluations()};
  ReleaseSRWLockExclusive(&camera_lock);
}

void ngx::ForgetEvaluationFrames(ID3D12MetalFXScaler *scaler) noexcept {
  AcquireSRWLockExclusive(&camera_lock);
  if (late_frame.scaler == scaler)
    late_frame = {};
  ReleaseSRWLockExclusive(&camera_lock);
}
