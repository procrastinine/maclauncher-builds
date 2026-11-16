// SPDX-License-Identifier: MIT
// The camera of a game's Streamline constants, as MacLauncher's graphics pipeline takes it.
#pragma once
#include <cfloat>
#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <cstring>
#include <utility>
#include <sl_core_types.h>
#include "ngx_camera.h"

namespace ngx_streamline {
struct SceneMatrices {
  float worldToView[16]{}, viewToClip[16]{};
};
inline bool invert(const float *source, float *target) {
  double rows[4][8]{};
  for(unsigned r=0;r<4;++r)for(unsigned c=0;c<4;++c){const float value=source[r*4+c];if(!std::isfinite(value)||value==FLT_MAX)return false;rows[r][c]=value;rows[r][4+c]=r==c;}
  for(unsigned c=0;c<4;++c){unsigned pivot=c;for(unsigned r=c+1;r<4;++r)if(std::abs(rows[r][c])>std::abs(rows[pivot][c]))pivot=r;if(std::abs(rows[pivot][c])<1e-12)return false;for(unsigned i=0;i<8;++i)std::swap(rows[c][i],rows[pivot][i]);const double scale=rows[c][c];for(double &value:rows[c])value/=scale;for(unsigned r=0;r<4;++r)if(r!=c){const double scale=rows[r][c];for(unsigned i=0;i<8;++i)rows[r][i]-=scale*rows[c][i];}}
  for(unsigned r=0;r<4;++r)for(unsigned c=0;c<4;++c){target[r*4+c]=float(rows[r][4+c]);if(!std::isfinite(target[r*4+c]))return false;}return true;
}
// The SDK's row-vector camera-to-world basis (sl_matrix_helpers.h) supplies
// the view transform. Copy the full unjittered projection exactly, including
// valid shifted/orthographic projections that the scalar adapter declines.
inline bool matrices(const sl::Constants &value, SceneMatrices &out) {
  out={};if(value.structType!=sl::Constants::s_structType||value.structVersion<1||value.structVersion>2)return false;
  const sl::float3 basis[]={value.cameraRight,value.cameraUp,value.cameraFwd};
  for(unsigned i=0;i<3;++i){const float *a=&basis[i].x;double norm=0;for(unsigned c=0;c<3;++c){if(!std::isfinite(a[c])||a[c]==FLT_MAX)return false;norm+=double(a[c])*a[c];}if(std::abs(norm-1)>1e-3)return false;for(unsigned j=0;j<i;++j){const float*b=&basis[j].x;double dot=0;for(unsigned c=0;c<3;++c)dot+=double(a[c])*b[c];if(std::abs(dot)>1e-3)return false;}}
  const float *position=&value.cameraPos.x;for(unsigned c=0;c<3;++c)if(!std::isfinite(position[c])||position[c]==FLT_MAX)return false;
  float cameraToWorld[16]={basis[0].x,basis[0].y,basis[0].z,0,basis[1].x,basis[1].y,basis[1].z,0,basis[2].x,basis[2].y,basis[2].z,0,position[0],position[1],position[2],1},unused[16];
  SceneMatrices next;if(!invert(cameraToWorld,next.worldToView)||!invert(&value.cameraViewToClip.row[0].x,unused))return false;
  std::memcpy(next.viewToClip,&value.cameraViewToClip.row[0].x,sizeof(next.viewToClip));out=next;return true;
}
// Streamline's public matrices are unjittered, row-major view-to-clip matrices. Only perspective projections that the
// near and far distances and vertical field of view describe are accepted: orthographic, oblique and shifted
// projections are not, and an unspecified far plane only with an infinite perspective plane.
inline bool camera(const sl::Constants &value, uint32_t frame, uint32_t viewport, RSTemporalCamera &out) {
  out = {};
  if (value.structType != sl::Constants::s_structType || value.structVersion < 1 || value.structVersion > 2 ||
      value.orthographicProjection != sl::Boolean::eFalse ||
      (value.depthInverted != sl::Boolean::eTrue && value.depthInverted != sl::Boolean::eFalse) ||
      !std::isfinite(value.cameraNear) || value.cameraNear <= 0 || value.cameraNear == FLT_MAX ||
      !std::isfinite(value.cameraFOV) || value.cameraFOV <= 0 || value.cameraFOV >= 3.141592653589793f)
    return false;
  const float *m = &value.cameraViewToClip.row[0].x;
  for (unsigned i = 0; i < 16; ++i)
    if (!std::isfinite(m[i]) || m[i] == FLT_MAX)
      return false;
  const float w = m[11], scale = std::abs(w);
  if (scale < 1e-8f || std::abs(m[0]) < 1e-8f || std::abs(m[5]) < 1e-8f)
    return false;
  for (unsigned i : {1u, 2u, 3u, 4u, 6u, 7u, 8u, 9u, 12u, 13u, 15u})
    if (std::abs(m[i]) > scale * 1e-5f)
      return false;
  const bool reversed = value.depthInverted == sl::Boolean::eTrue;
  const float nearDepth = reversed ? 1.f : 0.f, farDepth = reversed ? 0.f : 1.f;
  const double a = m[10] / w, b = m[14] / scale;
  if (std::abs(a + b / value.cameraNear - nearDepth) > 5e-4 ||
      std::abs(2 * std::atan(scale / std::abs(m[5])) - value.cameraFOV) > .005)
    return false;
  bool infinite = false;
  if (std::isfinite(value.cameraFar) && value.cameraFar > value.cameraNear && value.cameraFar < FLT_MAX) {
    if (std::abs(a + b / value.cameraFar - farDepth) > 5e-4)
      return false;
  } else {
    // FLT_MAX is also Streamline's unspecified sentinel.
    if (!(value.cameraFar == FLT_MAX || (std::isinf(value.cameraFar) && value.cameraFar > 0)) ||
        std::abs(a - farDepth) > 1e-7)
      return false;
    infinite = true;
  }
  out.size = sizeof(out);
  out.version = 1;
  out.frameId = uint64_t(frame) + 1;
  out.viewportId = viewport;
  out.nearPlane = value.cameraNear;
  out.farPlane = infinite ? 0.f : value.cameraFar;
  out.verticalFov = value.cameraFOV;
  out.flags = (reversed ? RS_TEMPORAL_DEPTH_REVERSED : 0) | (infinite ? RS_TEMPORAL_DEPTH_INFINITE : 0) |
              (value.reset == sl::Boolean::eTrue ? RS_TEMPORAL_RESET : 0) |
              (value.motionVectorsJittered == sl::Boolean::eTrue ? RS_TEMPORAL_JITTERED_MOTION : 0);
  return true;
}

// The camera that the unjittered perspective view-to-clip matrix alone defines. Unreal Engine's Streamline plugin
// declares its own r.Streamline.CustomCameraNearPlane/FarPlane values, which do not need to match its projection, so
// near and far come from the matrix's depth terms and the vertical field of view from its vertical scale. The matrix's
// depth direction must be the declared one. A depth term at exactly the far depth is an infinite far plane: Unreal
// Engine's reversed-Z projection gives near = GNearClippingPlane and an infinite far plane.
inline bool projectionCamera(const sl::Constants &value, uint32_t frame, uint32_t viewport, RSTemporalCamera &out) {
  out = {};
  if (value.structType != sl::Constants::s_structType || value.structVersion < 1 || value.structVersion > 2 ||
      value.orthographicProjection != sl::Boolean::eFalse ||
      (value.depthInverted != sl::Boolean::eTrue && value.depthInverted != sl::Boolean::eFalse))
    return false;
  const float *m = &value.cameraViewToClip.row[0].x;
  for (unsigned i = 0; i < 16; ++i)
    if (!std::isfinite(m[i]) || m[i] == FLT_MAX)
      return false;
  const float w = m[11], scale = std::abs(w);
  if (scale < 1e-8f || std::abs(m[0]) < 1e-8f || std::abs(m[5]) < 1e-8f)
    return false;
  for (unsigned i : {1u, 2u, 3u, 4u, 6u, 7u, 8u, 9u, 12u, 13u, 15u})
    if (std::abs(m[i]) > scale * 1e-5f)
      return false;
  // NDC depth at view distance d is a + b / d
  const bool reversed = value.depthInverted == sl::Boolean::eTrue;
  const double a = double(m[10]) / w, b = double(m[14]) / scale, farDepth = reversed ? 0 : 1;
  if (reversed ? !(b > 0 && a <= 0) : !(b < 0 && a >= 1))
    return false;
  const bool infinite = std::abs(a - farDepth) <= 1e-7;
  const double nearPlane = reversed ? b / (1 - a) : -b / a, farPlane = infinite ? 0 : reversed ? -b / a : b / (1 - a);
  const double fov = 2 * std::atan(double(scale) / std::abs(double(m[5])));
  if (!std::isfinite(nearPlane) || !(nearPlane > 0) || nearPlane >= FLT_MAX || !(fov > 0) || !(fov < 3.141592653589793) ||
      (!infinite && (!std::isfinite(farPlane) || !(farPlane > nearPlane) || farPlane >= FLT_MAX)))
    return false;
  out.size = sizeof(out);
  out.version = 1;
  out.frameId = uint64_t(frame) + 1;
  out.viewportId = viewport;
  out.nearPlane = float(nearPlane);
  out.farPlane = float(farPlane);
  out.verticalFov = float(fov);
  out.flags = (reversed ? RS_TEMPORAL_DEPTH_REVERSED : 0) | (infinite ? RS_TEMPORAL_DEPTH_INFINITE : 0) |
              (value.reset == sl::Boolean::eTrue ? RS_TEMPORAL_RESET : 0) |
              (value.motionVectorsJittered == sl::Boolean::eTrue ? RS_TEMPORAL_JITTERED_MOTION : 0);
  if (!(out.farPlane > out.nearPlane) && !infinite)
    out = {};
  return out.size != 0;
}

// The camera of a Super Resolution evaluation that a game makes through NGX itself, outside Streamline's
// slEvaluateFeature, while it sets Streamline constants of each frame (Unreal Engine's DLSS plugin beside its
// Streamline plugin). Neither call names the other's frame. An evaluation takes the constants of the same frame
// only when exactly one frame and viewport set constants since the previous such evaluation, so the constants are
// this frame's or the previous frame's, and their jitter offset is the evaluation's (equal, or negated on both axes,
// as the two plugins' conventions may differ) and not the previous evaluation's in either convention. A temporal
// upscaler's jitter changes every frame, so that is the same frame. Constants that come after their frame's
// evaluation are never given to the next one, and two consecutive jitter offsets that are each other's negation
// leave that evaluation without a camera.
class DirectCameras {
  struct Constants {
    uint32_t frame = 0, viewport = 0;
    bool valid = false;
    float jitter[2]{};
    RSTemporalCamera camera{};
  };
  Constants pending_{};
  unsigned count_ = 0;
  bool several_ = false, evaluated_ = false;
  float previous_[2]{};
  static bool same(const float *constants, float x, float y) {
    return (constants[0] == x && constants[1] == y) || (constants[0] == -x && constants[1] == -y);
  }

public:
  enum Result { Bound, NoConstants, SeveralFrames, Unjittered, InvalidCamera, ConstantsFollow, OtherFrame, AmbiguousJitter,
                FirstEvaluation };
  void remember(uint32_t frame, uint32_t viewport, float jitterX, float jitterY, const RSTemporalCamera *camera) {
    if (count_ && (pending_.frame != frame || pending_.viewport != viewport))
      several_ = true;
    pending_ = {frame, viewport, camera != nullptr, {jitterX, jitterY}, camera ? *camera : RSTemporalCamera{}};
    if (count_ < 2)
      ++count_;
  }
  Result take(float jitterX, float jitterY, RSTemporalCamera &out) {
    out = {};
    const Constants pending = pending_;
    const unsigned count = count_;
    const bool several = several_, evaluated = evaluated_;
    const float previous[2] = {previous_[0], previous_[1]};
    pending_ = {};
    count_ = 0;
    several_ = false;
    evaluated_ = true;
    previous_[0] = jitterX;
    previous_[1] = jitterY;
    if (!count)
      return NoConstants;
    if (several)
      return SeveralFrames;
    if (!std::isfinite(jitterX) || !std::isfinite(jitterY) || (jitterX == 0 && jitterY == 0))
      return Unjittered;
    if (!evaluated)
      return FirstEvaluation;
    const bool current = same(pending.jitter, jitterX, jitterY), earlier = same(pending.jitter, previous[0], previous[1]);
    if (current && earlier)
      return AmbiguousJitter;
    if (earlier)
      return ConstantsFollow;
    if (!current)
      return OtherFrame;
    if (!pending.valid)
      return InvalidCamera;
    out = pending.camera;
    return Bound;
  }
  void clear() { *this = DirectCameras{}; }
};

// The viewport an evaluation names: exactly one ViewportHandle, possibly repeated, in its inputs and their chains.
inline bool viewport(const sl::BaseStructure **inputs, uint32_t count, uint32_t &id) {
  if (!inputs || count > 256)
    return false;
  bool found = false;
  for (uint32_t i = 0; i < count; ++i) {
    auto item = inputs[i];
    unsigned links = 0;
    while (item && links++ < 32) {
      if (item->structType == sl::ViewportHandle::s_structType) {
        if (item->structVersion != 1)
          return false;
        const auto next = uint32_t(*static_cast<const sl::ViewportHandle *>(item));
        if (found && next != id)
          return false;
        found = true;
        id = next;
      }
      item = item->next;
    }
    if (item)
      return false;
  }
  return found;
}

// The cameras of recent frames and viewports, replaced oldest first.
template <unsigned N, class Value = RSTemporalCamera> class CameraCache {
  struct Entry {
    uint64_t age = 0;
    uint32_t frame = 0, viewport = 0;
    bool valid = false;
    Value value{};
  };
  Entry entries[N];
  uint64_t age = 0;

public:
  void remember(uint32_t frame, uint32_t viewport, const Value *value) {
    Entry *target = &entries[0];
    for (auto &entry : entries) {
      if (entry.age && entry.frame == frame && entry.viewport == viewport) {
        target = &entry;
        break;
      }
      if (entry.age < target->age)
        target = &entry;
    }
    *target = {++age, frame, viewport, value != nullptr, value ? *value : Value{}};
  }
  bool lookup(uint32_t frame, uint32_t viewport, Value &value) const {
    for (const auto &entry : entries)
      if (entry.age && entry.frame == frame && entry.viewport == viewport) {
        if (entry.valid)
          value = entry.value;
        return entry.valid;
      }
    return false;
  }
  void clear() {
    for (auto &entry : entries)
      entry = {};
    age = 0;
  }
};
} // namespace ngx_streamline
