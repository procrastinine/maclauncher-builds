import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {helperClientSource} from '../producers/steam-bridge/helper-subset.mjs';
import {createRequire} from 'node:module';
const requirements=createRequire(import.meta.url)('./support/requirements.cjs');
test('managed helper writes only Steam discovery values with its own PID and managed paths',requirements({sourceTree:'sources/steam-bridge-notproton'}),t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-registry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'registry.cpp'),binary=path.join(root,'registry');
 fs.writeFileSync(source, String.raw`#include <cwchar>
#include <string>
#include <map>
#include <unistd.h>
using WCHAR=wchar_t;using DWORD=unsigned long;
#define HKEY_CURRENT_USER 1
#define REG_DWORD 4
#define REG_SZ 1
static std::map<std::wstring,std::wstring> writes;
static DWORD GetCurrentProcessId(){return getpid();}
static DWORD GetEnvironmentVariableW(const WCHAR *name,WCHAR *value,DWORD){
 const WCHAR *path=wcscmp(name,L"MACLAUNCHER_STEAM_CLIENT32")==0?L"D:\\managed\\steamclient.dll":L"D:\\managed\\steamclient64.dll";
 wcscpy(value,path);return wcslen(value);
}
static DWORD GetModuleFileNameW(void*,WCHAR *value,DWORD){wcscpy(value,L"D:\\bridge\\steam.exe");return wcslen(value);}
static int RegSetKeyValueW(int hive,const WCHAR *key,const WCHAR *name,DWORD type,const void *value,DWORD){
 if(hive!=HKEY_CURRENT_USER)return 1;
 writes[std::wstring(key)+L"/"+name]=type==REG_DWORD?std::to_wstring(*(const DWORD*)value):(const WCHAR*)value;return 0;
}
#include "${path.resolve(import.meta.dirname,'../producers/steam-bridge/helper-registry.h')}"
int main(){
 if(!bridge_registry()||writes.size()!=7)return 1;
 const std::wstring active=L"Software\\Valve\\Steam\\ActiveProcess/";
 if(writes[active+L"pid"]!=std::to_wstring(getpid()))return 2;
 if(writes[active+L"SteamPath"]!=L"D:\\managed")return 3;
 if(writes[L"Software\\Valve\\Steam/SteamExe"]!=L"D:\\bridge\\steam.exe")return 4;
 for(const auto &item:writes)if(item.first.rfind(L"Software\\Valve\\Steam",0)!=0)return 5;
 return 0;
}
`);
 execFileSync('clang++',['-std=c++17',source,'-o',binary],{stdio:'pipe'});
 execFileSync(binary,[],{stdio:'pipe'});
 const upstream=fs.readFileSync(new URL('../sources/steam-bridge-notproton/steam-shim/steam.cpp',import.meta.url),'utf8');
 assert.doesNotMatch(helperClientSource(upstream,{upstreamHandshake:true}),/static void set_(?:client_dll_paths|install_paths|active_process_pid)/);
});
