// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';
import {edit} from '../macos-aborts/apply.mjs';
export function applyNgs2Overlay(root) {
  const relative = 'core/libs/prx/libSceNgs2.native/src/Geom.cpp';
  fs.copyFileSync(path.join(import.meta.dirname, 'DarwinGeometry.inc'), path.join(root, 'core/libs/prx/libSceNgs2.native/src/DarwinGeometry.inc'));
  edit(root, relative, [
    ['#include "Ngs2Internal.hpp"', '#include "Ngs2Internal.hpp"\n#ifdef __APPLE__\n#include <iterator>\n#include <numbers>\n#include "DarwinGeometry.inc"\n#endif'],
    [`int Ngs2GeomApply(const Ngs2GeomListenerWork* listener, const Ngs2GeomSourceParam* source, Ngs2GeomAttribute* out_attrib, std::uint32_t flags) {
    if (listener == nullptr || source == nullptr) APS5_INVALID_ARG_EX;
    if (out_attrib == nullptr) return SCE_NGS2_ERROR_INVALID_OUT_ADDRESS;
    (void)flags;
    std::memset(out_attrib, 0, sizeof(*out_attrib));
    out_attrib->pitch_ratio = 1.0f;
    out_attrib->a3d_attrib.position = source->position;
    out_attrib->a3d_attrib.volume = std::max(source->min_level, source->max_level);
    const std::uint32_t channels = std::min(source->matrix_format == 0u ? 2u : source->matrix_format, 8u);
    const float level = source->max_level > 0.0f ? source->max_level : 1.0f;
    for (std::uint32_t channel = 0; channel < channels; channel++) {
        out_attrib->level[static_cast<std::size_t>(channel) * 8 + channel] = level;
    }
    return SCE_NGS2_OK;
}`, `#ifdef __APPLE__
int Ngs2GeomApply(const Ngs2GeomListenerWork* listener, const Ngs2GeomSourceParam* source, Ngs2GeomAttribute* out_attrib, std::uint32_t flags) {
    constexpr std::uint32_t known = APPLY_SOURCE_ANGLE | APPLY_SOURCE_DOPPLER | APPLY_VOLUME_MATRIX | APPLY_A3D_ATTRIBUTE | APPLY_A3D_AMBISONICS;
    if (listener == nullptr || source == nullptr || (flags & ~known) != 0 || !(listener->sound_speed > 0.0f)) APS5_INVALID_ARG_EX;
    if (out_attrib == nullptr) return SCE_NGS2_ERROR_INVALID_OUT_ADDRESS;
    ValidateSource(*source);
    if ((flags & APPLY_A3D_AMBISONICS) != 0) return SCE_NGS2_ERROR_INVALID_GEOM_FLAG;
    const Vec position = Transform(*listener, Of(source->position));
    const float distance = Length(position);
    const float attenuation = Rolloff(source->rolloff, distance) * ConeLevel(source->cone, Rotate(*listener, Of(source->direction)), Scale(position, -1.0f));
    const float level = std::clamp(attenuation, source->min_level, source->max_level);
    if ((flags & APPLY_SOURCE_DOPPLER) != 0) out_attrib->pitch_ratio = DopplerRatio(*listener, *source, position);
    if ((flags & APPLY_VOLUME_MATRIX) != 0) {
        Ngs2PanWork work{};
        Ngs2PanInit(&work, nullptr, 360.0f, source->num_speakers);
        float angle = 0.0f;
        if ((flags & APPLY_SOURCE_ANGLE) != 0 && distance > 0.0f) {
            angle = std::atan2(position.x, position.z) * 180.0f / std::numbers::pi_v<float>;
            if (angle < 0.0f) angle += 360.0f;
            if (angle >= 360.0f) angle -= 360.0f;
        }
        float focus = 1.0f;
        if (source->radius > 0.0f && distance < source->radius) focus = distance / source->radius;
        else if (distance == 0.0f) focus = 0.0f;
        const Ngs2PanParam pan{angle, focus, source->fbw_level * level, source->lfe_level * level};
        std::fill(std::begin(out_attrib->level), std::end(out_attrib->level), 0.0f);
        Ngs2PanGetVolumeMatrix(&work, &pan, 1, source->matrix_format, out_attrib->level);
    }
    if ((flags & APPLY_A3D_ATTRIBUTE) != 0) {
        out_attrib->a3d_attrib.position = {position.x, position.y, position.z};
        out_attrib->a3d_attrib.volume = level;
    }
    return SCE_NGS2_OK;
}
#else
int Ngs2GeomApply(const Ngs2GeomListenerWork* listener, const Ngs2GeomSourceParam* source, Ngs2GeomAttribute* out_attrib, std::uint32_t flags) {
    if (listener == nullptr || source == nullptr) APS5_INVALID_ARG_EX;
    if (out_attrib == nullptr) return SCE_NGS2_ERROR_INVALID_OUT_ADDRESS;
    (void)flags;
    std::memset(out_attrib, 0, sizeof(*out_attrib));
    out_attrib->pitch_ratio = 1.0f;
    out_attrib->a3d_attrib.position = source->position;
    out_attrib->a3d_attrib.volume = std::max(source->min_level, source->max_level);
    const std::uint32_t channels = std::min(source->matrix_format == 0u ? 2u : source->matrix_format, 8u);
    const float level = source->max_level > 0.0f ? source->max_level : 1.0f;
    for (std::uint32_t channel = 0; channel < channels; channel++) {
        out_attrib->level[static_cast<std::size_t>(channel) * 8 + channel] = level;
    }
    return SCE_NGS2_OK;
}
#endif`]
  ]);
  return [relative, 'core/libs/prx/libSceNgs2.native/src/DarwinGeometry.inc'];
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * spatial geometry, attenuation and Doppler handling:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/3be3db502258db1c28850a192b51b28ecd9d8a1b
 */
