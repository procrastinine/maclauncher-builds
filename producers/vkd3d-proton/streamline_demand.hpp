// SPDX-License-Identifier: MIT
#pragma once
#include <windows.h>
#include <string>
namespace ngx_streamline {
// The launcher changes this stable file in place, including rollback. There
// is one startup mapping attempt and no watcher, polling or frame-time I/O.
class SceneDemand {
  const unsigned char *byte=nullptr;
public:
  SceneDemand() noexcept {try {
    wchar_t plan[32768];const DWORD n=GetEnvironmentVariableW(L"RESHADE_EFFECT_PLAN",plan,32768);if(!n||n>=32768)return;
    const int count=WideCharToMultiByte(CP_UTF8,0,plan,int(n),nullptr,0,nullptr,nullptr);if(count<=0)return;
    std::string path(size_t(count),'\0');WideCharToMultiByte(CP_UTF8,0,plan,int(n),path.data(),count,nullptr,nullptr);
    const auto slash=path.find_last_of('/');if(slash==std::string::npos)return;path.resize(slash+1);path+="effect-plan.scene-demand";
    const auto convert=reinterpret_cast<WCHAR*(CDECL*)(LPCSTR)>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"),"wine_get_dos_file_name"));if(!convert)return;
    WCHAR *dos=convert(path.c_str());if(!dos)return;
    const HANDLE file=CreateFileW(dos,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);HeapFree(GetProcessHeap(),0,dos);if(file==INVALID_HANDLE_VALUE)return;
    LARGE_INTEGER size{};HANDLE mapping=nullptr;if(GetFileSizeEx(file,&size)&&size.QuadPart==1)mapping=CreateFileMappingW(file,nullptr,PAGE_READONLY,0,0,nullptr);CloseHandle(file);if(!mapping)return;
    byte=static_cast<const unsigned char*>(MapViewOfFile(mapping,FILE_MAP_READ,0,0,1));CloseHandle(mapping);
  }catch(...) {}}
  ~SceneDemand(){if(byte)UnmapViewOfFile(byte);}
  bool active()const noexcept{return byte&&__atomic_load_n(byte,__ATOMIC_ACQUIRE)=='1';}
};
}
