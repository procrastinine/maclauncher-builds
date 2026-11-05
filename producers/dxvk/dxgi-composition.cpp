// SPDX-License-Identifier: MIT
#include "dxgi-composition.h"
#include <cmath>
#include <mutex>
#include <windows.h>

namespace dxvk {
DxgiCompositionSurface::DxgiCompositionSurface(IUnknown* owner, HWND window)
: m_owner(owner), m_window(window) {}
DxgiCompositionSurface::~DxgiCompositionSurface() {
  if (GetWindowThreadProcessId(m_window, nullptr) == GetCurrentThreadId()) DestroyWindow(m_window);
  else PostMessageW(m_window, WM_CLOSE, 0, 0);
}
ULONG STDMETHODCALLTYPE DxgiCompositionSurface::AddRef() { return m_owner->AddRef(); }
ULONG STDMETHODCALLTYPE DxgiCompositionSurface::Release() { return m_owner->Release(); }
HRESULT STDMETHODCALLTYPE DxgiCompositionSurface::QueryInterface(REFIID iid, void** result) {
  if (!result) return E_POINTER;
  *result = nullptr;
  if (iid == __uuidof(IMacLauncherCompositionSurface)) {
    *result = this; AddRef(); return S_OK;
  }
  return m_owner->QueryInterface(iid, result);
}
HWND DxgiCompositionSurface::createWindow(UINT width, UINT height) {
  HWND window = nullptr;
  HRESULT hr = MCLCompositionCreateWindow(width, height, &window);
  if (FAILED(hr)) { SetLastError(HRESULT_CODE(hr)); return nullptr; }
  return window;
}
HRESULT STDMETHODCALLTYPE DxgiCompositionSurface::SetTarget(HWND target, BOOL topmost, float x, float y, const RECT* clip) {
  if (!std::isfinite(x) || !std::isfinite(y)) return E_INVALIDARG;
  if (target && !IsWindow(target)) return E_INVALIDARG;
  if (!target) {
    ShowWindow(m_window, SW_HIDE);
    m_target = nullptr;
    return S_OK;
  }
  DWORD pid = 0;
  GetWindowThreadProcessId(target, &pid);
  if (pid != GetCurrentProcessId()) return E_ACCESSDENIED;
  SetLastError(ERROR_SUCCESS);
  SetWindowLongPtrW(m_window, GWL_STYLE, WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN);
  if (GetLastError()) return HRESULT_FROM_WIN32(GetLastError());
  SetLastError(ERROR_SUCCESS);
  if (!SetParent(m_window, target) && GetLastError()) return HRESULT_FROM_WIN32(GetLastError());
  m_target = target; m_x = x; m_y = y;
  RECT rc = {}; GetClientRect(m_window, &rc);
  if (!SetWindowPos(m_window, topmost ? HWND_TOP : HWND_BOTTOM, std::lround(x), std::lround(y),
      rc.right, rc.bottom, SWP_NOACTIVATE | SWP_SHOWWINDOW))
    return HRESULT_FROM_WIN32(GetLastError());
  HRGN region = clip ? CreateRectRgn(clip->left, clip->top, clip->right, clip->bottom) : nullptr;
  if (clip && !region) return E_OUTOFMEMORY;
  if (!SetWindowRgn(m_window, region, TRUE)) {
    if (region) DeleteObject(region);
    return HRESULT_FROM_WIN32(GetLastError());
  }
  return S_OK;
}
void DxgiCompositionSurface::resize(UINT width, UINT height) {
  SetWindowPos(m_window, nullptr, std::lround(m_x), std::lround(m_y), width, height,
      SWP_NOZORDER | SWP_NOACTIVATE);
}
}
