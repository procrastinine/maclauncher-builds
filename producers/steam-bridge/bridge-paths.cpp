/* Copyright (c) MacLauncher contributors. MIT license. */
#include <string>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include "ntstatus.h"
#define WIN32_NO_STATUS
#include "windef.h"
#include "winbase.h"
#include "winternl.h"

using modern_dos = NTSTATUS (*)(const char *, WCHAR **, UINT);
using modern_unix = NTSTATUS (*)(const WCHAR *, char **, UINT);
using legacy_dos = NTSTATUS (WINAPI *)(const char *, WCHAR *, ULONG *);
using legacy_unix = NTSTATUS (WINAPI *)(const OBJECT_ATTRIBUTES *, char *, ULONG *, UINT);

extern "C" NTSTATUS bridge_get_dos_file_name(const char *path, WCHAR **result, UINT disposition)
{
    *result = nullptr;
    static auto modern = reinterpret_cast<modern_dos>(dlsym(RTLD_DEFAULT, "ntdll_get_dos_file_name"));
    if (modern) return modern(path, result, disposition);
    static auto legacy = reinterpret_cast<legacy_dos>(dlsym(RTLD_DEFAULT, "wine_unix_to_nt_file_name"));
    if (!legacy) return STATUS_NOT_IMPLEMENTED;
    ULONG size = 0;
    NTSTATUS status = legacy(path, nullptr, &size);
    if (status != STATUS_BUFFER_TOO_SMALL || !size || size > 32768) return status;
    auto buffer = static_cast<WCHAR *>(malloc(size * sizeof(WCHAR)));
    if (!buffer) return STATUS_NO_MEMORY;
    status = legacy(path, buffer, &size);
    if (status) { free(buffer); return status; }
    // Both Wine APIs return the same NT prefix; expose the DOS spelling.
    if (buffer[5] == ':') memmove(buffer, buffer + 4, (std::char_traits<WCHAR>::length(buffer + 4) + 1) * sizeof(WCHAR));
    else buffer[1] = '\\';
    *result = buffer;
    return status;
}

extern "C" NTSTATUS bridge_get_unix_file_name(const WCHAR *path, char **result, UINT disposition)
{
    *result = nullptr;
    static auto modern = reinterpret_cast<modern_unix>(dlsym(RTLD_DEFAULT, "ntdll_get_unix_file_name"));
    if (modern) return modern(path, result, disposition);
    static auto legacy = reinterpret_cast<legacy_unix>(dlsym(RTLD_DEFAULT, "wine_nt_to_unix_file_name"));
    if (!legacy) return STATUS_NOT_IMPLEMENTED;
    using text = std::basic_string<WCHAR>;
    text dos(path), nt;
    for (auto &c : dos) if (c == '/') c = '\\';
    const WCHAR nt_prefix[] = {'\\','?','?','\\',0};
    const WCHAR unc_prefix[] = {'\\','?','?','\\','U','N','C','\\',0};
    if (dos.size() >= 4 && dos[0] == '\\' && dos[1] == '?' && dos[2] == '?' && dos[3] == '\\') nt = dos;
    else if (dos.size() >= 4 && dos[0] == '\\' && dos[1] == '\\' && (dos[2] == '?' || dos[2] == '.') && dos[3] == '\\') nt = text(nt_prefix) + dos.substr(4);
    else if (dos.size() >= 2 && dos[0] == '\\' && dos[1] == '\\') nt = text(unc_prefix) + dos.substr(2);
    else
    {
        auto current = NtCurrentTeb()->Peb->ProcessParameters->CurrentDirectory.DosPath;
        text cwd(current.Buffer, current.Length / sizeof(WCHAR));
        if (dos.size() >= 3 && dos[1] == ':' && dos[2] == '\\') nt = text(nt_prefix) + dos;
        else if (!dos.empty() && dos[0] == '\\') nt = text(nt_prefix) + cwd.substr(0, 2) + dos;
        else
        {
            if (dos.size() >= 2 && dos[1] == ':')
            {
                WCHAR drive = dos[0], current_drive = cwd[0];
                if (drive >= 'a' && drive <= 'z') drive -= 32;
                if (current_drive >= 'a' && current_drive <= 'z') current_drive -= 32;
                if (drive != current_drive)
                {
                    cwd.clear();
                    const WCHAR *environment = static_cast<const WCHAR *>(NtCurrentTeb()->Peb->ProcessParameters->Environment);
                    for (const WCHAR *item = environment; item && *item; item += std::char_traits<WCHAR>::length(item) + 1)
                        if (item[0] == '=' && item[1] == drive && item[2] == ':' && item[3] == '=') { cwd = item + 4; break; }
                    if (cwd.empty()) { cwd += drive; cwd += ':'; cwd += '\\'; }
                }
                dos.erase(0, 2);
            }
            if (!cwd.empty() && cwd.back() != '\\') cwd += '\\';
            nt = text(nt_prefix) + cwd + dos;
        }
    }
    if (nt.size() >= 32767) return STATUS_NAME_TOO_LONG;
    UNICODE_STRING name = {static_cast<USHORT>(nt.size() * sizeof(WCHAR)), static_cast<USHORT>((nt.size() + 1) * sizeof(WCHAR)), const_cast<WCHAR *>(nt.data())};
    OBJECT_ATTRIBUTES attr;
    InitializeObjectAttributes(&attr, &name, OBJ_CASE_INSENSITIVE, nullptr, nullptr);
    ULONG size = 0;
    NTSTATUS status = legacy(&attr, nullptr, &size, disposition);
    if (status != STATUS_BUFFER_TOO_SMALL || !size || size > 1024 * 1024) return status;
    auto buffer = static_cast<char *>(malloc(size));
    if (!buffer) return STATUS_NO_MEMORY;
    status = legacy(&attr, buffer, &size, disposition);
    if (status && status != STATUS_NO_SUCH_FILE) { free(buffer); return status; }
    *result = buffer;
    return status;
}
