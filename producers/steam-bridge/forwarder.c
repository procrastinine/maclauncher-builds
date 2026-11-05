/* Copyright (c) MacLauncher contributors. MIT license. */
#include <windows.h>
#include "forwarder-arena.h"
/* Explicit initialized-data placement is required: upstream uses SizeOfRawData,
 * so a virtual-only .bss reservation cannot satisfy its allocator. Every byte
 * starts at zero. The volatile read retains this non-exported arena at link. */
__attribute__((section(".data"), used, aligned(16)))
static volatile unsigned char interface_arena[STEAM_BRIDGE_ARENA_BYTES] = {0};
BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved)
{
    (void)module; (void)reason; (void)reserved;
    (void)interface_arena[0];
    return TRUE;
}
