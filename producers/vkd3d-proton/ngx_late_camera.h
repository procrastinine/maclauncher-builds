// SPDX-License-Identifier: MIT
// The camera that a game sets after its frame's direct NGX evaluation, for that frame's frame generation in
// MacLauncher's graphics pipeline (its native late-camera.hpp reads the same layout). Unreal Engine's Streamline plugin
// sets each frame's constants after its own DLSS pass, so the evaluation itself carries no camera. The NGX core
// publishes the matched camera with the evaluation's exact jitter offset in effect-plan.temporal-camera, a 4096-byte
// file that the core creates and clears beside effect-plan.json at its first direct evaluation; both sides map it once. Each slot is sequence-locked: odd
// while written, the next even value when complete. One writer: callers serialize publish(). The process maps the
// file with ngx_late_camera_file.h.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include "ngx_camera.h"

namespace ngx_late_camera {
constexpr uint32_t magic = 0x4d43544cu, version = 1, slots = 4, fileSize = 4096;
struct Slot {
  uint64_t sequence, publication; // publication: 1-based; the slot is (publication - 1) % slots
  float jitterX, jitterY;         // the evaluation's own jitter offset
  uint64_t evaluation;            // the core's number of the evaluation the camera follows
  RSTemporalCamera camera;
};
struct Mailbox {
  uint32_t magic, version, slotCount, reserved;
  uint64_t published;
  Slot slot[slots];
};
static_assert(sizeof(Slot) == 96 && offsetof(Slot, publication) == 8 && offsetof(Slot, jitterX) == 16 &&
              offsetof(Slot, evaluation) == 24 && offsetof(Slot, camera) == 32, "late camera slot layout");
static_assert(sizeof(Mailbox) == 408 && offsetof(Mailbox, published) == 16 && offsetof(Mailbox, slot) == 24 &&
              sizeof(Mailbox) <= fileSize, "late camera layout");

inline void publish(Mailbox &m, float jitterX, float jitterY, uint64_t evaluation, const RSTemporalCamera &camera) {
  const uint64_t publication = __atomic_load_n(&m.published, __ATOMIC_RELAXED) + 1;
  Slot &slot = m.slot[(publication - 1) % slots];
  const uint64_t sequence = __atomic_load_n(&slot.sequence, __ATOMIC_RELAXED) & ~uint64_t(1);
  __atomic_store_n(&slot.sequence, sequence + 1, __ATOMIC_RELAXED);
  __atomic_thread_fence(__ATOMIC_RELEASE);
  slot.publication = publication;
  slot.jitterX = jitterX;
  slot.jitterY = jitterY;
  slot.evaluation = evaluation;
  std::memcpy(&slot.camera, &camera, sizeof(camera));
  __atomic_store_n(&slot.sequence, sequence + 2, __ATOMIC_RELEASE);
  __atomic_store_n(&m.published, publication, __ATOMIC_RELEASE);
  if (__atomic_load_n(&m.magic, __ATOMIC_RELAXED) != magic) {
    m.version = version;
    m.slotCount = slots;
    __atomic_store_n(&m.magic, magic, __ATOMIC_RELEASE);
  }
}

} // namespace ngx_late_camera
