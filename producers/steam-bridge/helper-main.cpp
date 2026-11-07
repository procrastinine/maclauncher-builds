/* Copyright (c) MacLauncher contributors. MIT license. */
#include <string>
#include "helper-command-line.h"
#include "helper-client.inc"
#include "helper-registry.h"
bool bridge_bootstrap_child(PROCESS_INFORMATION &child);


int wmain(int argc, WCHAR **argv)
{
    if (argc < 2 || !GetEnvironmentVariableW(L"SteamGameId", NULL, 0)) return 2;
    // Only direct file launches are supported; no shell dispatch is performed.
    DWORD attributes = GetFileAttributesW(argv[1]);
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY)) return 2;

    WCHAR bootstrap[32768];
    DWORD bootstrap_length = GetEnvironmentVariableW(L"MACLAUNCHER_STEAM_BOOTSTRAP", bootstrap, 32768);
    if (!bootstrap_length || bootstrap_length >= 32768 || !LoadLibraryW(bootstrap)) return 125;
    if (!bridge_registry()) return 125;

#ifdef STEAM_BRIDGE_UPSTREAM_HANDSHAKE
    HANDLE master = CreateEventA(NULL, FALSE, FALSE, "Steam3Master_SharedMemLock");
    HANDLE ipc = CreateEventA(NULL, FALSE, FALSE, "Global\\Valve_SteamIPC_Class");
    HANDLE handshake_thread = NULL;
#endif
    HANDLE ready = CreateEventW(NULL, TRUE, FALSE, NULL);
    DWORD window_thread_id = 0;
    HANDLE window_thread = ready ? CreateThread(NULL, 0, create_steam_window, ready, 0, &window_thread_id) : NULL;
    HANDLE waits[] = { ready, window_thread };
    DWORD result = 1;
    PROCESS_INFORMATION child = {};
    if (!ready || !window_thread || WaitForMultipleObjects(2, waits, FALSE, 15000) != WAIT_OBJECT_0)
    {
        WINE_ERR("Discovery window initialization failed.\n");
        goto cleanup;
    }
    if (!steam_client_init())
    {
        WINE_ERR("Real Steam client initialization failed.\n");
        goto cleanup;
    }
    // Match the upstream helper: release its setup connection before the child.
    steam_client_shutdown();
    {
        std::wstring command = bridge_child_command_line(GetCommandLineW());
        STARTUPINFOW startup = { sizeof(startup) };
        if (!CreateProcessW(argv[1], command.data(), NULL, NULL, FALSE, CREATE_SUSPENDED, NULL, NULL, &startup, &child))
        {
            WINE_ERR("Child creation failed, error %lu.\n", GetLastError());
            goto cleanup;
        }
        if (!bridge_bootstrap_child(child))
        {
            TerminateProcess(child.hProcess, 125);
            WaitForSingleObject(child.hProcess, 5000);
            result = 125;
            goto cleanup;
        }
        fprintf(stderr, "Steam helper pid=%lu child=%lu; real-client initialization succeeded\n",
                GetCurrentProcessId(), child.dwProcessId);
        fflush(stderr);
#ifdef STEAM_BRIDGE_UPSTREAM_HANDSHAKE
        handshake_thread = CreateThread(NULL, 0, steam_drm_thread, child.hProcess, 0, NULL);
#endif
        if (WaitForSingleObject(child.hProcess, INFINITE) == WAIT_OBJECT_0)
            GetExitCodeProcess(child.hProcess, &result);
    }
cleanup:
#ifdef STEAM_BRIDGE_UPSTREAM_HANDSHAKE
    if (handshake_thread) CloseHandle(handshake_thread);
    if (master) CloseHandle(master);
    if (ipc) CloseHandle(ipc);
#endif
    steam_client_shutdown();
    if (child.hThread) CloseHandle(child.hThread);
    if (child.hProcess) CloseHandle(child.hProcess);
    if (window_thread)
    {
        PostThreadMessageW(window_thread_id, WM_QUIT, 0, 0);
        WaitForSingleObject(window_thread, 5000);
        CloseHandle(window_thread);
    }
    if (ready) CloseHandle(ready);
    return result;
}
