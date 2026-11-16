// SPDX-License-Identifier: MIT
// Creates effect-plan.temporal-camera (ngx_late_camera.h) beside RESHADE_EFFECT_PLAN, clears it for this process and maps
// it once for writing.
#pragma once
#include <windows.h>
#include <string>
#include "ngx_late_camera.h"

namespace ngx_late_camera {
// The file beside RESHADE_EFFECT_PLAN, created or cleared and mapped once for writing; null without an effect plan.
class File {
  Mailbox *mailbox_ = nullptr;

public:
  File() noexcept {
    try {
      wchar_t plan[32768];
      const DWORD n = GetEnvironmentVariableW(L"RESHADE_EFFECT_PLAN", plan, 32768);
      if (!n || n >= 32768)
        return;
      const int count = WideCharToMultiByte(CP_UTF8, 0, plan, int(n), nullptr, 0, nullptr, nullptr);
      if (count <= 0)
        return;
      std::string path(size_t(count), '\0');
      WideCharToMultiByte(CP_UTF8, 0, plan, int(n), path.data(), count, nullptr, nullptr);
      const auto slash = path.find_last_of('/');
      if (slash == std::string::npos)
        return;
      path.resize(slash + 1);
      path += "effect-plan.temporal-camera";
      const auto convert = reinterpret_cast<WCHAR *(CDECL *)(LPCSTR)>(
          GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "wine_get_dos_file_name"));
      if (!convert)
        return;
      WCHAR *dos = convert(path.c_str());
      if (!dos)
        return;
      const HANDLE file = CreateFileW(dos, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                      OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
      HeapFree(GetProcessHeap(), 0, dos);
      if (file == INVALID_HANDLE_VALUE)
        return;
      LARGE_INTEGER size{};
      HANDLE mapping = nullptr;
      if (GetFileSizeEx(file, &size) && size.QuadPart != fileSize) {
        LARGE_INTEGER end{};
        end.QuadPart = fileSize;
        if (!SetFilePointerEx(file, end, nullptr, FILE_BEGIN) || !SetEndOfFile(file))
          size.QuadPart = 0;
        else
          size.QuadPart = fileSize;
      }
      if (size.QuadPart == fileSize)
        mapping = CreateFileMappingW(file, nullptr, PAGE_READWRITE, 0, 0, nullptr);
      CloseHandle(file);
      if (!mapping)
        return;
      mailbox_ = static_cast<Mailbox *>(MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, fileSize));
      CloseHandle(mapping);
      // an earlier process's records never reach this one: a reader skips a slot whose sequence is 0
      if (mailbox_)
        std::memset(static_cast<void *>(mailbox_), 0, fileSize);
    } catch (...) {
    }
  }
  ~File() {
    if (mailbox_)
      UnmapViewOfFile(mailbox_);
  }
  File(const File &) = delete;
  File &operator=(const File &) = delete;
  Mailbox *get() const noexcept { return mailbox_; }
};
} // namespace ngx_late_camera
