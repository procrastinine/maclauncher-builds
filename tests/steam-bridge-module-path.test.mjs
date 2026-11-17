import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// The bootstrap records the path each bridge module was loaded from as its
// module file name, so the name opens the same file. SteamStub opens the
// Steam client's file by that name before program entry.
test('bridge modules record the path they were loaded from as their module file name',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-module-path-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'module-path.cpp'),binary=path.join(root,'module-path');
 fs.writeFileSync(source,String.raw`#include <cwchar>
#include <cstdlib>
#include <cstring>
using WCHAR=wchar_t;using ULONG=unsigned long;using USHORT=unsigned short;using NTSTATUS=long;using ULONG_PTR=unsigned long;
using HMODULE=void*;using HANDLE=void*;
#define WINAPI
struct LIST_ENTRY{LIST_ENTRY *next,*previous;};
struct UNICODE_STRING{USHORT Length,MaximumLength;WCHAR *Buffer;};
static int locks,unlocks,frees,lock_status;
static HMODULE loaded=(HMODULE)0x10000;
struct bridge_module_entry;static bridge_module_entry *table;
static HMODULE GetModuleHandleW(const WCHAR *){return (HMODULE)1;}
static HANDLE GetProcessHeap(){return (HANDLE)1;}
static void *HeapAlloc(HANDLE,ULONG,size_t size){return malloc(size);}
static int HeapFree(HANDLE,ULONG,void *memory){++frees;free(memory);return 1;}
static NTSTATUS WINAPI find(const void *,bridge_module_entry **entry){*entry=table;return table?0:-1;}
static NTSTATUS WINAPI lock(ULONG,ULONG *,ULONG_PTR *cookie){if(lock_status)return lock_status;++locks;*cookie=7;return 0;}
static NTSTATUS WINAPI unlock(ULONG,ULONG_PTR cookie){if(cookie==7)++unlocks;return 0;}
static void *GetProcAddress(HMODULE,const char *name){
 if(!strcmp(name,"LdrFindEntryForAddress"))return (void*)find;
 if(!strcmp(name,"LdrLockLoaderLock"))return (void*)lock;
 if(!strcmp(name,"LdrUnlockLoaderLock"))return (void*)unlock;
 return nullptr;
}
#include "${path.resolve(import.meta.dirname,'../producers/steam-bridge/module-path.h')}"
static UNICODE_STRING text(const WCHAR *value){WCHAR *copy=wcsdup(value);USHORT length=(USHORT)(wcslen(copy)*sizeof(WCHAR));return {length,(USHORT)(length+sizeof(WCHAR)),copy};}
static bool same(const UNICODE_STRING &value,const WCHAR *expected){return value.Length==wcslen(expected)*sizeof(WCHAR)&&!wmemcmp(value.Buffer,expected,wcslen(expected));}
int main(){
 const WCHAR *device=L"\\\\?\\unix\\Users\\player\\runtimes\\steamclient64.dll";
 bridge_module_entry entry={};entry.base=loaded;
 // Wine's name for a module loaded through a \\?\unix\ path: no drive, no prefix.
 entry.full_name=text(L"unix\\Users\\player\\runtimes\\steamclient64.dll");
 entry.base_name={(USHORT)(17*sizeof(WCHAR)),(USHORT)(18*sizeof(WCHAR)),entry.full_name.Buffer+(wcslen(entry.full_name.Buffer)-17)};table=&entry;
 if(!bridge_record_module_path(loaded,device))return 1;
 if(!same(entry.full_name,device)||entry.full_name.MaximumLength!=entry.full_name.Length+sizeof(WCHAR))return 2;
 if(!same(entry.base_name,L"steamclient64.dll"))return 3;
 if(entry.base_name.Buffer<entry.full_name.Buffer||entry.base_name.Buffer>entry.full_name.Buffer+wcslen(device))return 4;
 if(locks!=1||unlocks!=1||frees)return 5;
 // A module already recorded under the path keeps its name and buffer.
 WCHAR *recorded=entry.full_name.Buffer;
 if(!bridge_record_module_path(loaded,device)||entry.full_name.Buffer!=recorded||frees!=1)return 6;
 // An address the loader maps to another module changes nothing.
 bridge_module_entry other={};other.base=(HMODULE)0x20000;other.full_name=text(L"C:\\windows\\system32\\other.dll");table=&other;
 if(bridge_record_module_path(loaded,device)||!same(other.full_name,L"C:\\windows\\system32\\other.dll"))return 7;
 // Without the loader lock nothing is changed.
 table=&entry;lock_status=-1;
 if(bridge_record_module_path(loaded,L"D:\\other\\steamclient64.dll")||entry.full_name.Buffer!=recorded)return 8;
 return locks==3&&unlocks==3?0:9;
}
`);
 execFileSync('clang++',['-std=c++17','-Wno-writable-strings',source,'-o',binary],{stdio:'pipe'});
 execFileSync(binary,[],{stdio:'pipe'});
});

test('the bootstrap records the client, bridge and bootstrap paths before routing exports',()=>{
 const loader=fs.readFileSync(new URL('../producers/steam-bridge/loader.c',import.meta.url),'utf8');
 const record=loader.indexOf('bridge_record_module_path(genuine, filename)'),route=loader.indexOf('GetProcAddress(bridge, export_name)');
 assert.ok(record>0&&record<route);
 assert.match(loader,/bridge_record_module_path\(bridge, builtin\)/);
 assert.match(loader,/bridge_record_module_path\(self, bootstrap\)/);
});
