// SPDX-License-Identifier: MIT
#pragma once
#include <stdint.h>
#include "../../../shared/reshade/temporal/camera.h"
typedef struct MLTemporalCameraCall {
    uint32_t size,version;
    RSTemporalCamera camera;
    int32_t accepted;
    uint32_t reserved;
} MLTemporalCameraCall;
