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
