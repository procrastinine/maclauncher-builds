/*
 * ID3D12GraphicsCommandListMetalFX (vkd3d_metalfx.h) on VKD3D-Proton command lists. The NGX core of
 * VKD3D-Proton-MacOS (ngx/nvngx, from Mullion) records DLSS Super Resolution and Ray Reconstruction through it.
 * Each evaluation is one VkTemporalFrameInfoMVK in the pNext chain of a vkCmdPipelineBarrier2: the frame's
 * images and values. Wine's 64-bit Vulkan thunk hands that chain to the driver unchanged, and KosmicKrisp
 * forwards the frame in command order to MacLauncher's graphics pipeline, which runs the selected upscaler.
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301, USA
 */

#define VKD3D_DBG_CHANNEL VKD3D_DBG_CHANNEL_API

#include "vkd3d_private.h"
#include "vkd3d_metalfx.h"
#include "vk_temporal_frame.h"

void d3d12_command_list_metalfx_record(struct d3d12_command_list *list, const void *scale,
        struct d3d12_resource **resources, unsigned int count);
extern HRESULT STDMETHODCALLTYPE d3d12_command_list_QueryInterface(d3d12_command_list_iface *iface,
        REFIID iid, void **object);
extern ULONG STDMETHODCALLTYPE d3d12_command_list_AddRef(d3d12_command_list_iface *iface);
extern ULONG STDMETHODCALLTYPE d3d12_command_list_Release(d3d12_command_list_iface *iface);

/* A feature's temporal history is the driver's, under an id of ours. Destroy() can come after the device is gone,
 * so the ids it releases wait here for the next frame, of any device, to pass them on. */
struct vkd3d_metalfx_scaler
{
    ID3D12MetalFXScaler ID3D12MetalFXScaler_iface;
    uint64_t id;
    uint64_t frames;
};

static spinlock_t vkd3d_metalfx_lock;
static uint64_t vkd3d_metalfx_released[64];
static uint32_t vkd3d_metalfx_released_count;
static uint64_t vkd3d_metalfx_next_id;

static void STDMETHODCALLTYPE vkd3d_metalfx_scaler_Destroy(ID3D12MetalFXScaler *iface)
{
    struct vkd3d_metalfx_scaler *scaler = CONTAINING_RECORD(iface, struct vkd3d_metalfx_scaler, ID3D12MetalFXScaler_iface);

    spinlock_acquire(&vkd3d_metalfx_lock);
    if (vkd3d_metalfx_released_count < ARRAY_SIZE(vkd3d_metalfx_released))
        vkd3d_metalfx_released[vkd3d_metalfx_released_count++] = scaler->id;
    spinlock_release(&vkd3d_metalfx_lock);
    vkd3d_free(scaler);
}

static const ID3D12MetalFXScalerVtbl vkd3d_metalfx_scaler_vtbl =
{
    vkd3d_metalfx_scaler_Destroy,
};

/* The feature's history, made at its first frame; NULL for another implementation's or without memory. */
static struct vkd3d_metalfx_scaler *vkd3d_metalfx_scaler(ID3D12MetalFXScaler **iface)
{
    struct vkd3d_metalfx_scaler *scaler;

    if (*iface)
        return (*iface)->lpVtbl == &vkd3d_metalfx_scaler_vtbl
                ? CONTAINING_RECORD(*iface, struct vkd3d_metalfx_scaler, ID3D12MetalFXScaler_iface) : NULL;
    if (!(scaler = vkd3d_malloc(sizeof(*scaler))))
        return NULL;
    scaler->ID3D12MetalFXScaler_iface.lpVtbl = &vkd3d_metalfx_scaler_vtbl;
    scaler->frames = 0;
    spinlock_acquire(&vkd3d_metalfx_lock);
    scaler->id = ++vkd3d_metalfx_next_id;
    spinlock_release(&vkd3d_metalfx_lock);
    *iface = &scaler->ID3D12MetalFXScaler_iface;
    return scaler;
}

/* Whether the driver's driverInfo names the word. */
static bool vkd3d_metalfx_driver_has(const struct d3d12_device *device, const char *word)
{
    const char *info = device->device_info.vulkan_1_2_properties.driverInfo, *found;
    size_t length = strlen(word);

    for (found = strstr(info, word); found; found = strstr(found + 1, word))
    {
        if ((found == info || found[-1] == ' ') && (!found[length] || found[length] == ' '))
            return true;
    }
    return false;
}

static inline struct d3d12_command_list *impl_from_ID3D12GraphicsCommandListMetalFX(
        ID3D12GraphicsCommandListMetalFX *iface)
{
    return CONTAINING_RECORD(iface, struct d3d12_command_list, ID3D12GraphicsCommandListMetalFX_vtbl);
}

static HRESULT STDMETHODCALLTYPE d3d12_command_list_metalfx_QueryInterface(ID3D12GraphicsCommandListMetalFX *iface,
        REFIID iid, void **object)
{
    struct d3d12_command_list *list = impl_from_ID3D12GraphicsCommandListMetalFX(iface);
    return d3d12_command_list_QueryInterface(&list->ID3D12GraphicsCommandList_iface, iid, object);
}

static ULONG STDMETHODCALLTYPE d3d12_command_list_metalfx_AddRef(ID3D12GraphicsCommandListMetalFX *iface)
{
    struct d3d12_command_list *list = impl_from_ID3D12GraphicsCommandListMetalFX(iface);
    return d3d12_command_list_AddRef(&list->ID3D12GraphicsCommandList_iface);
}

static ULONG STDMETHODCALLTYPE d3d12_command_list_metalfx_Release(ID3D12GraphicsCommandListMetalFX *iface)
{
    struct d3d12_command_list *list = impl_from_ID3D12GraphicsCommandListMetalFX(iface);
    return d3d12_command_list_Release(&list->ID3D12GraphicsCommandList_iface);
}

static BOOL STDMETHODCALLTYPE d3d12_command_list_metalfx_SupportsTemporalUpscale(ID3D12GraphicsCommandListMetalFX *iface)
{
    return vkd3d_metalfx_driver_has(impl_from_ID3D12GraphicsCommandListMetalFX(iface)->device, "temporal-sr");
}

static BOOL STDMETHODCALLTYPE d3d12_command_list_metalfx_SupportsDenoisedUpscale(ID3D12GraphicsCommandListMetalFX *iface)
{
    return vkd3d_metalfx_driver_has(impl_from_ID3D12GraphicsCommandListMetalFX(iface)->device, "temporal-rr");
}

/* Fills in the images and the feature's identity, and records the frame with the ids released since the last one.
 * Every image is a texture. */
static HRESULT vkd3d_metalfx_record(struct d3d12_command_list *list, VkTemporalFrameInfoMVK *info,
        ID3D12Resource *const *images, ID3D12MetalFXScaler **iface)
{
    struct d3d12_resource *resources[TEMPORAL_IMAGES] = {0};
    uint64_t released[ARRAY_SIZE(vkd3d_metalfx_released)];
    struct vkd3d_metalfx_scaler *scaler;
    unsigned int i;

    for (i = 0; i < TEMPORAL_IMAGES; i++)
    {
        if (!images[i])
            continue;
        resources[i] = impl_from_ID3D12Resource(images[i]);
        if (d3d12_resource_is_buffer(resources[i]))
            return E_INVALIDARG;
        info->images[i] = resources[i]->res.vk_image;
        info->formats[i] = vk_temporal_read_format(resources[i]->format->vk_format);
    }
    if (!(scaler = vkd3d_metalfx_scaler(iface)))
        return *iface ? E_INVALIDARG : E_OUTOFMEMORY;
    info->featureId = scaler->id;
    info->frameId = ++scaler->frames;

    spinlock_acquire(&vkd3d_metalfx_lock);
    memcpy(released, vkd3d_metalfx_released, vkd3d_metalfx_released_count * sizeof(*released));
    info->releaseFeatureIdCount = vkd3d_metalfx_released_count;
    vkd3d_metalfx_released_count = 0;
    spinlock_release(&vkd3d_metalfx_lock);
    info->pReleaseFeatureIds = released;

    d3d12_command_list_metalfx_record(list, info, resources, TEMPORAL_IMAGES);
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE d3d12_command_list_metalfx_TemporalUpscale(ID3D12GraphicsCommandListMetalFX *iface,
        const VKD3D_METALFX_TEMPORAL_DESC *desc, ID3D12MetalFXScaler **scaler)
{
    struct d3d12_command_list *list = impl_from_ID3D12GraphicsCommandListMetalFX(iface);
    ID3D12Resource *images[TEMPORAL_IMAGES] = {0};
    VkTemporalFrameInfoMVK info;

    TRACE("iface %p, desc %p, scaler %p.\n", iface, desc, scaler);

    if (!desc || !scaler || !desc->Color || !desc->Depth || !desc->MotionVector || !desc->Output)
        return E_INVALIDARG;
    if (!vkd3d_metalfx_driver_has(list->device, "temporal-sr"))
        return E_NOTIMPL;

    memset(&info, 0, sizeof(info));
    vk_temporal_super_resolution(&info, desc);
    images[TEMPORAL_COLOR] = desc->Color;
    images[TEMPORAL_DEPTH] = desc->Depth;
    images[TEMPORAL_MOTION] = desc->MotionVector;
    images[TEMPORAL_OUTPUT] = desc->Output;
    images[TEMPORAL_EXPOSURE] = desc->ExposureTexture;
    return vkd3d_metalfx_record(list, &info, images, scaler);
}

static HRESULT STDMETHODCALLTYPE d3d12_command_list_metalfx_DenoisedUpscale(ID3D12GraphicsCommandListMetalFX *iface,
        const VKD3D_METALFX_DENOISED_DESC *desc, ID3D12MetalFXScaler **scaler)
{
    struct d3d12_command_list *list = impl_from_ID3D12GraphicsCommandListMetalFX(iface);
    ID3D12Resource *images[TEMPORAL_IMAGES] = {0};
    VkTemporalFrameInfoMVK info;
    ID3D12Resource *roughness;

    TRACE("iface %p, desc %p, scaler %p.\n", iface, desc, scaler);

    roughness = !desc ? NULL : desc->RoughnessInNormalAlpha ? desc->Normals : desc->Roughness;
    if (!desc || !scaler || !desc->Color || !desc->Depth || !desc->MotionVector || !desc->Output
            || !desc->DiffuseAlbedo || !desc->SpecularAlbedo || !desc->Normals || !roughness)
        return E_INVALIDARG;
    if (!vkd3d_metalfx_driver_has(list->device, "temporal-rr"))
        return E_NOTIMPL;

    memset(&info, 0, sizeof(info));
    info.sType = VK_STRUCTURE_TYPE_TEMPORAL_FRAME_INFO_MVK;
    info.featureType = TEMPORAL_RAY_RECONSTRUCTION;
    /* Streamline DLSS-RR guide4.1.4/4.3: preserve the explicitly selected packed channel. */
    info.flags = (desc->AutoExposure ? TEMPORAL_AUTO_EXPOSURE : 0) | (desc->InReset ? TEMPORAL_RESET : 0)
            | (desc->DepthReversed ? TEMPORAL_DEPTH_REVERSED : 0)
            | (desc->RoughnessInNormalAlpha ? TEMPORAL_ROUGHNESS_NORMAL_ALPHA : 0) | TEMPORAL_HDR;
    images[TEMPORAL_COLOR] = desc->Color;
    images[TEMPORAL_DEPTH] = desc->Depth;
    images[TEMPORAL_MOTION] = desc->MotionVector;
    images[TEMPORAL_OUTPUT] = desc->Output;
    images[TEMPORAL_EXPOSURE] = desc->ExposureTexture;
    images[TEMPORAL_DIFFUSE_ALBEDO] = desc->DiffuseAlbedo;
    images[TEMPORAL_SPECULAR_ALBEDO] = desc->SpecularAlbedo;
    images[TEMPORAL_NORMALS] = desc->Normals;
    images[TEMPORAL_ROUGHNESS] = roughness;
    images[TEMPORAL_SPECULAR_HIT_DISTANCE] = desc->SpecularHitDistance;
    memcpy(info.worldToViewMatrix, desc->WorldToView, sizeof(info.worldToViewMatrix));
    memcpy(info.viewToClipMatrix, desc->ViewToClip, sizeof(info.viewToClipMatrix));
    info.motionVectorScaleX = desc->MotionVectorScaleX;
    info.motionVectorScaleY = desc->MotionVectorScaleY;
    info.jitterOffsetX = desc->JitterOffsetX;
    info.jitterOffsetY = desc->JitterOffsetY;
    info.preExposure = desc->PreExposure;
    return vkd3d_metalfx_record(list, &info, images, scaler);
}

/* Frame Generation is not offered: the NGX core then reports it unsupported. */
static BOOL STDMETHODCALLTYPE d3d12_command_list_metalfx_SupportsFrameInterpolation(ID3D12GraphicsCommandListMetalFX *iface)
{
    return FALSE;
}

static HRESULT STDMETHODCALLTYPE d3d12_command_list_metalfx_FrameInterpolate(ID3D12GraphicsCommandListMetalFX *iface,
        const VKD3D_METALFX_FRAME_INTERPOLATE_DESC *desc, ID3D12MetalFXScaler **interpolator)
{
    return E_NOTIMPL;
}

CONST_VTBL struct ID3D12GraphicsCommandListMetalFXVtbl d3d12_command_list_metalfx_vtbl =
{
    /* IUnknown methods */
    d3d12_command_list_metalfx_QueryInterface,
    d3d12_command_list_metalfx_AddRef,
    d3d12_command_list_metalfx_Release,

    /* ID3D12GraphicsCommandListMetalFX methods */
    d3d12_command_list_metalfx_SupportsTemporalUpscale,
    d3d12_command_list_metalfx_SupportsDenoisedUpscale,
    d3d12_command_list_metalfx_TemporalUpscale,
    d3d12_command_list_metalfx_DenoisedUpscale,
    d3d12_command_list_metalfx_SupportsFrameInterpolation,
    d3d12_command_list_metalfx_FrameInterpolate,
};
