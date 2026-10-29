#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <stdint.h>
// Additive render get_info parameter supplied by the owned mpv overlay. Stock
// libmpv returns NOT_IMPLEMENTED; that path explicitly supplies no media PTS.
#define ML_MPV_RENDER_PARAM_FRAME_METADATA 0x4d4c0001
enum MLMpvFrameFlags {ML_MPV_FRAME_PRESENT=1,ML_MPV_FRAME_REDRAW=2,ML_MPV_FRAME_REPEAT=4,ML_MPV_FRAME_PTS_UNKNOWN=8};
struct MLMpvFrameMetadata {
    uint32_t size,version,flags,reserved;
    uint64_t contentId;
    uint32_t width,height;
    double pts,duration;
};
