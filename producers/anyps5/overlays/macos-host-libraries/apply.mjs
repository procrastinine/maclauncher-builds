import fs from 'node:fs';
import path from 'node:path';

function replaceOnce(text, before, after, file) {
  if (text.indexOf(before) < 0 || text.indexOf(before) !== text.lastIndexOf(before))
    throw new Error('AnyPS5 macOS host libraries overlay does not match ' + file);
  return text.replace(before, after);
}

export function applyHostLibrariesOverlay(projectionRoot) {
  const changes = [];
  const edit = (relative, adapt) => {
    const file = path.join(projectionRoot, relative);
    const before = fs.readFileSync(file, 'utf8');
    const after = adapt(before, relative);
    if (before !== after) { fs.writeFileSync(file, after); changes.push(relative); }
  };
  const commonHeader = 'core/libs/prx/libc/include/specifics/macos/NetworkInterfaces.hpp';
  fs.writeFileSync(path.join(projectionRoot, commonHeader), fs.readFileSync(new URL('./DarwinNetworkInterfaces.hpp', import.meta.url)));
  changes.push(commonHeader);
  const header = 'core/libs/prx/libSceNetCtl/include/DarwinNetwork.hpp';
  fs.writeFileSync(path.join(projectionRoot, header), fs.readFileSync(new URL('./DarwinNetwork.hpp', import.meta.url)));
  changes.push(header);
  edit('core/libs/prx/libSceNetCtl/Export.cpp', (text, file) => {
    text = replaceOnce(text, '#include <sys/sysctl.h>', '#include <sys/sysctl.h>\n#include "prx/libSceNetCtl/include/DarwinNetwork.hpp"', file);
    text = replaceOnce(text, 'static std::vector<in_addr> HostDnsServers() {\n    std::ifstream config',
      'static std::vector<in_addr> HostDnsServers() {\n#ifdef __APPLE__\n    return DarwinNetwork::DnsServers();\n#else\n    std::ifstream config', file);
    text = replaceOnce(text, '    return servers;\n}\n#endif\n\nstatic bool QueryHostIpv4Interface',
      '    return servers;\n#endif\n}\n#endif\n\nstatic bool QueryHostIpv4Interface', file);
    return replaceOnce(text, '#elif defined(__linux__)\n    ifaddrs* interfaces = nullptr;',
      '#elif defined(__APPLE__)\n    const auto traffic = DarwinNetwork::InterfaceTraffic();\n    sent = traffic.sent;\n    received = traffic.received;\n#elif defined(__linux__)\n    ifaddrs* interfaces = nullptr;', file);
  });
  edit('core/libs/CMakeLists.txt', (text, file) => replaceOnce(text,
    'target_link_libraries(libSceUsbStorageDialog PRIVATE libSceUserService)',
    'target_link_libraries(libSceUsbStorageDialog PRIVATE libSceUserService)\n\nif(APPLE)\n    target_link_libraries(libSceNetCtl PRIVATE "-framework SystemConfiguration" "-framework CoreFoundation")\nendif()', file));
  for (const library of ['libSceMsgDialog', 'libSceErrorDialog']) {
    edit('core/libs/prx/' + library + '/Export.cpp', (text, file) => {
      text = replaceOnce(text, '#ifdef _WIN32\n#include <windows.h>\n#endif',
        '#ifdef _WIN32\n#include <windows.h>\n#elif defined(__APPLE__)\n#include "prx/libc/include/specifics/macos/VirtualMemory.hpp"\n#endif', file);
      return replaceOnce(text, '#else\n    return p != nullptr;\n#endif',
        '#elif defined(__APPLE__)\n    return p != nullptr && DarwinVirtualMemory::MemoryReadable(reinterpret_cast<std::uintptr_t>(p), n);\n#else\n    return p != nullptr;\n#endif', file);
    });
  }
  edit('core/libs/prx/libSceVideoOut/include/PadInput.hpp', (text, file) => {
    text = replaceOnce(text, '    bool MouseModeEnabled() const { return keyboardMouse.MouseMode(); }',
      '    bool MouseModeEnabled() const { return keyboardMouse.MouseMode(); }\n    bool GuestMouseCaptureAllowed() const { return guestMouseCaptureAllowed; }', file);
    return replaceOnce(text, '    Pad::KeyboardMouse keyboardMouse;',
      '#ifdef __APPLE__\n    bool guestMouseCaptureAllowed = false;\n#else\n    bool guestMouseCaptureAllowed = true;\n#endif\n    Pad::KeyboardMouse keyboardMouse;', file);
  });
  edit('core/libs/prx/libSceVideoOut/src/PadInput.cpp', (text, file) => {
    text = replaceOnce(text,
      '    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_MODE_WARP, "0");\n    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE, "0");\n    if (SDL_SetRelativeMouseMode(enabled ? SDL_TRUE : SDL_FALSE) != 0) throw std::runtime_error(std::string("Pad: relative mouse mode failed: ") + SDL_GetError());\n    keyboardMouse.SetMouseMode(enabled);',
      '    keyboardMouse.SetMouseMode(enabled);', file);
    text = replaceOnce(text, '    keyboardMouse.SetTitleReadsMouse(MouseIsOpen_nid_no_patch());',
      '    const bool titleReadsMouse = MouseIsOpen_nid_no_patch();\n    keyboardMouse.SetTitleReadsMouse(titleReadsMouse);', file);
    text = replaceOnce(text, '    if (event.type == SDL_WINDOWEVENT) {\n        if (keyboardMouse.HandleEvent',
      '    if (window.Handle() != nullptr) {\n        const auto windowId = SDL_GetWindowID(window.Handle());\n        switch (event.type) {\n            case SDL_WINDOWEVENT: if (event.window.windowID != windowId) return; break;\n            case SDL_KEYDOWN: case SDL_KEYUP: if (event.key.windowID != windowId) return; break;\n            case SDL_MOUSEMOTION: if (event.motion.windowID != windowId) return; break;\n            case SDL_MOUSEBUTTONDOWN: case SDL_MOUSEBUTTONUP: if (event.button.windowID != windowId) return; break;\n            case SDL_MOUSEWHEEL: if (event.wheel.windowID != windowId) return; break;\n            default: break;\n        }\n    }\n    if (event.type == SDL_WINDOWEVENT) {\n        if (keyboardMouse.HandleEvent', file);
    return replaceOnce(text, '    if (requests.toggleMouse) setMouseMode(!keyboardMouse.MouseMode());',
      '    if (requests.toggleMouse) {\n        if (titleReadsMouse) {\n            guestMouseCaptureAllowed = !guestMouseCaptureAllowed;\n            setMouseMode(false);\n        } else {\n            setMouseMode(!keyboardMouse.MouseMode());\n            guestMouseCaptureAllowed = keyboardMouse.MouseMode();\n        }\n    }', file);
  });
  edit('core/libs/prx/libSceVideoOut/include/MouseInput.hpp', (text, file) => replaceOnce(text,
    '    void UpdateCapture(bool allowed);', '    void UpdateCapture(bool allowed, bool mouseToStick = false);', file));
  edit('core/libs/prx/libSceVideoOut/src/MouseInput.cpp', (text, file) => {
    text = replaceOnce(text, '#include "SDL_mouse.h"', '#include "SDL_mouse.h"\n#include "SDL_hints.h"', file);
    text = replaceOnce(text,
      'void MouseInput::UpdateCapture(bool allowed) {\n    if (!allowed) {\n        captured = false;\n        return;\n    }\n    const bool wanted = CaptureWanted(allowed);',
      'void MouseInput::UpdateCapture(bool allowed, bool mouseToStick) {\n    const bool wanted = focused && (mouseToStick || CaptureWanted(allowed));', file);
    text = replaceOnce(text,
      '    if (wanted == captured && (SDL_GetRelativeMouseMode() == SDL_TRUE) == wanted) return;',
      '    if (wanted == captured && (SDL_GetRelativeMouseMode() == SDL_TRUE) == wanted &&\n        SDL_ShowCursor(SDL_QUERY) == (wanted ? SDL_DISABLE : SDL_ENABLE)) return;\n    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_MODE_WARP, "0");\n    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE, "0");', file);
    return replaceOnce(text, '    int ignoredX = 0;',
      '    SDL_ShowCursor(wanted ? SDL_DISABLE : SDL_ENABLE);\n    int ignoredX = 0;', file);
  });
  edit('core/libs/prx/libSceVideoOut/src/VideoOutDriver.cpp', (text, file) => replaceOnce(text,
    '            OnMainThread([&] { mouseInput->UpdateCapture(!padInput->MouseModeEnabled()); });',
    '            OnMainThread([&] { mouseInput->UpdateCapture(padInput->GuestMouseCaptureAllowed(), padInput->MouseModeEnabled()); });', file));
  edit('core/libs/prx/libkernel_sys/Export.cpp', (text, file) => {
    text = replaceOnce(text, '#include "prx/libc/include/FilesystemError.hpp"',
      '#include "prx/libc/include/FilesystemError.hpp"\n#ifdef __APPLE__\n#include "prx/libc/include/HostErrno.hpp"\n#endif', file);
    text = replaceOnce(text, 'int GuestFileError(int error) {\n    switch (error) {',
      'int GuestFileError(int error) {\n#ifdef __APPLE__\n    return GuestErrnoFromHost_nid_no_patch(error);\n#else\n    switch (error) {', file);
    text = replaceOnce(text, '    default: return GuestEio;\n    }\n}\n\nstd::int64_t Fail',
      '    default: return GuestEio;\n    }\n#endif\n}\n\nstd::int64_t Fail', file);
    text = replaceOnce(text, '    const auto condition = error.default_error_condition();\n    if (condition == std::errc::resource_unavailable_try_again)',
      '    const auto condition = error.default_error_condition();\n#ifdef __APPLE__\n    if (condition.category() == std::generic_category()) return GuestErrnoFromHost_nid_no_patch(condition.value());\n#endif\n    if (condition == std::errc::resource_unavailable_try_again)', file);
    return replaceOnce(text, '    if (::faccessat(fd, ".", X_OK, AT_EACCESS) != 0) return static_cast<int>(Fail(errno));',
      '    if (::faccessat(fd, ".", X_OK, AT_EACCESS) != 0) {\n#ifdef __APPLE__\n        return static_cast<int>(Fail(GuestErrnoFromHost_nid_no_patch(errno)));\n#else\n        return static_cast<int>(Fail(errno));\n#endif\n    }', file);
  });
  edit('core/libs/prx/libSceVideoOut/tests/MouseInput.cpp', (text, file) => {
    text = replaceOnce(text, '    input.UpdateCapture(true);\n    const bool applied = SDL_GetRelativeMouseMode() == SDL_TRUE;\n    input.UpdateCapture(false);',
      '#ifdef __APPLE__\n    input.UpdateCapture(false);\n    Require(SDL_GetRelativeMouseMode() == SDL_FALSE, "macOS starts without relative mouse capture");\n    Require(SDL_ShowCursor(SDL_QUERY) == SDL_ENABLE, "macOS starts with a visible cursor");\n#endif\n    input.UpdateCapture(true);\n    const bool applied = SDL_GetRelativeMouseMode() == SDL_TRUE;\n    input.UpdateCapture(false, true);', file);
    text = replaceOnce(text, '        Require(SDL_SetRelativeMouseMode(SDL_FALSE) == 0, "mouse-to-stick mode could not release relative mode");',
      '        input.UpdateCapture(false);\n        Require(SDL_GetRelativeMouseMode() == SDL_FALSE, "mouse-to-stick mode could not release relative mode");\n        Require(SDL_ShowCursor(SDL_QUERY) == SDL_ENABLE, "releasing mouse-to-stick did not show the cursor");', file);
    return replaceOnce(text, '        Require(SDL_SetRelativeMouseMode(SDL_FALSE) == 0, "relative mouse mode could not be reset");',
      '        Require(SDL_GetRelativeMouseMode() == SDL_FALSE, "guest mouse mode could not release relative mode");\n        Require(SDL_ShowCursor(SDL_QUERY) == SDL_ENABLE, "releasing guest capture did not show the cursor");', file);
  });
  edit('core/libs/prx/libc/src/General.cpp', (text, file) => {
    text = replaceOnce(text, '    const GuestArena::HostWrite guard(destination, bytes);', `#ifdef __APPLE__
    const auto sourceStart = reinterpret_cast<std::uintptr_t>(source);
    if (sourceStart == 0 || bytes > UINTPTR_MAX - sourceStart) return false;
#endif
    const GuestArena::HostWrite guard(destination, bytes);`, file);
    return replaceOnce(text, `    return ::mach_vm_write(::mach_task_self(), reinterpret_cast<mach_vm_address_t>(destination),
        reinterpret_cast<vm_offset_t>(source), static_cast<mach_msg_type_number_t>(bytes)) == KERN_SUCCESS;`, `    for (std::size_t offset = 0; offset < bytes;) {
        const auto count = static_cast<mach_msg_type_number_t>(std::min<std::size_t>(bytes - offset, std::numeric_limits<mach_msg_type_number_t>::max()));
        if (::mach_vm_write(::mach_task_self(), static_cast<mach_vm_address_t>(start + offset),
            static_cast<vm_offset_t>(sourceStart + offset), count) != KERN_SUCCESS) return false;
        offset += count;
    }
    return true;`, file);
  });
  return changes;
}
