// SPDX-License-Identifier: MIT
// The NGX core's Streamline camera capture. Streamline passes the game's camera only in slSetConstants; its DLSS
// plugin gives NGX no camera. The core runs in the game's process, loaded by the game's own sl.dlss, so it captures
// the camera in the game's own Streamline interposer, which stays NVIDIA's signed file: in-memory detours on the
// interposer's slSetConstants and slEvaluateFeature exports. slSetConstants copies validated perspective constants
// for its frame token and viewport. slEvaluateFeature(kFeatureDLSS) selects the copy of its frame token and viewport
// as the camera of the evaluations on its thread, calls the original and restores the previous camera. Both always
// return the original result unchanged. Streamline's DLSS feature is 0; NGX numbers its features separately.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>

#include <cstring>

#include <MinHook.h>
#include <sl_core_api.h>

#include "ngx_camera.h"
#include "streamline_camera.hpp"
#include "common/lane.hpp"

static_assert(sizeof(void *) == 8, "the NGX core is x64");

namespace {
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
};
Slot slots[kSlots];
SRWLOCK install_lock = SRWLOCK_INIT;

ngx_streamline::CameraCache<128> cameras;
SRWLOCK camera_lock = SRWLOCK_INIT;

sl::Result Capture(SetConstants original, const sl::Constants &values, const sl::FrameToken &frame,
                   const sl::ViewportHandle &view) {
  const uint32_t frame_id = uint32_t(frame), view_id = uint32_t(view);
  RSTemporalCamera camera;
  const bool valid = ngx_streamline::camera(values, frame_id, view_id, camera);
  const sl::Result result = original(values, frame, view);
  AcquireSRWLockExclusive(&camera_lock);
  cameras.remember(frame_id, view_id, valid && result == sl::Result::eOk ? &camera : nullptr);
  ReleaseSRWLockExclusive(&camera_lock);
  return result;
}

sl::Result Select(EvaluateFeature original, sl::Feature feature, const sl::FrameToken &frame,
                  const sl::BaseStructure **inputs, uint32_t count, sl::CommandBuffer *commands) {
  if (feature != sl::kFeatureDLSS)
    return original(feature, frame, inputs, count, commands);
  uint32_t view_id = 0;
  RSTemporalCamera camera;
  bool valid = ngx_streamline::viewport(inputs, count, view_id);
  if (valid) {
    AcquireSRWLockShared(&camera_lock);
    valid = cameras.lookup(uint32_t(frame), view_id, camera);
    ReleaseSRWLockShared(&camera_lock);
  }
  // nested evaluations restore their caller's camera
  const RSTemporalCamera previous = ngx::ExchangeTemporalCamera(valid ? &camera : nullptr);
  const sl::Result result = original(feature, frame, inputs, count, commands);
  ngx::RestoreTemporalCamera(previous);
  return result;
}

template <unsigned N>
sl::Result SetConstantsHook(const sl::Constants &values, const sl::FrameToken &frame, const sl::ViewportHandle &view) {
  return Capture(slots[N].set, values, frame, view);
}
template <unsigned N>
sl::Result EvaluateFeatureHook(sl::Feature feature, const sl::FrameToken &frame, const sl::BaseStructure **inputs,
                               uint32_t count, sl::CommandBuffer *commands) {
  return Select(slots[N].evaluate, feature, frame, inputs, count, commands);
}
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
  AcquireSRWLockExclusive(&install_lock);
  // a new Streamline session starts with new frame tokens
  AcquireSRWLockExclusive(&camera_lock);
  cameras.clear();
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
    if (current)
      continue;
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
    if (Hook(n, module, set_target, evaluate_target))
      lane::log("info", "Streamline camera capture in %ls", name);
    else
      lane::log("err", "Streamline camera capture: could not hook %ls", name);
  }
  ReleaseSRWLockExclusive(&install_lock);
}
