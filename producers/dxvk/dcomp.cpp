// SPDX-License-Identifier: MIT
#define MCL_DCOMP_BUILD
#include <windows.h>
#include <dcomp.h>
#include "composition-interface.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <new>
#include <vector>

namespace {
const GUID visualIID={0x4d93059d,0x097b,0x4651,{0x9a,0x60,0xf0,0xf2,0x51,0x16,0xe2,0xf3}};
const GUID targetIID={0xeacdd04c,0x117e,0x4e17,{0x88,0xf4,0xd1,0xb1,0x2b,0x0e,0x3d,0x89}};
template<class T> struct Ptr {
  T* p = nullptr;
  Ptr() = default;
  explicit Ptr(T* v):p(v) { if(p)p->AddRef(); }
  Ptr(const Ptr& v):Ptr(v.p) {}
  ~Ptr(){if(p)p->Release();}
  void reset(T* v=nullptr){if(v)v->AddRef();T* old=p;p=v;if(old)old->Release();}
};
struct Device;
struct Visual;
struct Target;
struct Device final : IDCompositionDevice {
  std::atomic<ULONG> refs{1};
  std::mutex mutex;
  std::vector<Target*> targets;
  ULONG STDMETHODCALLTYPE AddRef() noexcept override {return ++refs;}
  ULONG STDMETHODCALLTYPE Release() noexcept override {ULONG n=--refs;if(!n)delete this;return n;}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** out) noexcept override {
    if(!out)return E_POINTER;*out=nullptr;
    if(iid==__uuidof(IUnknown)||iid==__uuidof(IDCompositionDevice)){*out=this;AddRef();return S_OK;}
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE Commit() noexcept override;
  HRESULT STDMETHODCALLTYPE WaitForCommitCompletion() noexcept override {return S_OK;}
  HRESULT STDMETHODCALLTYPE GetFrameStatistics(DCOMPOSITION_FRAME_STATISTICS* out) noexcept override {
    if(!out)return E_POINTER;*out={};return E_NOTIMPL;
  }
  HRESULT STDMETHODCALLTYPE CreateTargetForHwnd(HWND hwnd,BOOL top,IDCompositionTarget** out) noexcept override;
  HRESULT STDMETHODCALLTYPE CreateVisual(IDCompositionVisual** out) noexcept override;
  HRESULT STDMETHODCALLTYPE CreateSurface(UINT,UINT,DXGI_FORMAT,DXGI_ALPHA_MODE,IDCompositionSurface** out) noexcept override {if(out)*out=nullptr;return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE CreateVirtualSurface(UINT,UINT,DXGI_FORMAT,DXGI_ALPHA_MODE,IDCompositionVirtualSurface** out) noexcept override {if(out)*out=nullptr;return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE CreateSurfaceFromHandle(HANDLE,IUnknown** out) noexcept override {if(out)*out=nullptr;return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE CreateSurfaceFromHwnd(HWND,IUnknown** out) noexcept override {if(out)*out=nullptr;return E_NOTIMPL;}
#define UNSUPPORTED_CREATE(method,type) HRESULT STDMETHODCALLTYPE method(type** out) noexcept override {if(out)*out=nullptr;return E_NOTIMPL;}
  UNSUPPORTED_CREATE(CreateTranslateTransform,IDCompositionTranslateTransform)
  UNSUPPORTED_CREATE(CreateScaleTransform,IDCompositionScaleTransform)
  UNSUPPORTED_CREATE(CreateRotateTransform,IDCompositionRotateTransform)
  UNSUPPORTED_CREATE(CreateSkewTransform,IDCompositionSkewTransform)
  UNSUPPORTED_CREATE(CreateMatrixTransform,IDCompositionMatrixTransform)
  UNSUPPORTED_CREATE(CreateTranslateTransform3D,IDCompositionTranslateTransform3D)
  UNSUPPORTED_CREATE(CreateScaleTransform3D,IDCompositionScaleTransform3D)
  UNSUPPORTED_CREATE(CreateRotateTransform3D,IDCompositionRotateTransform3D)
  UNSUPPORTED_CREATE(CreateMatrixTransform3D,IDCompositionMatrixTransform3D)
  UNSUPPORTED_CREATE(CreateEffectGroup,IDCompositionEffectGroup)
  UNSUPPORTED_CREATE(CreateRectangleClip,IDCompositionRectangleClip)
  UNSUPPORTED_CREATE(CreateAnimation,IDCompositionAnimation)
#undef UNSUPPORTED_CREATE
  HRESULT STDMETHODCALLTYPE CreateTransformGroup(IDCompositionTransform**,UINT,IDCompositionTransform** out) noexcept override {if(out)*out=nullptr;return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE CreateTransform3DGroup(IDCompositionTransform3D**,UINT,IDCompositionTransform3D** out) noexcept override {if(out)*out=nullptr;return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE CheckDeviceState(BOOL* out) noexcept override {if(!out)return E_POINTER;*out=TRUE;return S_OK;}
};
struct Visual final : IDCompositionVisual {
  std::atomic<ULONG> refs{1};
  Device* device;
  Ptr<IMacLauncherCompositionSurface> content,applied;
  HWND appliedTarget=nullptr;
  float x=0,y=0,matrixX=0,matrixY=0;
  bool clipped=false;
  RECT clip{};
  explicit Visual(Device* d):device(d){device->AddRef();}
  ~Visual(){detach();device->Release();}
  ULONG STDMETHODCALLTYPE AddRef() noexcept override {return ++refs;}
  ULONG STDMETHODCALLTYPE Release() noexcept override {ULONG n=--refs;if(!n)delete this;return n;}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** out) noexcept override {
    if(!out)return E_POINTER;*out=nullptr;
    if(iid==__uuidof(IUnknown)||iid==visualIID){*out=this;AddRef();return S_OK;}
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE SetOffsetX(IDCompositionAnimation*) noexcept override {return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE SetOffsetX(float v) noexcept override {if(!std::isfinite(v))return E_INVALIDARG;std::lock_guard<std::mutex>l(device->mutex);x=v;return S_OK;}
  HRESULT STDMETHODCALLTYPE SetOffsetY(IDCompositionAnimation*) noexcept override {return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE SetOffsetY(float v) noexcept override {if(!std::isfinite(v))return E_INVALIDARG;std::lock_guard<std::mutex>l(device->mutex);y=v;return S_OK;}
  HRESULT STDMETHODCALLTYPE SetTransform(IDCompositionTransform* v) noexcept override {if(v)return E_NOTIMPL;std::lock_guard<std::mutex>l(device->mutex);matrixX=matrixY=0;return S_OK;}
  HRESULT STDMETHODCALLTYPE SetTransform(const D2D_MATRIX_3X2_F& m) noexcept override {
    if(m._11!=1||m._12!=0||m._21!=0||m._22!=1)return E_NOTIMPL;
    if(!std::isfinite(m._31)||!std::isfinite(m._32))return E_INVALIDARG;
    std::lock_guard<std::mutex>l(device->mutex);matrixX=m._31;matrixY=m._32;return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetTransformParent(IDCompositionVisual* v) noexcept override {return v?E_NOTIMPL:S_OK;}
  HRESULT STDMETHODCALLTYPE SetEffect(IDCompositionEffect* v) noexcept override {return v?E_NOTIMPL:S_OK;}
  HRESULT STDMETHODCALLTYPE SetBitmapInterpolationMode(DCOMPOSITION_BITMAP_INTERPOLATION_MODE) noexcept override {return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE SetBorderMode(DCOMPOSITION_BORDER_MODE) noexcept override {return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE SetClip(IDCompositionClip* v) noexcept override {if(v)return E_NOTIMPL;std::lock_guard<std::mutex>l(device->mutex);clipped=false;return S_OK;}
  HRESULT STDMETHODCALLTYPE SetClip(const D2D_RECT_F& r) noexcept override {
    if(!std::isfinite(r.left)||!std::isfinite(r.right)||!std::isfinite(r.top)||!std::isfinite(r.bottom)||r.right<r.left||r.bottom<r.top)return E_INVALIDARG;
    std::lock_guard<std::mutex>l(device->mutex);clip={LONG(std::lround(r.left)),LONG(std::lround(r.top)),LONG(std::lround(r.right)),LONG(std::lround(r.bottom))};clipped=true;return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetContent(IUnknown* value) noexcept override {
    IMacLauncherCompositionSurface* next=nullptr;
    if(value){HRESULT hr=value->QueryInterface(__uuidof(IMacLauncherCompositionSurface),reinterpret_cast<void**>(&next));if(FAILED(hr))return hr;}
    std::lock_guard<std::mutex>l(device->mutex);content.reset(next);if(next)next->Release();return S_OK;
  }
  HRESULT STDMETHODCALLTYPE AddVisual(IDCompositionVisual*,BOOL,IDCompositionVisual*) noexcept override {return E_NOTIMPL;}
  HRESULT STDMETHODCALLTYPE RemoveVisual(IDCompositionVisual*) noexcept override {return E_INVALIDARG;}
  HRESULT STDMETHODCALLTYPE RemoveAllVisuals() noexcept override {return S_OK;}
  HRESULT STDMETHODCALLTYPE SetCompositeMode(DCOMPOSITION_COMPOSITE_MODE mode) noexcept override {return mode==DCOMPOSITION_COMPOSITE_MODE_SOURCE_OVER?S_OK:E_NOTIMPL;}
  void detach(){if(applied.p)applied.p->SetTarget(nullptr,FALSE,0,0,nullptr);applied.reset();appliedTarget=nullptr;}
  HRESULT commit(HWND target,BOOL topmost){
    if(applied.p!=content.p||appliedTarget!=target)detach();
    if(!content.p)return S_OK;
    HRESULT hr=content.p->SetTarget(target,topmost,x+matrixX,y+matrixY,clipped?&clip:nullptr);
    if(SUCCEEDED(hr)){applied.reset(content.p);appliedTarget=target;}
    return hr;
  }
};
struct Target final : IDCompositionTarget {
  std::atomic<ULONG> refs{1};
  Device* device;
  HWND window;
  BOOL topmost;
  Ptr<Visual> root,applied;
  Target(Device* d,HWND w,BOOL top):device(d),window(w),topmost(top){device->AddRef();}
  ~Target(){
    {std::lock_guard<std::mutex>l(device->mutex);if(applied.p)applied.p->detach();auto& v=device->targets;v.erase(std::remove(v.begin(),v.end(),this),v.end());}
    device->Release();
  }
  ULONG STDMETHODCALLTYPE AddRef() noexcept override {return ++refs;}
  ULONG STDMETHODCALLTYPE Release() noexcept override {ULONG n=--refs;if(!n)delete this;return n;}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** out) noexcept override {
    if(!out)return E_POINTER;*out=nullptr;
    if(iid==__uuidof(IUnknown)||iid==targetIID){*out=this;AddRef();return S_OK;}
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE SetRoot(IDCompositionVisual* value) noexcept override {
    auto next=dynamic_cast<Visual*>(value);
    if(value&&(!next||next->device!=device))return E_INVALIDARG;
    std::lock_guard<std::mutex>l(device->mutex);root.reset(next);return S_OK;
  }
  HRESULT commit(){
    if(!IsWindow(window))return HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE);
    if(applied.p!=root.p){if(applied.p)applied.p->detach();applied.reset();}
    if(!root.p)return S_OK;
    HRESULT hr=root.p->commit(window,topmost);if(SUCCEEDED(hr))applied.reset(root.p);return hr;
  }
};
HRESULT Device::Commit() noexcept {std::lock_guard<std::mutex>l(mutex);for(auto* target:targets){HRESULT hr=target->commit();if(FAILED(hr))return hr;}return S_OK;}
HRESULT Device::CreateTargetForHwnd(HWND hwnd,BOOL top,IDCompositionTarget** out) noexcept {
  if(!out)return E_POINTER;*out=nullptr;
  if(!IsWindow(hwnd))return E_INVALIDARG;
  DWORD pid=0;GetWindowThreadProcessId(hwnd,&pid);if(pid!=GetCurrentProcessId())return E_ACCESSDENIED;
  auto* target=new(std::nothrow)Target(this,hwnd,top);if(!target)return E_OUTOFMEMORY;
  try{std::lock_guard<std::mutex>l(mutex);targets.push_back(target);}catch(...){target->Release();return E_OUTOFMEMORY;}
  *out=target;return S_OK;
}
HRESULT Device::CreateVisual(IDCompositionVisual** out) noexcept {if(!out)return E_POINTER;*out=nullptr;auto* v=new(std::nothrow)Visual(this);if(!v)return E_OUTOFMEMORY;*out=v;return S_OK;}
}
extern "C" HRESULT WINAPI DCompositionCreateDevice(IDXGIDevice*,REFIID iid,void** out){
  if(!out)return E_POINTER;*out=nullptr;auto* device=new(std::nothrow)Device;if(!device)return E_OUTOFMEMORY;
  HRESULT hr=device->QueryInterface(iid,out);device->Release();return hr;
}
extern "C" HRESULT WINAPI DCompositionCreateDevice2(IUnknown*,REFIID iid,void** out){return DCompositionCreateDevice(nullptr,iid,out);}
extern "C" HRESULT WINAPI DCompositionCreateDevice3(IUnknown*,REFIID iid,void** out){return DCompositionCreateDevice(nullptr,iid,out);}
extern "C" HRESULT WINAPI DllCanUnloadNow(){return S_FALSE;}

namespace {
LRESULT CALLBACK compositionWindowProc(HWND window,UINT message,WPARAM wparam,LPARAM lparam){
  // A visual surface is not an input target. Mouse hit testing passes through
  // to the application's target HWND, and presentation never takes focus.
  if(message==WM_NCHITTEST)return HTTRANSPARENT;
  if(message==WM_MOUSEACTIVATE)return MA_NOACTIVATE;
  return DefWindowProcW(window,message,wparam,lparam);
}
}
extern "C" HRESULT WINAPI MCLCompositionCreateWindow(UINT width,UINT height,HWND* out){
  if(!out)return E_POINTER;*out=nullptr;if(!width||!height)return E_INVALIDARG;
  static std::once_flag once;static bool registered=false;static HMODULE module=nullptr;
  std::call_once(once,[]{
    // The registered window procedure must remain valid until process exit.
    if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(&MCLCompositionCreateWindow),&module))return;
    WNDCLASSEXW wc={};wc.cbSize=sizeof(wc);wc.hInstance=module;
    wc.lpfnWndProc=compositionWindowProc;wc.lpszClassName=L"MacLauncherCompositionSurface";
    registered=RegisterClassExW(&wc)||GetLastError()==ERROR_CLASS_ALREADY_EXISTS;});
  if(!registered)return HRESULT_FROM_WIN32(GetLastError());
  HWND window=CreateWindowExW(WS_EX_NOACTIVATE,L"MacLauncherCompositionSurface",L"",
      WS_POPUP|WS_CLIPSIBLINGS|WS_CLIPCHILDREN,0,0,width,height,nullptr,nullptr,module,nullptr);
  if(!window)return HRESULT_FROM_WIN32(GetLastError());*out=window;return S_OK;
}
