// SPDX-License-Identifier: MIT
#pragma once
#include "ngx_scene_packet.h"
#include <array>
#include <utility>
#include <wrl/client.h>

namespace ngx {
struct SceneImage {void *resource=nullptr,*commands=nullptr;uint32_t left=0,top=0,width=0,height=0;};
struct TemporalScene {
  void *commands=nullptr;std::array<SceneImage,2>images;
  void *captureOwner=nullptr;uint64_t captureEpoch=0;
  NgxScenePacketV1 packet{};
};
// Valid only during the exact Streamline evaluation on this thread.
const TemporalScene *CurrentTemporalScene() noexcept;
using SceneAttachments11=std::array<Microsoft::WRL::ComPtr<ID3D11Texture2D>,2>;
// DXVK's Vulkan submission is asynchronous. Its existing bounded fence slots
// retain these optional D3D images until the corresponding submission retires.
class SceneAttachmentLeases11 {
  std::array<SceneAttachments11,4> images;
public:
  static constexpr unsigned slots=4;
  void submitted(unsigned slot,SceneAttachments11 &&value)noexcept{images[slot]=std::move(value);}
  bool completed(unsigned slot,bool success=true)noexcept{if(!success&&(images[slot][0]||images[slot][1]))return false;images[slot]={};return true;}
};
inline bool SceneExtent(const SceneImage &image,uint64_t width,uint64_t height){return width&&height&&width<=UINT32_MAX&&height<=UINT32_MAX&&!image.left&&!image.top&&((!image.width&&!image.height)||(image.width==width&&image.height==height));}
inline Microsoft::WRL::ComPtr<ID3D12Resource> SceneResource(ID3D12GraphicsCommandList *list,const SceneImage &image){
  Microsoft::WRL::ComPtr<ID3D12Resource>texture;if(!image.resource||(image.commands&&image.commands!=list))return texture;
  if(FAILED(static_cast<IUnknown*>(image.resource)->QueryInterface(IID_PPV_ARGS(&texture))))return {};
  const auto d=texture->GetDesc();if(d.Dimension!=D3D12_RESOURCE_DIMENSION_TEXTURE2D||d.DepthOrArraySize!=1||d.SampleDesc.Count!=1||!SceneExtent(image,d.Width,d.Height))return {};
  Microsoft::WRL::ComPtr<IUnknown>actual,expected;if(FAILED(list->GetDevice(IID_PPV_ARGS(&actual)))||FAILED(texture->GetDevice(IID_PPV_ARGS(&expected)))||actual.Get()!=expected.Get())return {};return texture;
}
inline Microsoft::WRL::ComPtr<ID3D11Texture2D> SceneResource(ID3D11DeviceContext *context,const SceneImage &image){
  Microsoft::WRL::ComPtr<ID3D11Texture2D>texture;if(!image.resource||(image.commands&&image.commands!=context))return texture;
  if(FAILED(static_cast<IUnknown*>(image.resource)->QueryInterface(IID_PPV_ARGS(&texture))))return {};
  D3D11_TEXTURE2D_DESC d{};texture->GetDesc(&d);if(d.ArraySize!=1||d.SampleDesc.Count!=1||!SceneExtent(image,d.Width,d.Height))return {};
  Microsoft::WRL::ComPtr<ID3D11Device>a,b;context->GetDevice(&a);texture->GetDevice(&b);Microsoft::WRL::ComPtr<IUnknown>actual,expected;if(!a||!b)return {};a.As(&actual);b.As(&expected);if(actual.Get()!=expected.Get())return {};return texture;
}
inline void SceneTuple(NgxScenePacketV1 &p,uintptr_t commands,const VKD3D_METALFX_TEMPORAL_DESC &d) {
  p.size=sizeof(p);p.version=1;p.commandList=commands;p.color=uintptr_t(d.Color);p.depth=uintptr_t(d.Depth);p.motion=uintptr_t(d.MotionVector);p.output=uintptr_t(d.Output);
  p.colorX=d.ColorX;p.colorY=d.ColorY;p.depthX=d.DepthX;p.depthY=d.DepthY;p.motionX=d.MotionX;p.motionY=d.MotionY;p.outputX=d.OutputX;p.outputY=d.OutputY;
  p.width=d.InputContentWidth;p.height=d.InputContentHeight;p.jitterX=d.JitterOffsetX;p.jitterY=d.JitterOffsetY;p.motionScaleX=d.MotionVectorScaleX;p.motionScaleY=d.MotionVectorScaleY;
}
// The extension exists only while the original synchronous translator call
// records this exact descriptor. Restore nested callers and exception exits.
class ScenePacketScope {
  ID3D12GraphicsCommandList *commands=nullptr;NgxScenePacketV1 previous{};UINT previousSize=0;
  std::array<Microsoft::WRL::ComPtr<ID3D12Resource>,2>retained;
public:
  ScenePacketScope(ID3D12GraphicsCommandList *list,const VKD3D_METALFX_TEMPORAL_DESC &desc) noexcept {try{
    const auto scene=CurrentTemporalScene();if(!scene||scene->commands!=list)return;
    UINT size=0;const HRESULT found=list->GetPrivateData(ngx_scene_packet_guid,&size,nullptr);
    if(SUCCEEDED(found)||found==DXGI_ERROR_MORE_DATA){if(size!=sizeof(previous))return;if(FAILED(list->GetPrivateData(ngx_scene_packet_guid,&size,&previous))||size!=sizeof(previous))return;previousSize=size;}else if(found!=DXGI_ERROR_NOT_FOUND)return;
    auto packet=scene->packet;SceneTuple(packet,uintptr_t(list),desc);
    // The typed NGX D3D12 call and exact evaluation-command identity prove
    // this API before any opaque Resource.native is treated as IUnknown.
    for(unsigned i=0;i<2;++i)if((retained[i]=SceneResource(list,scene->images[i]))){packet.flags|=i?NGX_SCENE_UI:NGX_SCENE_HUDLESS;(i?packet.ui:packet.hudless)=uintptr_t(retained[i].Get());}
    if(!packet.flags)return;
    if(SUCCEEDED(list->SetPrivateData(ngx_scene_packet_guid,sizeof(packet),&packet)))commands=list;
  }catch(...) {}}
  ~ScenePacketScope(){try{if(commands&&FAILED(commands->SetPrivateData(ngx_scene_packet_guid,previousSize,previousSize?&previous:nullptr)))commands->SetPrivateData(ngx_scene_packet_guid,0,nullptr);}catch(...) {}}
  ScenePacketScope(const ScenePacketScope&)=delete;ScenePacketScope&operator=(const ScenePacketScope&)=delete;
};
}
