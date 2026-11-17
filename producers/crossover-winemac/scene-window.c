/* Copyright (c) MacLauncher contributors.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#if 0
#pragma makedep unix
#endif
#include "config.h"
#include "macdrv.h"
#include "maclauncher_scene_window.h"

extern void *maclauncher_scene_window_retain(void *window);
extern int maclauncher_scene_window_visit(void *window, uintptr_t root_hwnd,
        MacLauncherWineMacWindowCallback1 callback, void *context);

int MacLauncherWineMacWithWindow1(uint64_t value, MacLauncherWineMacWindowCallback1 callback, void *context)
{
    HWND hwnd = (HWND)(uintptr_t)value, root;
    struct macdrv_win_data *data;
    DWORD process_id;
    void *window;

    if (!value || (uint64_t)(uintptr_t)hwnd != value || !callback) return 0;
    if (!NtUserGetWindowThread(hwnd, &process_id) || process_id != GetCurrentProcessId()) return 0;

    /* This is the same child-to-host relation used by
     * macdrv_client_surface_create() and macdrv_client_surface_update(). */
    root = NtUserGetAncestor(hwnd, GA_ROOT);
    if (!root || !NtUserGetWindowThread(root, &process_id) || process_id != GetCurrentProcessId()) return 0;
    if (!(data = get_win_data(root))) return 0;
    window = maclauncher_scene_window_retain(data->cocoa_window);
    release_win_data(data);
    if (!window) return 0;

    return maclauncher_scene_window_visit(window, (uintptr_t)root, callback, context);
}
