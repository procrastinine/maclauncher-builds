// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {addLicense,addLicenses} from '../../lib/licenses.mjs';
const here=import.meta.dirname,pins=JSON.parse(fs.readFileSync(path.join(here,'source.json')));
const winePin=JSON.parse(fs.readFileSync(path.resolve(here,pins.winePin))),toolchain=JSON.parse(fs.readFileSync(path.resolve(here,pins.toolchainPin))).toolchain;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const run=(c,a,o={})=>execFileSync(c,a,{stdio:'inherit',...o});
const capture=(c,a,o={})=>execFileSync(c,a,{encoding:'utf8',...o}).trim();
const mkdir=p=>fs.mkdirSync(p,{recursive:true});
const put=(p,b)=>{mkdir(path.dirname(p));fs.writeFileSync(p,b);};
const copy=(a,b)=>{mkdir(path.dirname(b));fs.cpSync(a,b,{recursive:true});};
const walk=d=>fs.readdirSync(d,{recursive:true}).filter(p=>fs.statSync(path.join(d,p)).isFile()).sort();
function verify(file,want){if(hash(fs.readFileSync(file))!==want)throw Error('Source digest mismatch: '+file);}
function treeDigest(dir){const h=crypto.createHash('sha256');for(const p of walk(dir)){h.update(Buffer.from(hash(Buffer.from(p)),'hex'));h.update(Buffer.from(hash(fs.readFileSync(path.join(dir,p))),'hex'));}return h.digest('hex');}
function fetch(url,file){if(!fs.existsSync(file)){mkdir(path.dirname(file));run('curl',['-fLsS',url,'-o',file+'.part']);fs.renameSync(file+'.part',file);}return file;}
function archive(repo,commit,name,work){const file=fetch(repo.replace('https://github.com/','https://codeload.github.com/')+'/tar.gz/'+commit,path.join(work,name+'.tar.gz'));const dir=path.join(work,name);if(!fs.existsSync(dir)){mkdir(dir);run('tar',['xzf',file,'--strip-components=1','-C',dir]);}return dir;}
export function prepare(work){
 mkdir(work);
 const proton=archive(pins.proton.repository,pins.proton.commit,'proton',work);
 if(treeDigest(path.join(proton,'lsteamclient'))!==pins.proton.lsteamclientDigest)throw Error('Proton extracted lsteamclient digest differs');
 for(const [p,h]of Object.entries(pins.proton.steamHelperFiles))verify(path.join(proton,'steam_helper',p),h);
 const np=archive(pins.notproton.repository,pins.notproton.commit,'notproton',work);
 for(const [p,h]of Object.entries(pins.notproton.files))verify(path.join(np,p),h);
 const wineArchive=fetch(winePin.archive.url,path.join(work,'crossover.tar.gz'));verify(wineArchive,winePin.archive.sha256);
 const base=path.join(work,'wine-original');if(!fs.existsSync(base)){mkdir(base);run('tar',['xzf',wineArchive,'--strip-components=2','-C',base,winePin.archive.directory]);}
 for(const p of ['include/wine/unixlib.h','configure.ac'])verify(path.join(base,p),winePin.originalFiles[p]);
 const source=path.join(work,'wine');if(fs.existsSync(source))throw Error('Use a fresh work directory; source assembly is immutable');
 copy(base,source);
 const lsc=path.join(source,'dlls/lsteamclient');copy(path.join(proton,'lsteamclient'),lsc);
 for(const p of ['steamclient_main.c','unix_steam_input_manual.cpp','unixlib.cpp'])copy(path.join(np,'lsteamclient',p),path.join(lsc,p));
 // Native Steam may be absent; preserve the upstream null-result failure path without asserting.
 const main=path.join(lsc,'steamclient_main.c'),original='if (STEAMCLIENT_CALL( steamclient_init, &params )) return 0;';
 const text=fs.readFileSync(main,'utf8');if(!text.includes(original))throw Error('The pinned initialization boundary changed');
 put(main,text.replace(original,'if (steamclient_call( unix_steamclient_init, &params, "steamclient_init" )) return 0;'));
 mkdir(path.join(lsc,'steamworks_sdk_165x'));
 for(const p of ['steamtypes.h','steamclientpublic.h','steamnetworkingtypes.h','steamuniverse.h'])copy(path.join(lsc,'steamworks_sdk_165',p),path.join(lsc,'steamworks_sdk_165x',p));
 copy(path.join(np,'lsteamclient/steamworks_sdk_165x/isteamnetworkingsocketsserialized.h'),path.join(lsc,'steamworks_sdk_165x/isteamnetworkingsocketsserialized.h'));
 run('patch',['-p1','--forward','-i',path.join(np,'lsteamclient/serialized005.patch')],{cwd:lsc});
 const shim=path.join(source,'programs/steam.exe');mkdir(shim);
 for(const p of Object.keys(pins.notproton.files).filter(p=>p.startsWith('steam-shim/')))copy(path.join(np,p),path.join(shim,p.slice(11)));
 copy(path.join(lsc,'steamworks_sdk_142'),path.join(shim,'proton-headers/steamworks_sdk_142'));
 for(const h of pins.headers)for(const [p,digest]of Object.entries(h.files)){
  const project=h.repository.split('/').pop(),file=fetch(h.repository.replace('github.com','raw.githubusercontent.com')+'/'+h.commit+'/'+p,path.join(work,'headers',project,p));verify(file,digest);copy(file,path.join(shim,'proton-headers',project,p));
 }
 // Wine 11.0 makedep does not classify .cpp unix-only sources. Build them explicitly.
 const mf=path.join(lsc,'Makefile.in');put(path.join(work,'unix-sources.json'),JSON.stringify([...fs.readFileSync(mf,'utf8').matchAll(/^\s*([A-Za-z0-9_]+\.cpp)\s*\\?\s*$/gm)].map(m=>m[1])));put(mf,fs.readFileSync(mf,'utf8').replace(/^\s*[A-Za-z0-9_]+\.cpp\s*\\?\s*$/gm,''));
 // Register only the owned components, in the disposable assembly.
 let ac=fs.readFileSync(path.join(source,'configure.ac'),'utf8');ac+='\nWINE_CONFIG_MAKEFILE(dlls/lsteamclient)\nWINE_CONFIG_MAKEFILE(programs/steam.exe)\n';put(path.join(source,'configure.ac'),ac);
 // Wine requires registrations before AC_OUTPUT.
 ac=ac.replace(/\nWINE_CONFIG_MAKEFILE\(dlls\/lsteamclient\)[\s\S]*$/,'');
 ac=ac.replace('AC_OUTPUT','WINE_CONFIG_MAKEFILE(dlls/lsteamclient)\nWINE_CONFIG_MAKEFILE(programs/steam.exe)\nAC_OUTPUT');put(path.join(source,'configure.ac'),ac);
 run('autoconf',[],{cwd:source});
 put(path.join(work,'inputs.json'),JSON.stringify({pins,wine: winePin.archive,toolchain,extracted:{lsteamclient:treeDigest(path.join(proton,'lsteamclient')),steamHelper:treeDigest(path.join(proton,'steam_helper')),overlay: Object.fromEntries(Object.keys(pins.notproton.files).map(p=>[p,hash(fs.readFileSync(path.join(np,p)))]))}},null,2)+'\n');
 return source;
}
export function build({work,mingw,output}){
 const source=path.join(work,'wine');if(!fs.existsSync(path.join(work,'inputs.json')))prepare(work);
 const nativeCC=capture('xcrun',['--find','clang']),nativeCXX=capture('xcrun',['--find','clang++']);
 const environment={...process.env,SDKROOT:capture('xcrun',['--sdk','macosx','--show-sdk-path']),CFLAGS:'-O2',CPPFLAGS:'',LDFLAGS:'',PATH:mingw+':/opt/homebrew/opt/bison/bin:/opt/homebrew/bin:'+process.env.PATH,MACOSX_DEPLOYMENT_TARGET:pins.minimumMacOS};
 for(const arch of ['x86_64','arm64']){
  const dir=path.join(work,'build-'+arch);mkdir(dir);
  if(!fs.existsSync(path.join(dir,'Makefile')))run('/bin/sh',[path.join(source,'configure'),'--host='+(arch==='arm64'?'aarch64':arch)+'-apple-darwin','--enable-archs=i386,x86_64','--disable-tests','--without-x','--without-freetype','CC='+nativeCC+' -arch '+arch,'CXX='+nativeCXX+' -arch '+arch],{cwd:dir,env:environment});
  const targets=['dlls/ntdll/ntdll.so',...(arch==='x86_64'?['dlls/lsteamclient/i386-windows/lsteamclient.dll','dlls/lsteamclient/x86_64-windows/lsteamclient.dll']:[])];
  run('make',['-j2',...targets],{cwd:dir,env:environment});
  const dll='dlls/lsteamclient',src=path.join(source,dll),objs=[];
  const sources=JSON.parse(fs.readFileSync(path.join(work,'unix-sources.json')));
  for(const cpp of sources){const obj=path.join(dir,dll,cpp+'.o');if(!fs.existsSync(obj)||fs.statSync(obj).mtimeMs<fs.statSync(path.join(src,cpp)).mtimeMs)run(nativeCXX,['-DNOMINMAX','-include','cwchar','-arch',arch,'-mmacosx-version-min='+pins.minimumMacOS,'-I'+path.join(dir,dll),'-I'+src,'-I'+path.join(dir,'include'),'-I'+path.join(source,'include'),'-D__WINESRC__','-DSTEAM_API_EXPORTS','-Dprivate=public','-Dprotected=public','-DWINE_UNIX_LIB','-fPIC','-O2','-c',path.join(src,cpp),'-o',obj],{env:environment});objs.push(obj);}
  run(nativeCXX,['-arch',arch,'-mmacosx-version-min='+pins.minimumMacOS,'-dynamiclib','-install_name','@rpath/lsteamclient.so','-Wl,-rpath,@loader_path/',...objs,path.join(dir,'dlls/ntdll/ntdll.so'),'-Wl,-undefined,dynamic_lookup','-o',path.join(dir,dll,'lsteamclient.so')],{env:environment});
 }
 return packageOutput({work,mingw,output});
}
export function packageOutput({work,mingw,output}) {
 const source=path.join(work,'wine');
 const shim=path.join(source,'programs/steam.exe'),pe=path.join(work,'build-x86_64');
 run(path.join(mingw,'x86_64-w64-mingw32-clang++'),['-std=c++17','-D__WINESRC__','-DWINE_NO_LONG_TYPES','-DPATH_MAX=4096','-include',path.join(here,'helper-compat.h'),'-I'+shim,'-I'+path.join(shim,'proton-headers/steamworks_sdk_142'),'-I'+path.join(shim,'proton-headers/openvr/headers'),'-I'+path.join(shim,'proton-headers/wine/include'),'-idirafter',path.join(source,'include'),path.join(shim,'steam.cpp'),path.join(shim,'jsoncpp.cpp'),'-static','-Wl,--no-insert-timestamp','-ladvapi32','-lshlwapi','-lshell32','-lmsi','-luser32',path.join(pe,'dlls/ntdll/x86_64-windows/libntdll.a'),path.join(pe,'dlls/kernel32/x86_64-windows/libkernel32.a'),'-o',path.join(work,'steam.exe')]);
 for(const arch of ['x86_64','arm64']){const unresolved=capture('nm',['-u',path.join(work,'build-'+arch,'dlls/lsteamclient/lsteamclient.so')]);if(/^_(?:wow64_|ISteam|steamclient_)/m.test(unresolved))throw Error('Unresolved bridge implementation symbols');}
 if(fs.existsSync(output))throw Error('Package output already exists');mkdir(output);
 for(const arch of ['x86_64','arm64']){const file=path.join(work,'build-'+arch,'dlls/lsteamclient/lsteamclient.so');if(capture('lipo',['-archs',file])!==arch)throw Error('Unix architecture mismatch');copy(file,path.join(output,arch==='arm64'?'aarch64-unix':'x86_64-unix','lsteamclient.so'));}
 for(const arch of ['i386','x86_64']){
  copy(path.join(work,'build-x86_64/dlls/lsteamclient',arch+'-windows/lsteamclient.dll'),path.join(output,arch+'-windows/lsteamclient.dll'));
  const table=capture(path.join(mingw,'llvm-readobj'),['--coff-exports',path.join(output,arch+'-windows/lsteamclient.dll')]);
  const exports=[...table.matchAll(/Ordinal: (\d+)\s+Name: (\w+)/g)];
  if(!exports.some(m=>m[2]==='CreateInterface'))throw Error('Missing bridge exports');
  const name=arch==='i386'?'steamclient':'steamclient64',def=path.join(work,name+'.def');put(def,'LIBRARY '+name+'\nEXPORTS\n'+exports.map(m=>m[2]+'=lsteamclient.'+m[2]+' @'+m[1]).join('\n')+'\n');
  run(path.join(mingw,(arch==='i386'?'i686':'x86_64')+'-w64-mingw32-clang'),['-shared','-nostdlib','-Wl,--entry,'+(arch==='i386'?'_DllMain@12':'DllMain'),'-Wl,--no-insert-timestamp','-Wl,--out-implib,'+path.join(work,name+'.lib'),path.join(here,'forwarder.c'),def,'-o',path.join(output,arch+'-windows',name+'.dll')]);
 }
 copy(path.join(work,'steam.exe'),path.join(output,'steam.exe'));
 addLicense(output,'lsteamclient and Steamworks SDK',path.join(source,'dlls/lsteamclient/LICENSE'),'Steamworks-SDK');
 addLicense(output,'steam_helper',path.join(work,'notproton/steam-shim/LICENSE'),'BSD-3-Clause');
 addLicense(output,'Wine headers',path.join(source,'COPYING.LIB'),'LGPL-2.1');
 addLicense(output,'OpenVR',path.join(work,'headers/openvr/LICENSE'),'BSD-3-Clause');
 addLicense(output,'JsonCpp',path.join(here,'licenses/JsonCpp.txt'),'JsonCpp');
 const files=walk(output).map(p=>({path:p,mode:fs.statSync(path.join(output,p)).mode & 0o777,size:fs.statSync(path.join(output,p)).size,sha256:hash(fs.readFileSync(path.join(output,p)))}));
 const manifest={schemaVersion:1,managerId:pins.id,version:pins.version,platform:'darwin',arch:'universal',minimumMacOS:pins.minimumMacOS,executableRelative:'steam.exe',files,dependencies:[]};
 put(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const mf=path.join(output,'manifest.json');
 const declaration={id:pins.id,version:pins.version,arch:'universal',launcherArchitectures:['arm64','x64'],minimumMacOS:pins.minimumMacOS,sourceRelative:null,sourceSha256:hash(fs.readFileSync(path.join(here,'source.json'))),directoryRelative:[pins.id,pins.version,'universal'].join('/'),manifestRelative:'manifest.json',manifestSha256:hash(fs.readFileSync(mf)),files:[...files,{path:'manifest.json',mode:0o644,size:fs.statSync(mf).size,sha256:hash(fs.readFileSync(mf))}]};
 put(path.join(path.dirname(output),path.basename(output)+'-runtime-package.json'),JSON.stringify(declaration,null,2)+'\n');
 return declaration;
}
const args=process.argv.slice(2);if(args.length){const [mode,work,mingw,output]=args;if(mode==='prepare')prepare(path.resolve(work));else if(mode==='package')packageOutput({work:path.resolve(work),mingw:path.resolve(mingw),output:path.resolve(output)});else if(mode==='build')build({work:path.resolve(work),mingw:path.resolve(mingw),output:path.resolve(output)});else throw Error('Usage: build.mjs prepare WORK | build WORK MINGW_BIN OUTPUT');}
