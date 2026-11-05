// SPDX-License-Identifier: MIT
#pragma once
#include <unknwn.h>
#include <windef.h>

// A composition surface is bound only by a committed visual tree. The interface
// is shared by the paired DXGI and DirectComposition provider DLLs.
struct IMacLauncherCompositionSurface : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE SetTarget(HWND window, BOOL topmost, float x, float y,
      const RECT* clip) = 0;
};

#ifdef __CRT_UUID_DECL
__CRT_UUID_DECL(IMacLauncherCompositionSurface,0x1bcc51bb,0x66c7,0x4b8b,0xb6,0xdb,0x0d,0x57,0x3a,0x35,0x38,0x9e);
#endif

#ifdef MCL_DCOMP_BUILD
#define MCL_DCOMP_API
#else
#define MCL_DCOMP_API __declspec(dllimport)
#endif
extern "C" MCL_DCOMP_API HRESULT WINAPI MCLCompositionCreateWindow(UINT width, UINT height, HWND* window);
