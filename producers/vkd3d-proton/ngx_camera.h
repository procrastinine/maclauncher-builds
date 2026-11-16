// SPDX-License-Identifier: MIT
// The NGX core's evaluation camera: the 64-byte RSTemporalCamera of MacLauncher's graphics pipeline
// (graphics frame.h and camera.h), and the core's functions that set and restore it on the calling thread.
#pragma once
#include <cstdint>

struct RSTemporalCamera {
  uint32_t size, version, flags, reserved;
  uint64_t frameId, viewportId;
  float nearPlane, farPlane, verticalFov, frameTimeMs; // positive view distances; radians
  uint32_t reserved2[4];
};
static_assert(sizeof(RSTemporalCamera) == 64, "RSTemporalCamera is 64 bytes");

enum : uint32_t {
  RS_TEMPORAL_RESET = 1,
  RS_TEMPORAL_DEPTH_REVERSED = 2,
  RS_TEMPORAL_DEPTH_INFINITE = 4,
  RS_TEMPORAL_JITTERED_MOTION = 32,
  RS_TEMPORAL_CAMERA_FLAGS = 0x6f,
};

struct ID3D12GraphicsCommandList;
struct ID3D12MetalFXScaler;

namespace ngx {
// Sets the camera of the next evaluations on this thread (none when invalid or null) and returns the previous one.
RSTemporalCamera ExchangeTemporalCamera(const RSTemporalCamera *camera);
void RestoreTemporalCamera(const RSTemporalCamera &camera);
// Installs the camera capture in the process's Streamline interposer, once per loaded interposer.
void HookStreamline();
// The camera of a Super Resolution evaluation that the game makes through NGX itself, outside Streamline's
// slEvaluateFeature: that of the same frame's Streamline constants (ngx_streamline.cpp), or false.
bool DirectEvaluationCamera(float jitterX, float jitterY, RSTemporalCamera &camera) noexcept;
// After a direct evaluation's TemporalUpscale on list: remembers the frame id that VKD3D-Proton gave it, which the
// HUD-less and UI images tagged after it name in their late scene. ForgetEvaluationFrames before a scaler's Destroy.
void DirectEvaluationFrame(ID3D12GraphicsCommandList *list, ID3D12MetalFXScaler *scaler) noexcept;
void ForgetEvaluationFrames(ID3D12MetalFXScaler *scaler) noexcept;
} // namespace ngx
