/* Copyright (c) MacLauncher contributors. MIT license. */
#pragma once
/* Wine names a module loaded through a \\?\unix\ device path after its NT
 * path without the \??\ prefix, "unix\...". That relative name does not open
 * the file again. Before program entry, SteamStub opens the file of the module
 * that exports CreateInterface by its module file name and compares it with
 * the loaded image. Each module the bridge loads by path therefore records the
 * path it was loaded from, which opens the same file. */
typedef struct bridge_module_entry
{
    LIST_ENTRY links[3];
    void *base;
    void *entry_point;
    ULONG image_size;
    UNICODE_STRING full_name;
    UNICODE_STRING base_name;
} bridge_module_entry;

typedef NTSTATUS (WINAPI *bridge_find_entry)(const void *, bridge_module_entry **);
typedef NTSTATUS (WINAPI *bridge_lock_loader)(ULONG, ULONG *, ULONG_PTR *);
typedef NTSTATUS (WINAPI *bridge_unlock_loader)(ULONG, ULONG_PTR);

static int bridge_record_module_path(HMODULE module, const WCHAR *path)
{
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    bridge_find_entry find = ntdll ? (bridge_find_entry)(void *)GetProcAddress(ntdll, "LdrFindEntryForAddress") : NULL;
    bridge_lock_loader lock = ntdll ? (bridge_lock_loader)(void *)GetProcAddress(ntdll, "LdrLockLoaderLock") : NULL;
    bridge_unlock_loader unlock = ntdll ? (bridge_unlock_loader)(void *)GetProcAddress(ntdll, "LdrUnlockLoaderLock") : NULL;
    size_t length = wcslen(path);
    if (!module || !find || !lock || !unlock || !length || length >= 32767) return 0;
    WCHAR *copy = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, (length + 1) * sizeof(WCHAR));
    if (!copy) return 0;
    memcpy(copy, path, (length + 1) * sizeof(WCHAR));
    const WCHAR *separator = wcsrchr(copy, L'\\');
    WCHAR *name = separator ? (WCHAR *)separator + 1 : copy;
    ULONG_PTR cookie = 0;
    bridge_module_entry *entry = NULL;
    int recorded = 0;
    if (lock(0, NULL, &cookie)) { HeapFree(GetProcessHeap(), 0, copy); return 0; }
    if (!find(module, &entry) && entry && entry->base == (void *)module)
    {
        if (entry->full_name.Length == length * sizeof(WCHAR) && entry->full_name.Buffer &&
            !memcmp(entry->full_name.Buffer, path, length * sizeof(WCHAR)))
            recorded = 1;
        else
        {
            // The loader frees the full name when the module unloads; the
            // base name points into it. The earlier name stays allocated.
            entry->full_name.Buffer = copy;
            entry->full_name.Length = (USHORT)(length * sizeof(WCHAR));
            entry->full_name.MaximumLength = (USHORT)((length + 1) * sizeof(WCHAR));
            entry->base_name.Buffer = name;
            entry->base_name.Length = (USHORT)(wcslen(name) * sizeof(WCHAR));
            entry->base_name.MaximumLength = (USHORT)(entry->base_name.Length + sizeof(WCHAR));
            copy = NULL;
            recorded = 1;
        }
    }
    unlock(0, cookie);
    if (copy) HeapFree(GetProcessHeap(), 0, copy);
    return recorded;
}
