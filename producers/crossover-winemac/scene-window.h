/* Copyright (c) MacLauncher contributors.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#ifndef MACLAUNCHER_WINE_SCENE_WINDOW_H
#define MACLAUNCHER_WINE_SCENE_WINDOW_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Native Unix ABI only. hwnd is the selected Wine process's numeric HWND.
 * The callback runs synchronously on macdrv's existing Cocoa thread, outside
 * the window-data lock, with the actual NSWindow retained for its duration.
 * It must not throw, longjmp, encode commands or wait for GPU completion.
 * Call before scene recording, without any lock needed by Cocoa dispatch.
 * Return 1 means exactly one callback ran; the callback's result is separate.
 * Return 0 means no usable same-process window was found. No window is made,
 * shown, focused or activated. Neither native pointer may cross the PE wire. */
typedef void (*MacLauncherWineMacWindowCallback1)(void *context, void *native_window);
__attribute__((visibility("default")))
int MacLauncherWineMacWithWindow1(uint64_t hwnd, MacLauncherWineMacWindowCallback1 callback, void *context);

#ifdef __cplusplus
}
#endif
#endif
