// SPDX-License-Identifier: MIT
// Optional synchronous command-list metadata. The shipped MetalFX descriptor
// and vtable remain unchanged. Include vkd3d_metalfx.h first.
#pragma once
#include <stdint.h>
#include <string.h>

static const GUID ngx_scene_packet_guid = {0x9b30a99e,0xa26f,0x4ce4,{0xa7,0xcf,0x54,0x39,0x67,0x28,0x80,0x11}};
enum { NGX_SCENE_MATRICES=1, NGX_SCENE_HUDLESS=2, NGX_SCENE_UI=4 };
typedef struct NgxScenePacketV1 {
  uint32_t size,version,flags,reserved;
  uint64_t commandList,frameId,viewportId,color,depth,motion,output;
  uint32_t colorX,colorY,depthX,depthY,motionX,motionY,outputX,outputY,width,height;
  float jitterX,jitterY,motionScaleX,motionScaleY;
  float worldToView[16],viewToClip[16];
  uint64_t hudless,ui;
} NgxScenePacketV1;
#ifdef __cplusplus
static_assert(sizeof(NgxScenePacketV1)==272,"scene packet version 1 is 272 bytes");
#else
_Static_assert(sizeof(NgxScenePacketV1)==272,"scene packet version 1 is 272 bytes");
#endif

static inline int ngx_scene_packet_matches(const NgxScenePacketV1 *p,uintptr_t commands,const VKD3D_METALFX_TEMPORAL_DESC *d) {
  return p->size==sizeof(*p)&&p->version==1&&!p->reserved&&p->frameId&&p->flags&&!(p->flags&~7u)&&
    p->commandList==(uint64_t)commands&&p->color==(uint64_t)(uintptr_t)d->Color&&p->depth==(uint64_t)(uintptr_t)d->Depth&&
    p->motion==(uint64_t)(uintptr_t)d->MotionVector&&p->output==(uint64_t)(uintptr_t)d->Output&&
    p->colorX==d->ColorX&&p->colorY==d->ColorY&&p->depthX==d->DepthX&&p->depthY==d->DepthY&&
    p->motionX==d->MotionX&&p->motionY==d->MotionY&&p->outputX==d->OutputX&&p->outputY==d->OutputY&&
    p->width==d->InputContentWidth&&p->height==d->InputContentHeight&&
    !memcmp(&p->jitterX,&d->JitterOffsetX,sizeof(float))&&!memcmp(&p->jitterY,&d->JitterOffsetY,sizeof(float))&&
    !memcmp(&p->motionScaleX,&d->MotionVectorScaleX,sizeof(float))&&!memcmp(&p->motionScaleY,&d->MotionVectorScaleY,sizeof(float))&&
    (!!p->hudless==!!(p->flags&NGX_SCENE_HUDLESS))&&(!!p->ui==!!(p->flags&NGX_SCENE_UI));
}
