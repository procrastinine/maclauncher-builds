import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('the helper preserves Windows argv and raw quoted values in the child command line',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'steam-command-line-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 // Compile the parser from the declared Wine input; do not duplicate its
 // quote/backslash rules in the test or start a Wine/Steam process.
 const upstream=fs.readFileSync(new URL('../sources/steam-bridge-wine-headers/dlls/shcore/main.c',import.meta.url),'utf8');
 const begin=upstream.indexOf('WCHAR** WINAPI CommandLineToArgvW('),end=upstream.indexOf('\nstruct shstream',begin);
 assert.ok(begin>=0&&end>begin);
 const cases=[
  {line:String.raw`"C:\Games\My Game.exe" -ExecCmds="a b" "two words" "embedded \"quote\"" "C:\space dir\\" C:\plain\ ""`,
   argv:[String.raw`C:\Games\My Game.exe`,'-ExecCmds=a b','two words','embedded "quote"','C:\\space dir\\','C:\\plain\\','']},
  {line:String.raw`game.exe "-ExecCmds=\"a b\"" plain -flag=one\"two "space and slash\\\\" C:\plain\\`,
   argv:['game.exe','-ExecCmds="a b"','plain','-flag=one"two','space and slash\\\\',String.raw`C:\plain\\`]},
  {line:'game.exe\t"tab\tvalue"\t""\tend\\',argv:['game.exe','tab\tvalue','','end\\']}
 ];
 const cpp=value=>'L'+JSON.stringify(value);
 const rows=cases.map(item=>'{'+cpp(item.line)+',{'+item.argv.map(cpp).join(',')+'}}').join(',\n');
 const source=path.join(root,'command.cpp'),binary=path.join(root,'command');
 fs.writeFileSync(source,String.raw`#include <string>
#include <vector>
#include <cwchar>
#include <cstdlib>
#include <cstdio>
using WCHAR=wchar_t;using DWORD=unsigned int;
#define WINAPI
#define MAX_PATH 260
#define ERROR_INVALID_PARAMETER 87
#define LMEM_FIXED 0
static void SetLastError(unsigned){}
static WCHAR **LocalAlloc(unsigned,size_t n){return static_cast<WCHAR **>(malloc(n));}
static void LocalFree(void *p){free(p);}
static DWORD GetModuleFileNameW(int,wchar_t *s,DWORD){wcscpy(s,L"test.exe");return 8;}
#define lstrlenW wcslen
#define lstrcpyW wcscpy
${upstream.slice(begin,end)}
#include "${path.resolve(import.meta.dirname,'../producers/steam-bridge/helper-command-line.h')}"
int main(){
 struct entry { std::wstring line;std::vector<std::wstring> argv; };
 const std::vector<entry> cases={${rows}};
 const std::vector<std::wstring> helpers={L"steam.exe ",L"\"C:\\Managed files\\steam.exe\"\t  "};
 unsigned checked=0;
 for(const auto &item:cases)for(const auto &helper:helpers){
  const std::wstring original=helper+item.line;
  const std::wstring child=bridge_child_command_line(original.c_str());
  if(child!=item.line){fputs("raw child command line changed\n",stderr);return 1;}
  int original_count=0,child_count=0;
  WCHAR **parent=CommandLineToArgvW(original.c_str(),&original_count);
  WCHAR **parsed=CommandLineToArgvW(child.c_str(),&child_count);
  if(child_count!=(int)item.argv.size()||original_count!=child_count+1)return 2;
  for(int i=0;i<child_count;++i){
   if(item.argv[i]!=parsed[i]||wcscmp(parent[i+1],parsed[i])){
    fwprintf(stderr,L"case %u argument %d expected [%ls], child [%ls], original [%ls]\n",checked,i,item.argv[i].c_str(),parsed[i],parent[i+1]);return 3;
   }
  }
  LocalFree(parent);LocalFree(parsed);++checked;
 }
 if(*bridge_child_command_line(L"steam.exe")||*bridge_child_command_line(L"\"steam.exe\"\t"))return 4;
 printf("Windows argv and raw command-line cases: %u PASS\n",checked);
}
`);
 execFileSync('clang++',['-std=c++17','-Wall','-Wextra',source,'-o',binary],{stdio:'pipe'});
 assert.equal(execFileSync(binary,[],{encoding:'utf8'}),'Windows argv and raw command-line cases: 6 PASS\n');
 const helper=fs.readFileSync(new URL('../producers/steam-bridge/helper-main.cpp',import.meta.url),'utf8');
 assert.match(helper,/std::wstring command = bridge_child_command_line\(GetCommandLineW\(\)\)/);
 assert.match(helper,/CreateProcessW\(argv\[1\], command.data\(\)/);
 assert.doesNotMatch(helper,/quote_argument/);
});
