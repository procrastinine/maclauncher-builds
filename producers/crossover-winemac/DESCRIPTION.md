# CrossOver Vulkan macOS driver

The `maclauncher-crossover-winemac` package supplies the x86_64 Unix macOS driver built from the public CrossOver 26.3 source archive. Its device-extension callback maps external memory, semaphore and fence extension names between Windows and FD forms, using Wine's existing X11 mappings. These mappings do not implement native external-resource transport or make unsupported handle types available.

The package is an optional managed dependency for Vulkan launches. Its manifest declares one matching CrossOver release, build and native interface profile. An incompatible installation uses its original driver. It has no standalone executable or runtime selection. The Windows driver component, winevulkan, win32u and wineserver remain supplied by CrossOver. The profile does not apply to a Sikarugir engine with a different or unidentified Wine source ABI.

## Native window callback

`scene-window.h` declares the native Unix entry point:

```c
int MacLauncherWineMacWithWindow1(uint64_t hwnd,
    void (*callback)(void *context, void *native_window), void *context);
```

The numeric HWND belongs to the selected Wine process. The helper checks that the HWND and its root are owned by that process. Child windows use the same `NtUserGetAncestor(hwnd, GA_ROOT)` relationship as macdrv's client surface creation and update. The helper retains the actual mapped `WineWindow` while `get_win_data` holds the driver's window-data mutex, then releases the mutex before invoking the callback. It does not reinterpret the HWND as a native pointer.

The callback runs synchronously on the existing Cocoa thread. A main-thread caller executes directly; other callers use Wine's event/query-aware `OnMainThread` dispatcher. The callback runs only for a nonclosing mapped window with the same root HWND and a valid native window number. The retained window is released after the callback. No window is created, shown, focused or activated, and no foreground-window lookup or separate window registry is used.

A return value of 1 means the callback ran exactly once. A value of 0 means no usable matching window was found. The callback records its own result in its native context; helper invocation does not establish scene registration, provider availability or output fulfillment. The callback and context remain in the Unix process and do not cross a Windows PE transport.

Calls occur before scene command recording, without a caller lock required by Cocoa dispatch. The callback performs metadata registration only: it does not encode commands, commit, wait for GPU completion, throw or transfer control with `longjmp`.

For deferred scene producers, the callback passes the actual native window to `rsSetRecordedSceneDestination3(native_factory_owner, native_window)`. The existing native consumer captures its weak window authority, then associates it with the actual frame and textures received during later API3 encoding. A caller that already has the exact native source tuple can use `rsSetTemporalSceneDestinationForTextures` instead. Actual final DXGI HWND and scene-output associations come from the cooperating producer; the scene image is not assumed to be a swapchain image. Missing or ambiguous associations retain the original operation.

The producer clears the common destination association at reset, owner destruction and the next producer-frame boundary before registering the next destination. Common scene and flight owners retain their own textures and command resources. This helper's lease covers the synchronous window callback only and does not keep a user window alive after it is closed.

## Source recipe

The adaptation retains the six external-FD mapping statements and adds one isolated native-window module. A separate `cocoa_window.m` adaptation releases the Metal view inside the synchronous main-thread request without retaining it through the request block, and releases directly when already on the Cocoa main thread; the native-window module is appended to that adapted file. The exact source archive, driver map, Cocoa class and dispatcher inputs are pinned. Source provenance covers the callback implementation, header and source projection; `capabilities.nativeInterfaces.sceneWindow` mirrors the same ABI and entry point in the ordinary manifest/catalog metadata. No application version list is introduced. Wine's LGPL terms and authors are collected with the standard package licence helper.

Build with `node producers/crossover-winemac/build.mjs --project maclauncher-crossover-winemac --version 26.3.0-MCLv1 --arch x64 --output OUTPUT --work WORK`. The recipe fetches its declared source and compiler inputs, exports them into WORK, and builds only `dlls/winemac.drv/winemac.so`. No installed CrossOver files are build inputs or modified.
