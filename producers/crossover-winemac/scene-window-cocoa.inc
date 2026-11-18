/* Copyright (c) MacLauncher contributors.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 * Included after the matched cocoa_window.m, which owns WineWindow's private
 * closing and HWND properties. No private Objective-C layout is duplicated. */
#include "maclauncher_scene_window.h"

__attribute__((visibility("hidden")))
void *maclauncher_scene_window_retain(void *native_window)
{
    /* Only retain is performed while the caller holds win_data_mutex. */
    return [(WineWindow *)native_window retain];
}

__attribute__((visibility("hidden")))
int maclauncher_scene_window_visit(void *native_window, uintptr_t root_hwnd,
        MacLauncherWineMacWindowCallback1 callback, void *context)
{
    WineWindow *window = (WineWindow *)native_window;
    __block int invoked = 0;
    dispatch_block_t visit = ^{
        @autoreleasepool {
            @try {
                if ([window isKindOfClass:[WineWindow class]] && !window.closing &&
                    window.hwnd == (void *)root_hwnd && window.windowNumber > 0) {
                    callback(context, window);
                    invoked = 1;
                }
            } @finally {
                [window release];
            }
        }
    };

    /* OnMainThread is macdrv's synchronous event/query-aware dispatcher.
     * It enqueues unconditionally, so never call it from the main thread. */
    if (pthread_main_np()) visit();
    else OnMainThread(visit);
    return invoked;
}
