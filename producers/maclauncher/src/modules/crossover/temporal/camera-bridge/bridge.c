// SPDX-License-Identifier: MIT
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "protocol.h"
static uint64_t unixHandle;
typedef LONG (WINAPI *QueryMemory)(HANDLE,const void*,unsigned,void*,SIZE_T,SIZE_T*);
typedef LONG (WINAPI *UnixCall)(uint64_t,unsigned,void*);
static UnixCall dispatcher;
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,void* reserved){
    if(reason==DLL_PROCESS_DETACH){
        if(!reserved&&dispatcher){MLTemporalCameraCall call={0};call.size=sizeof(call);call.version=1;dispatcher(unixHandle,1,&call);}
        return TRUE;
    }
    if(reason!=DLL_PROCESS_ATTACH)return TRUE;
    DisableThreadLibraryCalls(module);
    HMODULE ntdll=GetModuleHandleW(L"ntdll.dll");
    QueryMemory query=(QueryMemory)GetProcAddress(ntdll,"NtQueryVirtualMemory");
    UnixCall* entry=(UnixCall*)GetProcAddress(ntdll,"__wine_unix_call_dispatcher");
    if(!query||!entry)return FALSE;
    dispatcher=*entry;
    return query(GetCurrentProcess(),module,1000,&unixHandle,sizeof(unixHandle),NULL)==0;
}
__declspec(dllexport) int __cdecl MacLauncherSetTemporalCamera(const RSTemporalCamera* camera){
    if(!camera||!dispatcher)return 0;
    MLTemporalCameraCall call={0};call.size=sizeof(call);call.version=1;call.camera=*camera;
    return dispatcher(unixHandle,0,&call)==0&&call.accepted;
}
__declspec(dllexport) void __cdecl MacLauncherClearTemporalCamera(void){
    if(!dispatcher)return;
    MLTemporalCameraCall call={0};call.size=sizeof(call);call.version=1;dispatcher(unixHandle,1,&call);
}
