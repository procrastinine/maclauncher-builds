/*
 * MetalSharp: MetalFX upscaling recorded in a D3D12 command list (ID3D12GraphicsCommandListMetalFX), for
 * VKD3D-Proton-MacOS's NGX core (ngx/nvngx), which runs DLSS Super Resolution on MetalFX's temporal scaler, Ray
 * Reconstruction on its denoised scaler and Frame Generation on its frame interpolator. MoltenVK runs them
 * (mvk_metalfx.h).
 *
 * This header is C, and the NGX core (C++) includes it as it is.
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

#ifndef __VKD3D_METALFX_H
#define __VKD3D_METALFX_H

typedef struct VKD3D_METALFX_TEMPORAL_DESC
{
    UINT InputContentWidth;  /* 0: the color's width */
    UINT InputContentHeight; /* 0: the color's height */
    BOOL AutoExposure;
    BOOL InReset;
    BOOL DepthReversed;
    BOOL MotionVectorInDisplayRes;
    ID3D12Resource *Color;
    ID3D12Resource *Depth;
    ID3D12Resource *MotionVector;
    ID3D12Resource *Output;
    ID3D12Resource *ExposureTexture; /* optional */
    FLOAT MotionVectorScaleX;
    FLOAT MotionVectorScaleY;
    FLOAT PreExposure;
    FLOAT JitterOffsetX;
    FLOAT JitterOffsetY;
} VKD3D_METALFX_TEMPORAL_DESC;

typedef struct VKD3D_METALFX_DENOISED_DESC
{
    BOOL AutoExposure;
    BOOL InReset;
    BOOL DepthReversed;
    BOOL RoughnessInNormalAlpha; /* roughness is the normals' alpha (DLSS.Roughness.Mode packed) */
    ID3D12Resource *Color;
    ID3D12Resource *Depth;
    ID3D12Resource *MotionVector;
    ID3D12Resource *DiffuseAlbedo;
    ID3D12Resource *SpecularAlbedo;
    ID3D12Resource *Normals;
    ID3D12Resource *Roughness;           /* unused when RoughnessInNormalAlpha */
    ID3D12Resource *SpecularHitDistance; /* optional */
    ID3D12Resource *ExposureTexture;     /* optional */
    ID3D12Resource *Output;
    FLOAT MotionVectorScaleX;
    FLOAT MotionVectorScaleY;
    FLOAT PreExposure;
    FLOAT JitterOffsetX;
    FLOAT JitterOffsetY;
    /* row-major, of row vectors (D3D's) */
    FLOAT WorldToView[16];
    FLOAT ViewToClip[16];
} VKD3D_METALFX_DENOISED_DESC;

/* The frame between the last one interpolated and Color (MetalFX's frame interpolator, DLSS Frame Generation). Depth
 * and motion are at the render size, color, UI and output at the swap chain's. */
typedef struct VKD3D_METALFX_FRAME_INTERPOLATE_DESC
{
    BOOL InReset;
    BOOL DepthReversed;
    BOOL UIComposited; /* the UI is in Color too */
    ID3D12Resource *Color;
    ID3D12Resource *Depth;
    ID3D12Resource *MotionVector;
    ID3D12Resource *UI; /* optional: color and alpha */
    ID3D12Resource *Output;
    FLOAT MotionVectorScaleX; /* to pixels of the motion vectors' resource */
    FLOAT MotionVectorScaleY;
    FLOAT JitterOffsetX;
    FLOAT JitterOffsetY;
    FLOAT DeltaTime; /* seconds */
    FLOAT Near;
    FLOAT Far;
    FLOAT FieldOfView; /* vertical, in degrees */
    FLOAT AspectRatio;
} VKD3D_METALFX_FRAME_INTERPOLATE_DESC;

/* A feature's scaler, which its owner destroys when it is done with the feature. */
typedef struct ID3D12MetalFXScaler ID3D12MetalFXScaler;

typedef struct ID3D12MetalFXScalerVtbl
{
    void (STDMETHODCALLTYPE *Destroy)(ID3D12MetalFXScaler *This);
} ID3D12MetalFXScalerVtbl;

struct ID3D12MetalFXScaler
{
    const ID3D12MetalFXScalerVtbl *lpVtbl;
};

typedef struct ID3D12GraphicsCommandListMetalFX ID3D12GraphicsCommandListMetalFX;

typedef struct ID3D12GraphicsCommandListMetalFXVtbl
{
    HRESULT (STDMETHODCALLTYPE *QueryInterface)(ID3D12GraphicsCommandListMetalFX *This, REFIID riid, void **object);
    ULONG (STDMETHODCALLTYPE *AddRef)(ID3D12GraphicsCommandListMetalFX *This);
    ULONG (STDMETHODCALLTYPE *Release)(ID3D12GraphicsCommandListMetalFX *This);
    BOOL (STDMETHODCALLTYPE *SupportsTemporalUpscale)(ID3D12GraphicsCommandListMetalFX *This);
    BOOL (STDMETHODCALLTYPE *SupportsDenoisedUpscale)(ID3D12GraphicsCommandListMetalFX *This);
    /* *upscaler is a feature's scaler, made at its first upscale */
    HRESULT (STDMETHODCALLTYPE *TemporalUpscale)(ID3D12GraphicsCommandListMetalFX *This,
            const VKD3D_METALFX_TEMPORAL_DESC *desc, ID3D12MetalFXScaler **upscaler);
    HRESULT (STDMETHODCALLTYPE *DenoisedUpscale)(ID3D12GraphicsCommandListMetalFX *This,
            const VKD3D_METALFX_DENOISED_DESC *desc, ID3D12MetalFXScaler **upscaler);
    /* Added in v5.0, which ships its NGX core with it. */
    BOOL (STDMETHODCALLTYPE *SupportsFrameInterpolation)(ID3D12GraphicsCommandListMetalFX *This);
    HRESULT (STDMETHODCALLTYPE *FrameInterpolate)(ID3D12GraphicsCommandListMetalFX *This,
            const VKD3D_METALFX_FRAME_INTERPOLATE_DESC *desc, ID3D12MetalFXScaler **interpolator);
} ID3D12GraphicsCommandListMetalFXVtbl;

struct ID3D12GraphicsCommandListMetalFX
{
    const ID3D12GraphicsCommandListMetalFXVtbl *lpVtbl;
};

/* b2697de8-21af-4406-91f8-73a2fdd27029 */
static const GUID IID_ID3D12GraphicsCommandListMetalFX =
        {0xb2697de8, 0x21af, 0x4406, {0x91, 0xf8, 0x73, 0xa2, 0xfd, 0xd2, 0x70, 0x29}};

#endif
