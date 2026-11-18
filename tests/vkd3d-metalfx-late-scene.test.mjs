import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// metalfx.c, compiled natively against a minimal stand-in for VKD3D-Proton's private header: the command list's
// MetalFX1 methods record the same VkTemporalFrameInfoMVK that the Vulkan driver receives.
const root=path.resolve(import.meta.dirname,'..'),producer=path.join(root,'producers/vkd3d-proton');
const translator=String.raw`
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#define TRUE 1
#define FALSE 0
typedef int32_t HRESULT;typedef uint32_t UINT;typedef int BOOL;typedef float FLOAT;typedef uint64_t UINT64;typedef uint32_t ULONG;
#define S_OK ((HRESULT)0)
#define E_INVALIDARG ((HRESULT)0x80070057)
#define E_OUTOFMEMORY ((HRESULT)0x8007000E)
#define E_NOTIMPL ((HRESULT)0x80004001)
#define FAILED(hr) ((HRESULT)(hr) < 0)
#define SUCCEEDED(hr) ((HRESULT)(hr) >= 0)
#define STDMETHODCALLTYPE
#define CONST_VTBL const
typedef struct {uint32_t Data1;uint16_t Data2,Data3;uint8_t Data4[8];} GUID;
typedef const GUID *REFIID;
#define IsEqualGUID(a,b) (!memcmp((a),(b),sizeof(GUID)))
#define ARRAY_SIZE(a) (sizeof(a)/sizeof((a)[0]))
#define CONTAINING_RECORD(address,type,field) ((type *)((char *)(address)-offsetof(type,field)))
#define TRACE(...) ((void)0)
typedef int spinlock_t;
static inline void spinlock_acquire(spinlock_t *lock){(void)lock;}
static inline void spinlock_release(spinlock_t *lock){(void)lock;}
#define vkd3d_malloc malloc
#define vkd3d_free free
typedef int VkStructureType;typedef struct VkImage_T *VkImage;
typedef enum VkFormat {VK_FORMAT_UNDEFINED=0,VK_FORMAT_R8G8B8A8_UNORM=37,VK_FORMAT_R16_UINT=74,VK_FORMAT_R16_SINT=75,VK_FORMAT_R16_SFLOAT=76,
  VK_FORMAT_R16G16_UINT=81,VK_FORMAT_R16G16_SINT=82,VK_FORMAT_R16G16_SFLOAT=83,VK_FORMAT_R32_UINT=98,VK_FORMAT_R32_SINT=99,
  VK_FORMAT_R32_SFLOAT=100,VK_FORMAT_R32G32_UINT=101,VK_FORMAT_R32G32_SINT=102,VK_FORMAT_R32G32_SFLOAT=103} VkFormat;
typedef struct ID3D12Resource {const void *lpVtbl;} ID3D12Resource;
struct ID3D12Resource2Vtbl {int unused;};
#define D3D12_RESOURCE_DIMENSION_TEXTURE2D 3
struct vkd3d_format {VkFormat vk_format;};
struct d3d12_device {struct {struct {char driverInfo[256];} vulkan_1_2_properties;} device_info;};
struct d3d12_resource {ID3D12Resource iface;struct d3d12_device *device;bool buffer;
  struct {int Dimension;UINT DepthOrArraySize;struct {UINT Count;} SampleDesc;} desc;
  const struct vkd3d_format *format;struct {VkImage vk_image;} res;};
static inline struct d3d12_resource *impl_from_ID3D12Resource(ID3D12Resource *iface){return CONTAINING_RECORD(iface,struct d3d12_resource,iface);}
static inline bool d3d12_resource_is_buffer(const struct d3d12_resource *resource){return resource->buffer;}
typedef struct d3d12_command_list_iface {const void *lpVtbl;} d3d12_command_list_iface;
struct vkd3d_private_store {int unused;};
struct d3d12_command_list {d3d12_command_list_iface ID3D12GraphicsCommandList_iface;const void *ID3D12GraphicsCommandListMetalFX_vtbl;
  struct d3d12_device *device;struct vkd3d_private_store private_store;};
HRESULT vkd3d_get_private_data(struct vkd3d_private_store *store,const GUID *tag,UINT *size,void *data);
HRESULT vkd3d_set_private_data(struct vkd3d_private_store *store,const GUID *tag,UINT size,const void *data,void *a,void *b);
`;
const fixture=String.raw`
#include "vkd3d_private.h"
#include "vkd3d_metalfx.h"
#include "vk_temporal_frame.h"
#include <assert.h>
#include <stdio.h>
_Static_assert(offsetof(ID3D12GraphicsCommandListMetalFX1Vtbl,FrameInterpolate)==offsetof(ID3D12GraphicsCommandListMetalFXVtbl,FrameInterpolate),
               "MetalFX1 begins with the MetalFX methods in order");
_Static_assert(offsetof(ID3D12GraphicsCommandListMetalFX1Vtbl,TemporalFrameId)==sizeof(ID3D12GraphicsCommandListMetalFXVtbl),
               "the late scene methods follow the MetalFX methods");
const struct ID3D12Resource2Vtbl d3d12_resource_vtbl={0};
extern CONST_VTBL struct ID3D12GraphicsCommandListMetalFX1Vtbl d3d12_command_list_metalfx_vtbl;
static VkTemporalFrameInfoMVK recorded;static unsigned records;
void d3d12_command_list_metalfx_record(struct d3d12_command_list *list,const void *scale,struct d3d12_resource **resources,unsigned int count)
{(void)list;(void)resources;(void)count;recorded=*(const VkTemporalFrameInfoMVK *)scale;records++;}
HRESULT STDMETHODCALLTYPE d3d12_command_list_QueryInterface(d3d12_command_list_iface *iface,REFIID iid,void **object){(void)iface;(void)iid;(void)object;return E_NOTIMPL;}
ULONG STDMETHODCALLTYPE d3d12_command_list_AddRef(d3d12_command_list_iface *iface){(void)iface;return 1;}
ULONG STDMETHODCALLTYPE d3d12_command_list_Release(d3d12_command_list_iface *iface){(void)iface;return 1;}
HRESULT vkd3d_get_private_data(struct vkd3d_private_store *store,const GUID *tag,UINT *size,void *data){(void)store;(void)tag;(void)size;(void)data;return E_INVALIDARG;}
HRESULT vkd3d_set_private_data(struct vkd3d_private_store *store,const GUID *tag,UINT size,const void *data,void *a,void *b){(void)store;(void)tag;(void)size;(void)data;(void)a;(void)b;return S_OK;}
static const struct vkd3d_format rgba={VK_FORMAT_R8G8B8A8_UNORM};
static struct d3d12_device device;
static void texture(struct d3d12_resource *r,uintptr_t image){memset(r,0,sizeof(*r));r->iface.lpVtbl=&d3d12_resource_vtbl;r->device=&device;
  r->desc.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;r->desc.DepthOrArraySize=1;r->desc.SampleDesc.Count=1;r->format=&rgba;r->res.vk_image=(VkImage)image;}
int main(void)
{
  unsigned checks=0;struct d3d12_command_list list;memset(&list,0,sizeof(list));
  strcpy(device.device_info.vulkan_1_2_properties.driverInfo,"Mesa temporal-sr");list.device=&device;
  list.ID3D12GraphicsCommandListMetalFX_vtbl=&d3d12_command_list_metalfx_vtbl;
  ID3D12GraphicsCommandListMetalFX1 *metalfx=(ID3D12GraphicsCommandListMetalFX1 *)&list.ID3D12GraphicsCommandListMetalFX_vtbl;
  struct d3d12_resource color,depth,motion,output,hudless,ui,foreign;
  texture(&color,0x10);texture(&depth,0x20);texture(&motion,0x30);texture(&output,0x40);texture(&hudless,0x50);texture(&ui,0x60);
  texture(&foreign,0x70);foreign.iface.lpVtbl=&rgba; /* a wrapped resource is not read */
  ID3D12MetalFXScaler *scaler=NULL;
  assert(metalfx->lpVtbl->TemporalFrameId(metalfx,NULL)==0);checks++;
  VKD3D_METALFX_TEMPORAL_DESC sr;memset(&sr,0,sizeof(sr));
  sr.Color=&color.iface;sr.Depth=&depth.iface;sr.MotionVector=&motion.iface;sr.Output=&output.iface;sr.JitterOffsetX=.25f;
  assert(metalfx->lpVtbl->TemporalUpscale(metalfx,&sr,&scaler)==S_OK&&scaler&&recorded.frameId==1&&recorded.featureType==TEMPORAL_SUPER_RESOLUTION);checks++;
  const uint64_t feature=recorded.featureId;
  assert(metalfx->lpVtbl->TemporalFrameId(metalfx,scaler)==1);checks++;
  assert(metalfx->lpVtbl->TemporalUpscale(metalfx,&sr,&scaler)==S_OK&&recorded.frameId==2);checks++;
  assert(metalfx->lpVtbl->TemporalFrameId(metalfx,scaler)==2);checks++;

  VKD3D_METALFX_LATE_SCENE_DESC late;memset(&late,0,sizeof(late));
  late.FrameId=2;late.HudLess=&hudless.iface;late.UI=&ui.iface;late.CameraValid=TRUE;late.DepthReversed=TRUE;late.DepthInfinite=TRUE;
  late.NearPlane=10.f;late.FarPlane=0.f;late.VerticalFov=1.5f;
  memset(&recorded,0xcd,sizeof(recorded));records=0;
  assert(metalfx->lpVtbl->LateScene(metalfx,&late,scaler)==S_OK&&records==1);checks++;
  assert(recorded.sType==VK_STRUCTURE_TYPE_TEMPORAL_FRAME_INFO_MVK&&!recorded.pNext&&recorded.featureType==TEMPORAL_LATE_SCENE&&
         recorded.featureId==feature&&recorded.frameId==2);checks++;
  assert(recorded.flags==(TEMPORAL_DEPTH_REVERSED|TEMPORAL_CAMERA_VALID|TEMPORAL_DEPTH_INFINITE)&&recorded.nearPlane==10.f&&
         recorded.farPlane==0.f&&recorded.verticalFov==1.5f);checks++;
  for(unsigned i=0;i<TEMPORAL_IMAGES;i++)
    assert(recorded.images[i]==(i==TEMPORAL_HUDLESS?(VkImage)0x50:i==TEMPORAL_UI?(VkImage)0x60:NULL));
  assert(recorded.formats[TEMPORAL_HUDLESS]==VK_FORMAT_UNDEFINED&&recorded.formats[TEMPORAL_UI]==VK_FORMAT_UNDEFINED);checks++;
  assert(!recorded.releaseFeatureIdCount&&!recorded.pReleaseFeatureIds&&recorded.jitterOffsetX==0.f&&!recorded.renderWidth&&
         !recorded.outputWidth&&recorded.preExposure==0.f);checks++;
  /* the late scene does not advance the feature's frames */
  assert(metalfx->lpVtbl->TemporalFrameId(metalfx,scaler)==2);checks++;
  /* the camera alone, an earlier frame and either image alone are a late scene */
  VKD3D_METALFX_LATE_SCENE_DESC camera=late;camera.HudLess=camera.UI=NULL;camera.FrameId=1;
  assert(metalfx->lpVtbl->LateScene(metalfx,&camera,scaler)==S_OK&&recorded.frameId==1&&!recorded.images[TEMPORAL_HUDLESS]&&
         !recorded.images[TEMPORAL_UI]&&(recorded.flags&TEMPORAL_CAMERA_VALID));checks++;
  VKD3D_METALFX_LATE_SCENE_DESC image=late;image.UI=NULL;image.CameraValid=FALSE;
  assert(metalfx->lpVtbl->LateScene(metalfx,&image,scaler)==S_OK&&recorded.images[TEMPORAL_HUDLESS]==(VkImage)0x50&&
         recorded.flags==TEMPORAL_DEPTH_REVERSED&&recorded.nearPlane==0.f);checks++;
  /* declined: no scaler, frame 0, a frame not yet evaluated, nothing supplied, only an image this translator cannot read */
  records=0;
  assert(metalfx->lpVtbl->LateScene(metalfx,&late,NULL)==E_INVALIDARG);checks++;
  VKD3D_METALFX_LATE_SCENE_DESC bad=late;bad.FrameId=0;assert(metalfx->lpVtbl->LateScene(metalfx,&bad,scaler)==E_INVALIDARG);checks++;
  bad.FrameId=3;assert(metalfx->lpVtbl->LateScene(metalfx,&bad,scaler)==E_INVALIDARG);checks++;
  bad=late;bad.HudLess=bad.UI=NULL;bad.CameraValid=FALSE;assert(metalfx->lpVtbl->LateScene(metalfx,&bad,scaler)==E_INVALIDARG);checks++;
  bad.HudLess=&foreign.iface;assert(metalfx->lpVtbl->LateScene(metalfx,&bad,scaler)==E_INVALIDARG);checks++;
  assert(metalfx->lpVtbl->LateScene(metalfx,NULL,scaler)==E_INVALIDARG&&!records);checks++;
  /* a driver that does not forward temporal frames records none */
  strcpy(device.device_info.vulkan_1_2_properties.driverInfo,"Mesa");
  assert(metalfx->lpVtbl->LateScene(metalfx,&late,scaler)==E_NOTIMPL&&!records);checks++;
  scaler->lpVtbl->Destroy(scaler);
  printf("ok %u\n",checks);
  return 0;
}
`;

test('the MetalFX1 late scene records the scene of an earlier evaluation with its feature and frame',{skip:process.platform==='win32'?'Fixture uses a POSIX compiler.':false},t=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'vkd3d-metalfx-late-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.writeFileSync(path.join(directory,'vkd3d_private.h'),translator);
 fs.writeFileSync(path.join(directory,'late.c'),fixture);
 const compiler=process.env.CC||(fs.existsSync('/usr/bin/clang')?'/usr/bin/clang':'cc');
 const built=spawnSync(compiler,['-std=gnu11','-O1','-Wall','-Werror','-Wno-unused-function','-I'+directory,'-I'+producer,'-o',path.join(directory,'late'),
   path.join(directory,'late.c'),path.join(producer,'metalfx.c')],{encoding:'utf8'});
 assert.equal(built.status,0,built.stderr);
 const ran=spawnSync(path.join(directory,'late'),{encoding:'utf8',timeout:60000});
 assert.equal(ran.status,0,ran.stderr+ran.stdout);
 assert.equal(ran.stdout.trim(),'ok 20');
});

test('VKD3D-Proton command lists answer both MetalFX interfaces with the one extended table',()=>{
 const patch=fs.readFileSync(path.join(producer,'metalfx.patch'),'utf8');
 assert.match(patch,/^\+    if \(IsEqualGUID\(iid, &IID_ID3D12GraphicsCommandListMetalFX\) \|\| IsEqualGUID\(iid, &IID_ID3D12GraphicsCommandListMetalFX1\)\)$/m);
 assert.match(patch,/^\+extern CONST_VTBL struct ID3D12GraphicsCommandListMetalFX1Vtbl d3d12_command_list_metalfx_vtbl;$/m);
});
