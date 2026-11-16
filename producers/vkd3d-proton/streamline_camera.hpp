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

// The camera that the perspective view-to-clip matrix alone defines. Unreal Engine's Streamline plugin declares its
// own r.Streamline.CustomCameraNearPlane/FarPlane values, which do not need to match its projection, so near and far
// come from the matrix's depth terms and the vertical field of view from its vertical scale. The depth row's x and y
// terms (a jitter or off-centre offset) move only x and y and are allowed. The depth terms define the direction: a
// declared direction must agree, and an undeclared one is the matrix's. A depth term at exactly the far depth is an
// infinite far plane: Unreal Engine's reversed-Z projection gives near = GNearClippingPlane and an infinite far plane.
enum class Projection { Valid, Structure, Orthographic, NotFinite, Shape, DepthDirection, Planes };
inline Projection projectionReason(const sl::Constants &value, uint32_t frame, uint32_t viewport, RSTemporalCamera &out) {
  out = {};
  if (value.structType != sl::Constants::s_structType || value.structVersion < 1)
    return Projection::Structure;
  if (value.orthographicProjection == sl::Boolean::eTrue)
    return Projection::Orthographic;
  const float *m = &value.cameraViewToClip.row[0].x;
  for (unsigned i = 0; i < 16; ++i)
    if (!std::isfinite(m[i]) || m[i] == FLT_MAX)
      return Projection::NotFinite;
  const float w = m[11], scale = std::abs(w);
  if (scale < 1e-8f || std::abs(m[0]) < 1e-8f || std::abs(m[5]) < 1e-8f)
    return Projection::Shape;
  for (unsigned i : {1u, 2u, 3u, 4u, 6u, 7u, 12u, 13u, 15u})
    if (std::abs(m[i]) > scale * 1e-5f)
      return Projection::Shape;
  // NDC depth at view distance d is a + b / d; reversed depth falls with distance (b > 0)
  const double a = double(m[10]) / w, b = double(m[14]) / scale;
  const bool reversed = b > 0;
  if (reversed ? !(a <= 0) : !(b < 0 && a >= 1))
    return Projection::DepthDirection;
  if ((value.depthInverted == sl::Boolean::eTrue && !reversed) || (value.depthInverted == sl::Boolean::eFalse && reversed))
    return Projection::DepthDirection;
  const double farDepth = reversed ? 0 : 1;
  const bool infinite = std::abs(a - farDepth) <= 1e-7;
  const double nearPlane = reversed ? b / (1 - a) : -b / a, farPlane = infinite ? 0 : reversed ? -b / a : b / (1 - a);
  const double fov = 2 * std::atan(double(scale) / std::abs(double(m[5])));
  if (!std::isfinite(nearPlane) || !(nearPlane > 0) || nearPlane >= FLT_MAX || !(fov > 0) || !(fov < 3.141592653589793) ||
      (!infinite && (!std::isfinite(farPlane) || !(farPlane > nearPlane) || farPlane >= FLT_MAX)))
    return Projection::Planes;
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
  if (!(out.farPlane > out.nearPlane) && !infinite) {
    out = {};
    return Projection::Planes;
  }
  return Projection::Valid;
}
inline bool projectionCamera(const sl::Constants &value, uint32_t frame, uint32_t viewport, RSTemporalCamera &out) {
  return projectionReason(value, frame, viewport, out) == Projection::Valid;
}

// The camera of a Super Resolution evaluation that a game makes through NGX itself, outside Streamline's
// slEvaluateFeature, while it sets Streamline constants of each frame (Unreal Engine's DLSS plugin beside its
// Streamline plugin). Neither call names the other's frame; the jitter offset does, because a temporal upscaler's
// jitter changes every frame. The two plugins' sign conventions may differ, so an offset matches when it is equal or
// negated on both axes; the first exact binding fixes the game's convention, since a nonzero offset is never both.
// take(), at an evaluation: the constants set before it, when exactly one frame and viewport set constants since
// the previous evaluation, their offset is the evaluation's and not the previous evaluation's.
// follow(), at the constants: the evaluation they follow (Unreal Engine sets them after its DLSS pass), when they are
// the first constants since the latest evaluation, their offset is that evaluation's and not the one before it.
// Constants are never given to another frame's evaluation, and an offset that matches both evaluations leaves the
// frame without a camera.
class DirectCameras {
  struct Constants {
    uint32_t frame = 0, viewport = 0;
    bool valid = false;
    float jitter[2]{};
    RSTemporalCamera camera{};
  };
  enum Convention { Unknown, Equal, Negated };
  Constants pending_{};
  unsigned count_ = 0;
  bool several_ = false, evaluated_ = false, before_valid_ = false;
  float previous_[2]{}, before_[2]{};
  uint64_t evaluations_ = 0;
  Convention convention_ = Unknown;
  bool same(const float *constants, float x, float y) const {
    const bool equal = constants[0] == x && constants[1] == y, negated = constants[0] == -x && constants[1] == -y;
    return convention_ == Equal ? equal : convention_ == Negated ? negated : equal || negated;
  }
  void learn(const float *constants, float x, float y) {
    if (convention_ == Unknown)
      convention_ = constants[0] == x && constants[1] == y ? Equal : Negated;
  }
  static bool jittered(float x, float y) { return std::isfinite(x) && std::isfinite(y) && (x != 0 || y != 0); }

public:
  enum Result { Bound, NoConstants, SeveralFrames, Unjittered, InvalidCamera, ConstantsFollow, OtherFrame, AmbiguousJitter,
                FirstEvaluation };
  enum Follow { Followed, NoEvaluation, SeveralConstants, FollowUnjittered, FollowInvalidCamera, FollowOtherFrame,
                FollowAmbiguous };
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
    before_valid_ = evaluated_;
    before_[0] = previous_[0];
    before_[1] = previous_[1];
    evaluated_ = true;
    ++evaluations_;
    previous_[0] = jitterX;
    previous_[1] = jitterY;
    if (!count)
      return NoConstants;
    if (several)
      return SeveralFrames;
    if (!jittered(jitterX, jitterY))
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
    learn(pending.jitter, jitterX, jitterY);
    out = pending.camera;
    return Bound;
  }
  // Call after remember() for the same constants. evaluation is the 1-based number of the evaluation they follow and
  // jitter that evaluation's own offset.
  Follow follow(uint64_t &evaluation, float (&jitter_out)[2], RSTemporalCamera &out) {
    out = {};
    evaluation = 0;
    jitter_out[0] = jitter_out[1] = 0;
    if (!evaluated_)
      return NoEvaluation;
    if (count_ != 1)
      return SeveralConstants;
    const float *jitter = pending_.jitter;
    if (!jittered(jitter[0], jitter[1]) || !jittered(previous_[0], previous_[1]))
      return FollowUnjittered;
    const bool current = same(jitter, previous_[0], previous_[1]),
               earlier = before_valid_ && same(jitter, before_[0], before_[1]);
    if (current && earlier)
      return FollowAmbiguous;
    if (!current)
      return FollowOtherFrame;
    if (!pending_.valid)
      return FollowInvalidCamera;
    learn(jitter, previous_[0], previous_[1]);
    evaluation = evaluations_;
    jitter_out[0] = previous_[0];
    jitter_out[1] = previous_[1];
    out = pending_.camera;
    return Followed;
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
