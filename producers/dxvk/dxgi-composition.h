// SPDX-License-Identifier: MIT
#pragma once
#include "composition-interface.h"

namespace dxvk {
class DxgiCompositionSurface final : public IMacLauncherCompositionSurface {
public:
  DxgiCompositionSurface(IUnknown* owner, HWND window);
  ~DxgiCompositionSurface();
  ULONG STDMETHODCALLTYPE AddRef() override;
  ULONG STDMETHODCALLTYPE Release() override;
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** result) override;
  HRESULT STDMETHODCALLTYPE SetTarget(HWND target, BOOL topmost, float x, float y, const RECT* clip) override;
  void resize(UINT width, UINT height);
  static HWND createWindow(UINT width, UINT height);
private:
  IUnknown* m_owner;
  HWND m_window;
  HWND m_target = nullptr;
  float m_x = 0, m_y = 0;
};
}
