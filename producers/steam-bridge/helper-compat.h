/* Copyright (c) MacLauncher contributors. MIT license. */
/* Wine's private declarations used by Proton's helper, with MinGW C++ headers. */
#include <windows.h>
#include <winternl.h>
#define DECLSPEC_EXPORT __declspec(dllexport)
#define __WINE_ALLOC_SIZE(...) __attribute__((alloc_size(__VA_ARGS__)))
#define __WINE_MALLOC __attribute__((malloc))
#define __WINE_DEALLOC(...)
#define ARRAY_SIZE(a) (sizeof(a)/sizeof((a)[0]))
#define CP_UNIXCP 65010
extern "C" WCHAR * __cdecl wine_get_dos_file_name(const char *);
#include "posix_compat.h"
typedef struct { UNICODE_STRING ObjectName; UNICODE_STRING ObjectTypeName; } DIRECTORY_BASIC_INFORMATION;
typedef int MEMORY_INFORMATION_CLASS;
extern "C" NTSTATUS NTAPI NtQueryVirtualMemory(HANDLE,LPCVOID,MEMORY_INFORMATION_CLASS,PVOID,SIZE_T,SIZE_T*);
extern "C" NTSTATUS NTAPI NtOpenDirectoryObject(PHANDLE,ACCESS_MASK,const OBJECT_ATTRIBUTES*);
extern "C" NTSTATUS NTAPI NtQueryDirectoryObject(HANDLE,DIRECTORY_BASIC_INFORMATION*,ULONG,BOOLEAN,BOOLEAN,PULONG,PULONG);
