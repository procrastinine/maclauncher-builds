/* Copyright (c) MacLauncher contributors. MIT license. */
#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <wchar.h>

static void unsupported_export(void)
{
    fputs("Steam bridge: unsupported Windows client export; stopping before native execution\n", stderr);
    fflush(stderr);
    TerminateProcess(GetCurrentProcess(), 125);
}
static int inside(DWORD rva, SIZE_T size, DWORD image_size)
{
    return rva < image_size && size <= image_size - rva;
}
static int executable(IMAGE_NT_HEADERS *nt, DWORD rva, SIZE_T size)
{
    IMAGE_SECTION_HEADER *section = IMAGE_FIRST_SECTION(nt);
    for (unsigned i = 0; i < nt->FileHeader.NumberOfSections; ++i)
        if ((section[i].Characteristics & IMAGE_SCN_MEM_EXECUTE) && rva >= section[i].VirtualAddress &&
            rva - section[i].VirtualAddress < section[i].Misc.VirtualSize &&
            size <= section[i].Misc.VirtualSize - (rva - section[i].VirtualAddress)) return 1;
    return 0;
}
static int prepare(HMODULE self)
{
    WCHAR filename[32768];
    DWORD length = GetModuleFileNameW(self, filename, 32768);
    if (!length || length >= 32768) return 0;
    WCHAR *last = wcsrchr(filename, L'\\');
    if (!last) return 0;
#ifdef _WIN64
    const WCHAR name[] = L"steamclient64.dll";
#else
    const WCHAR name[] = L"steamclient.dll";
#endif
    if ((last - filename) + 1 + (sizeof(name) / sizeof(WCHAR)) >= 32768) return 0;
    wcscpy(last + 1, name);
    // Windows Steam initialization is never run. This is the exported loader
    // equivalent of the fork's LDR_DONT_RESOLVE_REFS internal loader flag.
    if (GetModuleHandleW(name)) return 0;
    HMODULE genuine = LoadLibraryExW(filename, NULL, DONT_RESOLVE_DLL_REFERENCES);
    HMODULE bridge = genuine ? LoadLibraryW(L"lsteamclient.dll") : NULL;
    if (!genuine || !bridge) return 0;
    BYTE *base = (BYTE *)genuine;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || nt->Signature != IMAGE_NT_SIGNATURE) return 0;
    DWORD image_size = nt->OptionalHeader.SizeOfImage;
    IMAGE_DATA_DIRECTORY directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
    if (!inside(directory.VirtualAddress, directory.Size, image_size) || directory.Size < sizeof(IMAGE_EXPORT_DIRECTORY)) return 0;
    IMAGE_EXPORT_DIRECTORY *exports = (IMAGE_EXPORT_DIRECTORY *)(base + directory.VirtualAddress);
    if (exports->NumberOfNames > image_size / sizeof(DWORD) || exports->NumberOfFunctions > image_size / sizeof(DWORD)) return 0;
    if (!inside(exports->AddressOfNames, exports->NumberOfNames * sizeof(DWORD), image_size) ||
        !inside(exports->AddressOfFunctions, exports->NumberOfFunctions * sizeof(DWORD), image_size) ||
        !inside(exports->AddressOfNameOrdinals, exports->NumberOfNames * sizeof(WORD), image_size)) return 0;
    DWORD *names = (DWORD *)(base + exports->AddressOfNames), *functions = (DWORD *)(base + exports->AddressOfFunctions);
    WORD *ordinals = (WORD *)(base + exports->AddressOfNameOrdinals);
    unsigned routed = 0, blocked = 0;
    for (DWORD i = 0; i < exports->NumberOfNames; ++i)
    {
        if (ordinals[i] >= exports->NumberOfFunctions || !inside(names[i], 1, image_size)) return 0;
        const char *export_name = (char *)(base + names[i]);
        if (!memchr(export_name, 0, image_size - names[i])) return 0;
        DWORD rva = functions[ordinals[i]];
        if (!rva) continue;
        if (rva >= directory.VirtualAddress && rva - directory.VirtualAddress < directory.Size) return 0;
#ifdef _WIN64
        const unsigned jump_size = 12;
#else
        const unsigned jump_size = 5;
#endif
        if (!executable(nt, rva, jump_size)) continue; // Preserve data exports.
        // Refuse overlapping exported entry points instead of corrupting a neighbor.
        for (DWORD j = 0; j < exports->NumberOfFunctions; ++j)
            if (functions[j] > rva && functions[j] - rva < jump_size) return 0;
        FARPROC target = GetProcAddress(bridge, export_name);
        if (target) ++routed;
        else { target = (FARPROC)unsupported_export; ++blocked; }
        BYTE jump[12];
#ifdef _WIN64
        jump[0] = 0x48; jump[1] = 0xb8;
        uintptr_t address = (uintptr_t)target;
        memcpy(jump + 2, &address, sizeof(address));
        jump[10] = 0xff; jump[11] = 0xe0;
#else
        jump[0] = 0xe9;
        DWORD displacement = (DWORD)((uintptr_t)target - (uintptr_t)(base + rva) - 5);
        memcpy(jump + 1, &displacement, sizeof(displacement));
#endif
        DWORD old, discarded;
        if (!VirtualProtect(base + rva, jump_size, PAGE_EXECUTE_READWRITE, &old)) return 0;
        memcpy(base + rva, jump, jump_size);
        if (!FlushInstructionCache(GetCurrentProcess(), base + rva, jump_size) ||
            !VirtualProtect(base + rva, jump_size, old, &discarded)) return 0;
    }
    fprintf(stderr, "Steam bridge: genuine image=%p size=%lu routed=%u blocked=%u before program entry\n", genuine, image_size, routed, blocked);
    fflush(stderr);
    return routed && GetProcAddress(genuine, "CreateInterface");
}
BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, void *reserved)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        DisableThreadLibraryCalls(module);
        if (!prepare(module))
        {
            fputs("Steam bridge: owned loader preparation failed; stopping before native Windows Steam initialization\n", stderr);
            fflush(stderr);
            TerminateProcess(GetCurrentProcess(), 125);
            return FALSE;
        }
    }
    return TRUE;
}
