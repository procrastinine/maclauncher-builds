/* Copyright (c) MacLauncher contributors. MIT license. */
#pragma once
/* Only Steam discovery entries are written. The genuine client owns login,
 * subscription and ticket results. No prefix files or machine settings. */
static bool bridge_registry(void)
{
    WCHAR client32[32768], client64[32768], helper[32768], directory[32768];
    DWORD len32 = GetEnvironmentVariableW(L"MACLAUNCHER_STEAM_CLIENT32", client32, 32768);
    DWORD len64 = GetEnvironmentVariableW(L"MACLAUNCHER_STEAM_CLIENT64", client64, 32768);
    DWORD lenexe = GetModuleFileNameW(NULL, helper, 32768);
    if (!len32 || len32 >= 32768 || !len64 || len64 >= 32768 || !lenexe || lenexe >= 32768) return false;
    wcscpy(directory, client64);
    WCHAR *last = wcsrchr(directory, L'\\');
    if (!last) return false;
    *last = 0;
    const WCHAR *active = L"Software\\Valve\\Steam\\ActiveProcess";
    const WCHAR *steam = L"Software\\Valve\\Steam";
    struct entry { const WCHAR *key, *name, *value; } entries[] = {
        {active, L"SteamClientDll", client32}, {active, L"SteamClientDll64", client64},
        {active, L"SteamPath", directory}, {active, L"Universe", L"Public"},
        {steam, L"SteamPath", directory}, {steam, L"SteamExe", helper}
    };
    DWORD pid = GetCurrentProcessId();
    if (RegSetKeyValueW(HKEY_CURRENT_USER, active, L"pid", REG_DWORD, &pid, sizeof(pid))) return false;
    for (const auto &entry : entries)
        if (RegSetKeyValueW(HKEY_CURRENT_USER, entry.key, entry.name, REG_SZ, entry.value,
                           (DWORD)(wcslen(entry.value) + 1) * sizeof(WCHAR))) return false;
    return true;
}
