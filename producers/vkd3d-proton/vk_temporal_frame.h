/*
 * One DLSS evaluation as the Vulkan driver receives it: VkTemporalFrameInfoMVK in the pNext chain of a
 * vkCmdPipelineBarrier2, recorded by VKD3D-Proton's ID3D12GraphicsCommandListMetalFX (metalfx.c) and by the NGX
 * core's D3D11 path. A driver that forwards it to MacLauncher's graphics pipeline names "temporal-sr" (Super
 * Resolution) or "temporal-rr" (Ray Reconstruction) in its driverInfo. The same layout as KosmicKrisp's
 * kk_temporal_frame_info (kk_temporal.h). Include vkd3d_metalfx.h first.
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 */

#ifndef __VK_TEMPORAL_FRAME_H
#define __VK_TEMPORAL_FRAME_H

#define VK_STRUCTURE_TYPE_TEMPORAL_FRAME_INFO_MVK ((VkStructureType)1000999101)

enum { TEMPORAL_SUPER_RESOLUTION = 1, TEMPORAL_RAY_RECONSTRUCTION = 2 };
enum { TEMPORAL_COLOR, TEMPORAL_DEPTH, TEMPORAL_MOTION, TEMPORAL_OUTPUT, TEMPORAL_EXPOSURE, TEMPORAL_DIFFUSE_ALBEDO,
        TEMPORAL_SPECULAR_ALBEDO, TEMPORAL_NORMALS, TEMPORAL_ROUGHNESS, TEMPORAL_SPECULAR_HIT_DISTANCE,
        TEMPORAL_HUDLESS, TEMPORAL_UI, TEMPORAL_IMAGES };
enum { TEMPORAL_AUTO_EXPOSURE = 0x1, TEMPORAL_RESET = 0x2, TEMPORAL_DEPTH_REVERSED = 0x4,
        TEMPORAL_MOTION_DISPLAY_RES = 0x8, TEMPORAL_MOTION_JITTERED = 0x10, TEMPORAL_HDR = 0x20,
        TEMPORAL_CAMERA_VALID = 0x40, TEMPORAL_DEPTH_INFINITE = 0x80,
        TEMPORAL_ROUGHNESS_NORMAL_ALPHA = 0x100 };

typedef struct VkTemporalFrameInfoMVK
{
    VkStructureType sType;
    const void *pNext;
    uint64_t featureId;
    uint64_t frameId;                  /* > 0, new for every evaluation of the feature */
    uint32_t featureType;
    uint32_t flags;
    VkImage images[TEMPORAL_IMAGES];
    VkFormat formats[TEMPORAL_IMAGES]; /* VK_FORMAT_UNDEFINED: the image's own */
    uint32_t colorX, colorY, depthX, depthY, motionX, motionY, outputX, outputY;
    uint32_t renderWidth, renderHeight, outputWidth, outputHeight; /* 0: the image's extent */
    float motionVectorScaleX;
    float motionVectorScaleY;
    float jitterOffsetX;
    float jitterOffsetY;
    float preExposure;
    float sharpness;
    float frameTimeMs;                 /* 0: unknown */
    float nearPlane, farPlane, verticalFov; /* with TEMPORAL_CAMERA_VALID; radians */
    float worldToViewMatrix[16];       /* row-major, of row vectors (D3D's) */
    float viewToClipMatrix[16];
    uint32_t releaseFeatureIdCount;
    const uint64_t *pReleaseFeatureIds;
} VkTemporalFrameInfoMVK;

#define VK_STRUCTURE_TYPE_TEMPORAL_FRAME_MASKS_INFO_MVK ((VkStructureType)1000999103) /* 1000999102 is KosmicKrisp's kk_temporal_frame_info version 2 */

/* In VkTemporalFrameInfoMVK's pNext chain: the frame's reactive mask (DLSS's bias-current-color mask, FSR's reactive
 * mask) and its transparency and composition mask. Each is read at its offset over the render extent;
 * VK_NULL_HANDLE means none, and VK_FORMAT_UNDEFINED the image's own format. */
typedef struct VkTemporalFrameMasksInfoMVK
{
    VkStructureType sType;
    const void *pNext;
    VkImage reactive;
    VkImage transparency;
    VkFormat reactiveFormat;
    VkFormat transparencyFormat;
    uint32_t reactiveX, reactiveY, transparencyX, transparencyY;
} VkTemporalFrameMasksInfoMVK;

/* An integer-typed image (typeless depth, exposure or motion vectors) is read as the float format of its bits;
 * VK_FORMAT_UNDEFINED keeps the image's own. */
static inline VkFormat vk_temporal_read_format(VkFormat format)
{
    switch (format)
    {
        case VK_FORMAT_R32_UINT: case VK_FORMAT_R32_SINT: return VK_FORMAT_R32_SFLOAT;
        case VK_FORMAT_R16_UINT: case VK_FORMAT_R16_SINT: return VK_FORMAT_R16_SFLOAT;
        case VK_FORMAT_R32G32_UINT: case VK_FORMAT_R32G32_SINT: return VK_FORMAT_R32G32_SFLOAT;
        case VK_FORMAT_R16G16_UINT: case VK_FORMAT_R16G16_SINT: return VK_FORMAT_R16G16_SFLOAT;
        default: return VK_FORMAT_UNDEFINED;
    }
}

/* A Super Resolution evaluation's values (vkd3d_metalfx.h); its images, identity and released ids are the caller's. */
static inline void vk_temporal_super_resolution(VkTemporalFrameInfoMVK *info, const VKD3D_METALFX_TEMPORAL_DESC *desc)
{
    info->sType = VK_STRUCTURE_TYPE_TEMPORAL_FRAME_INFO_MVK;
    info->featureType = TEMPORAL_SUPER_RESOLUTION;
    info->flags = (desc->AutoExposure ? TEMPORAL_AUTO_EXPOSURE : 0) | (desc->InReset ? TEMPORAL_RESET : 0)
            | (desc->DepthReversed ? TEMPORAL_DEPTH_REVERSED : 0)
            | (desc->MotionVectorInDisplayRes ? TEMPORAL_MOTION_DISPLAY_RES : 0)
            | (desc->MotionVectorJittered ? TEMPORAL_MOTION_JITTERED : 0) | (desc->Hdr ? TEMPORAL_HDR : 0)
            | (desc->CameraValid ? TEMPORAL_CAMERA_VALID | (desc->DepthInfinite ? TEMPORAL_DEPTH_INFINITE : 0) : 0);
    info->colorX = desc->ColorX;
    info->colorY = desc->ColorY;
    info->depthX = desc->DepthX;
    info->depthY = desc->DepthY;
    info->motionX = desc->MotionX;
    info->motionY = desc->MotionY;
    info->outputX = desc->OutputX;
    info->outputY = desc->OutputY;
    info->renderWidth = desc->InputContentWidth;
    info->renderHeight = desc->InputContentHeight;
    info->motionVectorScaleX = desc->MotionVectorScaleX;
    info->motionVectorScaleY = desc->MotionVectorScaleY;
    info->jitterOffsetX = desc->JitterOffsetX;
    info->jitterOffsetY = desc->JitterOffsetY;
    info->preExposure = desc->PreExposure;
    info->sharpness = desc->Sharpness;
    info->frameTimeMs = desc->FrameTimeMs;
    if (desc->CameraValid)
    {
        info->nearPlane = desc->NearPlane;
        info->farPlane = desc->FarPlane;
        info->verticalFov = desc->VerticalFov;
    }
}

#endif /* __VK_TEMPORAL_FRAME_H */
