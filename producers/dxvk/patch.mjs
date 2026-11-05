// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
const here = import.meta.dirname;
export function applyComposition(source) {
  function edit(file, from, to) {
    const p = path.join(source, file), text = fs.readFileSync(p, 'utf8');
    if (!text.includes(from)) throw Error(file + ': missing original anchor ' + from);
    fs.writeFileSync(p, text.replace(from, to));
  }
  edit('src/util/util_singleton.h', `    if (!(m_useCount++))
      m_object = new T(constantArgs...);

    return m_object;`, `    if (!m_useCount)
      m_object = new T(constantArgs...);

    ++m_useCount;
    return m_object;`);
  for (const file of ['composition-interface.h','dxgi-composition.h','dxgi-composition.cpp'])
    fs.copyFileSync(path.join(here, file), path.join(source, 'src/dxgi', file));
  edit('src/dxgi/meson.build', "  'dxgi_adapter.cpp',", "  'dxgi_adapter.cpp',\n  'dxgi-composition.cpp',");
  edit('src/dxgi/meson.build', "  dxgi_extra_dep    += [ cpp.find_library('version') ]", "  dxgi_extra_dep    += [ cpp.find_library('version'), cpp.find_library('maclauncher-dcomp', dirs: meson.current_source_dir()) ]");
  edit('src/dxgi/dxgi_factory.cpp', '#include "dxgi_factory.h"', '#include "dxgi_factory.h"\n#include "dxgi-composition.h"');
  edit('src/dxgi/dxgi_factory.cpp', `    if (!m_options->enableDummyCompositionSwapchain) {
      Logger::err("DxgiFactory::CreateSwapChainForComposition: Not implemented");
      return E_NOTIMPL;
    }

    Logger::warn("DxgiFactory::CreateSwapChainForComposition: Creating dummy swap chain");

    return CreateSwapChainBase(pDevice,
      nullptr, pDesc, nullptr, pRestrictToOutput, ppSwapChain);`, `    if (!ppSwapChain || !pDevice || !pDesc || !pDesc->Width || !pDesc->Height)
      return DXGI_ERROR_INVALID_CALL;
    // Native child surfaces provide opaque composition. Per-pixel alpha and
    // arbitrary visual effects require a compositor and are not claimed here.
    if (pDesc->AlphaMode != DXGI_ALPHA_MODE_IGNORE && pDesc->AlphaMode != DXGI_ALPHA_MODE_UNSPECIFIED)
      return DXGI_ERROR_UNSUPPORTED;
    HWND window = DxgiCompositionSurface::createWindow(pDesc->Width, pDesc->Height);
    if (!window) return HRESULT_FROM_WIN32(GetLastError());
    HRESULT hr = CreateSwapChainBase(pDevice, window, pDesc, nullptr,
      pRestrictToOutput, ppSwapChain, true);
    if (FAILED(hr)) DestroyWindow(window);
    return hr;`);
  edit('src/dxgi/dxgi_factory.cpp', '          IDXGISwapChain1**     ppSwapChain) {\n    // Make sure', '          IDXGISwapChain1**     ppSwapChain,\n          bool                  composition) {\n    // Make sure');
  edit('src/dxgi/dxgi_factory.h', '            IDXGISwapChain1**     ppSwapChain);', '            IDXGISwapChain1**     ppSwapChain,\n            bool                  composition = false);');
  edit('src/dxgi/dxgi_factory.cpp', 'new DxgiSwapChain(this, presenter.ptr(), hWnd, &desc, &fsDesc, pDevice)', 'new DxgiSwapChain(this, presenter.ptr(), hWnd, &desc, &fsDesc, pDevice, composition)');
  edit('src/dxgi/dxgi_swapchain.h', '#include "dxgi_interfaces.h"', '#include "dxgi_interfaces.h"\n#include "dxgi-composition.h"');
  edit('src/dxgi/dxgi_swapchain.h', '            IUnknown*                   pDevice);', '            IUnknown*                   pDevice,\n            bool                        composition = false);');
  edit('src/dxgi/dxgi_swapchain.h', '    Com<IDXGIVkSwapChain>           m_presenter;', '    // Declared before presenter refs: their Vulkan surface dies before HWND.\n    std::unique_ptr<DxgiCompositionSurface> m_composition;\n    Com<IDXGIVkSwapChain>           m_presenter;');
  edit('src/dxgi/dxgi_swapchain.cpp', '          IUnknown*                   pDevice)\n', '          IUnknown*                   pDevice,\n          bool                        composition)\n');
  edit('src/dxgi/dxgi_swapchain.cpp', '    m_presentId (0u),', '    m_presentId (0u),\n    m_composition(composition ? new DxgiCompositionSurface(this, hWnd) : nullptr),');
  edit('src/dxgi/dxgi_swapchain.cpp', '    if (riid == __uuidof(ID3DDestructionNotifier)) {', '    if (m_composition && riid == __uuidof(IMacLauncherCompositionSurface)) {\n      *ppvObject = ref(m_composition.get());\n      return S_OK;\n    }\n\n    if (riid == __uuidof(ID3DDestructionNotifier)) {');
  edit('src/dxgi/dxgi_swapchain.cpp', '    *pHwnd = m_window;', '    if (m_composition) { *pHwnd = nullptr; return DXGI_ERROR_INVALID_CALL; }\n    *pHwnd = m_window;');
  edit('src/dxgi/dxgi_swapchain.cpp', '    UpdateSourceSize(m_desc.Width, m_desc.Height);\n    UpdateColorSpace(m_desc.Format, m_colorSpace);\n    return hr;', '    UpdateSourceSize(m_desc.Width, m_desc.Height);\n    UpdateColorSpace(m_desc.Format, m_colorSpace);\n    if (m_composition) m_composition->resize(m_desc.Width, m_desc.Height);\n    return hr;');
}
