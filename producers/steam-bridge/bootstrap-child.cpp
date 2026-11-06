/* Copyright (c) MacLauncher contributors. MIT license. */
#include <windows.h>
#include <winternl.h>
#include <cstring>
#include <vector>
#include "apc-context.h"
#include "apc-code.h"

bool bridge_bootstrap_child(PROCESS_INFORMATION &child)
{
    WCHAR dll[32768];
    DWORD length = GetEnvironmentVariableW(L"MACLAUNCHER_STEAM_BOOTSTRAP", dll, 32768);
    if (!length || length >= 32768) return false;
    SIZE_T bytes = offsetof(bridge_apc_context, dll_path) + (length + 1) * sizeof(WCHAR);
    std::vector<unsigned char> storage(bytes);
    auto context = reinterpret_cast<bridge_apc_context *>(storage.data());
    strcpy(context->load_name, "LdrLoadDll");
    strcpy(context->terminate_name, "NtTerminateProcess");
    memcpy(context->dll_path, dll, (length + 1) * sizeof(WCHAR));
    void *remote_context = VirtualAllocEx(child.hProcess, NULL, bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    void *remote_code = VirtualAllocEx(child.hProcess, NULL, sizeof(bridge_apc_code), MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (!remote_context || !remote_code) return false;
    context->path.Length = length * sizeof(WCHAR);
    context->path.MaximumLength = (length + 1) * sizeof(WCHAR);
    context->path.Buffer = reinterpret_cast<WCHAR *>(static_cast<BYTE *>(remote_context) + offsetof(bridge_apc_context, dll_path));
    DWORD old;
    return WriteProcessMemory(child.hProcess, remote_context, context, bytes, NULL) &&
           WriteProcessMemory(child.hProcess, remote_code, bridge_apc_code, sizeof(bridge_apc_code), NULL) &&
           VirtualProtectEx(child.hProcess, remote_code, sizeof(bridge_apc_code), PAGE_EXECUTE_READ, &old) &&
           FlushInstructionCache(child.hProcess, remote_code, sizeof(bridge_apc_code)) &&
           QueueUserAPC(reinterpret_cast<PAPCFUNC>(remote_code), child.hThread, reinterpret_cast<ULONG_PTR>(remote_context)) &&
           ResumeThread(child.hThread) != (DWORD)-1;
}
