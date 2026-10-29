import fs from 'node:fs';
import path from 'node:path';

function replaceOnce(text, before, after, file) {
  if (text.indexOf(before) < 0 || text.indexOf(before) !== text.lastIndexOf(before))
    throw new Error('AnyPS5 mouse routing overlay does not match ' + file);
  return text.replace(before, after);
}

export function applyScancodeAliases(text, file = 'InputMapping.cpp') {
  text = replaceOnce(text, 'Pad::InputBinding parseBinding(const InputAction& action, std::string_view source) {', `SDL_Scancode inputScancode(const std::string& name) {
    const auto native = SDL_GetScancodeFromName(name.c_str());
    if (native != SDL_SCANCODE_UNKNOWN) return native;
    // SDL's video backends rename these entries after initialization. Stored
    // bindings retain the same scancode across host names and startup order.
    struct Alias { std::string_view name; SDL_Scancode code; };
    static constexpr auto aliases = std::array{
        Alias{"LEFT ALT", SDL_SCANCODE_LALT}, Alias{"RIGHT ALT", SDL_SCANCODE_RALT},
        Alias{"LEFT OPTION", SDL_SCANCODE_LALT}, Alias{"RIGHT OPTION", SDL_SCANCODE_RALT},
        Alias{"LEFT GUI", SDL_SCANCODE_LGUI}, Alias{"RIGHT GUI", SDL_SCANCODE_RGUI},
        Alias{"LEFT COMMAND", SDL_SCANCODE_LGUI}, Alias{"RIGHT COMMAND", SDL_SCANCODE_RGUI},
        Alias{"LEFT WINDOWS", SDL_SCANCODE_LGUI}, Alias{"RIGHT WINDOWS", SDL_SCANCODE_RGUI},
        Alias{"APPLICATION", SDL_SCANCODE_APPLICATION}, Alias{"MENU", SDL_SCANCODE_APPLICATION}
    };
    const auto normalized = upper(name);
    for (const auto& alias : aliases) if (alias.name == normalized) return alias.code;
    return SDL_SCANCODE_UNKNOWN;
}

Pad::InputBinding parseBinding(const InputAction& action, std::string_view source) {`, file);
  return replaceOnce(text, 'const auto key = SDL_GetScancodeFromName(keyName.c_str());',
    'const auto key = inputScancode(keyName);', file);
}

export function applyMouseRoutingOverlay(projectionRoot) {
  const changes = [];
  const edit = (relative, adapt) => {
    const file = path.join(projectionRoot, relative);
    const before = fs.readFileSync(file, 'utf8');
    const after = adapt(before, relative);
    if (before !== after) { fs.writeFileSync(file, after); changes.push(relative); }
  };
  edit('core/libs/prx/libScePad/include/InputMapping.hpp', (text, file) => {
    text = replaceOnce(text, 'struct InputSettings {',
      'enum class MouseRouting { Automatic, Controller, Native };\n\nstruct InputSettings {\n#ifdef __APPLE__\n    MouseRouting mouseRouting = MouseRouting::Controller;\n#else\n    MouseRouting mouseRouting = MouseRouting::Automatic;\n#endif', file);
    text = replaceOnce(text, '    InputBinding{SDL_SCANCODE_RETURN,', '    InputBinding{SDL_SCANCODE_K, MouseButton::None, InputControl::Button, PadButton::Cross},\n    InputBinding{SDL_SCANCODE_J, MouseButton::None, InputControl::Button, PadButton::Square},\n    InputBinding{SDL_SCANCODE_L, MouseButton::None, InputControl::Button, PadButton::Circle},\n    InputBinding{SDL_SCANCODE_U, MouseButton::None, InputControl::Button, PadButton::R2},\n    InputBinding{SDL_SCANCODE_V, MouseButton::None, InputControl::Button, PadButton::TouchPad},\n    InputBinding{SDL_SCANCODE_RETURN,', file);
    text = replaceOnce(text, 'MouseButton::Left, InputControl::Button, PadButton::Square', 'MouseButton::Left, InputControl::Button, PadButton::R2', file);
    text = replaceOnce(text, 'MouseButton::Right, InputControl::Button, PadButton::R2', 'MouseButton::Right, InputControl::Button, PadButton::Square', file);
    return replaceOnce(text, 'struct InputConfiguration {',
      'inline bool UsesNativeMouse(const InputSettings& settings, bool opened) {\n    return settings.mouseRouting == MouseRouting::Native ||\n        (settings.mouseRouting == MouseRouting::Automatic && opened);\n}\n\nstruct InputConfiguration {', file);
  });
  edit('core/libs/prx/libSceVideoOut/src/InputMapping.cpp', (text, file) => {
    text = applyScancodeAliases(text, file);
    text = replaceOnce(text, '    InputAction{"Square", Pad::InputControl::Button, Pad::PadButton::Square},', '    InputAction{"Square", Pad::InputControl::Button, Pad::PadButton::Square},\n    InputAction{"TouchPad", Pad::InputControl::Button, Pad::PadButton::TouchPad},', file);
    return replaceOnce(text,
    '    auto& bindings = configuration.bindings;',
    '    if (const char* routing = std::getenv("ANYPS5_MOUSE_ROUTING")) {\n        const auto value = upper(trim(routing));\n        if (value == "CONTROLLER") configuration.settings.mouseRouting = MouseRouting::Controller;\n        else if (value == "NATIVE") configuration.settings.mouseRouting = MouseRouting::Native;\n        else if (value == "AUTOMATIC") configuration.settings.mouseRouting = MouseRouting::Automatic;\n        else throw std::runtime_error("Pad: ANYPS5_MOUSE_ROUTING must be controller, native or automatic");\n    }\n    auto& bindings = configuration.bindings;', file);
  });
  edit('core/libs/prx/libScePad/include/KeyboardMouse.hpp', (text, file) => {
    text = replaceOnce(text, '    bool MouseMode() const;',
      '    bool MouseMode() const;\n    bool NativeMouseEnabled() const;\n    bool ConsumesNativeMouseEvent(const SDL_Event& event) const;', file);
    return replaceOnce(text, '    bool titleReadsMouse = false;',
      '    bool titleReadsMouse = false;\n    bool focused = true;', file);
  });
  edit('core/libs/prx/libSceVideoOut/src/KeyboardMouse.cpp', (text, file) => {
    text = replaceOnce(text,
      'void Pad::KeyboardMouse::SetTitleReadsMouse(bool reads) {\n    titleReadsMouse = reads;\n}',
      'bool Pad::KeyboardMouse::NativeMouseEnabled() const {\n    return UsesNativeMouse(configuration.settings, titleReadsMouse);\n}\n\nbool Pad::KeyboardMouse::ConsumesNativeMouseEvent(const SDL_Event& event) const {\n    if (configuration.settings.mouseRouting != MouseRouting::Native ||\n        (event.type != SDL_MOUSEBUTTONDOWN && event.type != SDL_MOUSEBUTTONUP)) return false;\n    return std::any_of(configuration.bindings.begin(), configuration.bindings.end(), [&](const InputBinding& binding) {\n        return binding.control == InputControl::ToggleMouse && binding.mouseButton != MouseButton::None &&\n            binding.mouseButton == static_cast<MouseButton>(event.button.button);\n    });\n}\n\nvoid Pad::KeyboardMouse::SetTitleReadsMouse(bool reads) {\n    const bool wasNative = NativeMouseEnabled();\n    titleReadsMouse = reads;\n    if (wasNative == NativeMouseEnabled()) return;\n    for (std::size_t index = 0; index < configuration.bindings.size(); ++index) {\n        const auto& binding = configuration.bindings[index];\n        if (binding.mouseButton == MouseButton::None && binding.wheelDirection == 0) continue;\n        pressed[index] = false;\n        wheelReleaseTimes[index] = {};\n    }\n    mouse.Reset();\n    if (NativeMouseEnabled()) mouseMode = false;\n}', file);
    text = replaceOnce(text,
      '        if (event.window.event != SDL_WINDOWEVENT_FOCUS_LOST && event.window.event != SDL_WINDOWEVENT_CLOSE) return requests;\n        Release();',
      '        if (event.window.event == SDL_WINDOWEVENT_FOCUS_GAINED) { focused = true; return requests; }\n        if (event.window.event != SDL_WINDOWEVENT_FOCUS_LOST && event.window.event != SDL_WINDOWEVENT_CLOSE) return requests;\n        focused = false;\n        Release();', file);
    text = replaceOnce(text, '    if (event.type == SDL_MOUSEMOTION) {\n        if (mouseMode && !titleReadsMouse)',
      '    if (!focused) return requests;\n    if (event.type == SDL_MOUSEMOTION) {\n        if (mouseMode && !NativeMouseEnabled())', file);
    text = replaceOnce(text, '        if (titleReadsMouse) return requests;',
      '        if (NativeMouseEnabled()) return requests;', file);
    text = replaceOnce(text, '    if (event.type == SDL_MOUSEBUTTONDOWN && titleReadsMouse) return requests;\n', '', file);
    return replaceOnce(text, '        if (!matches) continue;',
      '        if (!matches) continue;\n        if (mouseButton && NativeMouseEnabled() &&\n            (configuration.settings.mouseRouting != MouseRouting::Native || binding.control != InputControl::ToggleMouse)) continue;', file);
  });
  edit('core/libs/prx/libSceVideoOut/include/PadInput.hpp', (text, file) => replaceOnce(text,
    '    bool GuestMouseCaptureAllowed() const { return guestMouseCaptureAllowed; }',
    '    bool GuestMouseCaptureAllowed() const { return guestMouseCaptureAllowed; }\n    bool NativeMouseEnabled() const;\n    bool ConsumesNativeMouseEvent(const SDL_Event& event) const { return keyboardMouse.ConsumesNativeMouseEvent(event); }', file));
  edit('core/libs/prx/libSceVideoOut/src/PadInput.cpp', (text, file) => {
    text = replaceOnce(text, 'void PadInput::setMouseMode(bool enabled) {',
      'bool PadInput::NativeMouseEnabled() const {\n    return Pad::UsesNativeMouse(keyboardMouse.Configuration().settings, MouseIsOpen_nid_no_patch());\n}\n\nvoid PadInput::setMouseMode(bool enabled) {', file);
    text = replaceOnce(text, '        if (titleReadsMouse) {\n            guestMouseCaptureAllowed',
      '        if (NativeMouseEnabled()) {\n            guestMouseCaptureAllowed', file);
    return replaceOnce(text, 'void PadInput::Update(const DisplayWindow& window) {',
      'void PadInput::Update(const DisplayWindow& window) {\n    keyboardMouse.SetTitleReadsMouse(MouseIsOpen_nid_no_patch());', file);
  });
  edit('core/libs/prx/libSceVideoOut/include/MouseInput.hpp', (text, file) => {
    text = replaceOnce(text, '    void HandleEvent(const SDL_Event& event, unsigned windowId);',
      '    void HandleEvent(const SDL_Event& event, unsigned windowId);\n    void SetEnabled(bool value);', file);
    return replaceOnce(text, '    bool focused = true;', '    bool enabled = true;\n    bool focused = true;', file);
  });
  edit('core/libs/prx/libSceVideoOut/src/MouseInput.cpp', (text, file) => {
    text = replaceOnce(text, 'void MouseInput::HandleEvent(const SDL_Event& event, unsigned windowId) {',
      'void MouseInput::SetEnabled(bool value) {\n    if (enabled && !value) {\n        MouseInputEvent reset{};\n        reset.resetButtons = true;\n        MousePublishInput_nid_no_patch(reset);\n    }\n    if (enabled != value) { remainderX = 0.0; remainderY = 0.0; }\n    enabled = value;\n}\n\nvoid MouseInput::HandleEvent(const SDL_Event& event, unsigned windowId) {\n    if (!enabled && event.type != SDL_WINDOWEVENT) return;', file);
    return replaceOnce(text, '    return allowed && focused && MouseIsOpen_nid_no_patch();',
      '    return enabled && allowed && focused && MouseIsOpen_nid_no_patch();', file);
  });
  edit('core/libs/prx/libSceVideoOut/src/VideoOutDriver.cpp', (text, file) => {
    text = replaceOnce(text, '                        mouseInput->HandleEvent(event, SDL_GetWindowID(window.Handle()));',
      '                        mouseInput->SetEnabled(padInput->NativeMouseEnabled());\n                        if (!padInput->ConsumesNativeMouseEvent(event)) mouseInput->HandleEvent(event, SDL_GetWindowID(window.Handle()));', file);
    return replaceOnce(text, '            OnMainThread([&] { mouseInput->UpdateCapture(padInput->GuestMouseCaptureAllowed(), padInput->MouseModeEnabled()); });',
      '            OnMainThread([&] {\n                mouseInput->SetEnabled(padInput->NativeMouseEnabled());\n                mouseInput->UpdateCapture(padInput->NativeMouseEnabled() && padInput->GuestMouseCaptureAllowed(), padInput->MouseModeEnabled());\n            });', file);
  });
  return changes;
}
