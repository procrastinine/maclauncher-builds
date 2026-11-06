/* Copyright (c) MacLauncher contributors. MIT license. */
#include <windows.h>
#include <winternl.h>
#include "apc-context.h"

/* This section is copied as relocation-free code, never compiled on the host at Play. */
static __attribute__((always_inline)) inline void *find_export(BYTE *base, const char *name)
{
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + ((IMAGE_DOS_HEADER *)base)->e_lfanew);
    if (!nt->OptionalHeader.DataDirectory[0].VirtualAddress || nt->OptionalHeader.DataDirectory[0].Size < sizeof(IMAGE_EXPORT_DIRECTORY)) return NULL;
    IMAGE_EXPORT_DIRECTORY *exports = (IMAGE_EXPORT_DIRECTORY *)(base + nt->OptionalHeader.DataDirectory[0].VirtualAddress);
    DWORD *names = (DWORD *)(base + exports->AddressOfNames), *functions = (DWORD *)(base + exports->AddressOfFunctions);
    WORD *ordinals = (WORD *)(base + exports->AddressOfNameOrdinals);
    for (DWORD i = 0; i < exports->NumberOfNames; ++i)
    {
        const char *candidate = (char *)(base + names[i]);
        unsigned j = 0;
        while (name[j] && name[j] == candidate[j]) ++j;
        if (!name[j] && !candidate[j]) return base + functions[ordinals[i]];
    }
    return NULL;
}

void CALLBACK bridge_apc(ULONG_PTR argument)
{
    struct bridge_apc_context *context = (void *)argument;
    LIST_ENTRY *head = &NtCurrentTeb()->ProcessEnvironmentBlock->Ldr->InMemoryOrderModuleList;
    for (LIST_ENTRY *link = head->Flink; link != head; link = link->Flink)
    {
        LDR_DATA_TABLE_ENTRY *entry = CONTAINING_RECORD(link, LDR_DATA_TABLE_ENTRY, InMemoryOrderLinks);
        BYTE *base = entry->DllBase;
        if (!base) continue;
        // Only ntdll exports both primitives. Resolve by export names, not offsets.
        void *load = find_export(base, context->load_name);
        void *terminate = find_export(base, context->terminate_name);
        if (load && terminate)
        {
            typedef LONG (WINAPI *load_fn)(WCHAR *, ULONG, UNICODE_STRING *, HANDLE *);
            typedef LONG (WINAPI *terminate_fn)(HANDLE, LONG);
            HANDLE module = NULL;
            if (((load_fn)load)(NULL, 0, &context->path, &module) < 0 || !module)
                ((terminate_fn)terminate)((HANDLE)-1, (LONG)0xc0000142);
            return;
        }
    }
    __builtin_trap(); // Bootstrap failure cannot fall through to native Windows Steam.
}
