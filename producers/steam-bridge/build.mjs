// Copyright (c) MacLauncher contributors. MIT license.
import sharedDependencies from '../dependencies.json' with {type:'json'};
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {recipeMain} from '../../tools/build-source.mjs';
import {mingw as prepareMingw} from '../../tools/scene-runtime.mjs';
import {addLicense} from '../../lib/licenses.mjs';
import {gitlink} from '../../lib/pins.mjs';
import {helperClientSource} from './helper-subset.mjs';
import {buildHelpers} from './helper-build.mjs';
const here=import.meta.dirname,root=path.resolve(here,'../..'),pins=JSON.parse(fs.readFileSync(path.join(here,'source.json')));
const winePin={archive:sharedDependencies[pins.wineDependency]},toolchain=sharedDependencies[pins.toolchainDependency];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const run=(c,a,o={})=>execFileSync(c,a,{stdio:'inherit',...o});
const capture=(c,a,o={})=>execFileSync(c,a,{encoding:'utf8',...o}).trim();
const mkdir=p=>fs.mkdirSync(p,{recursive:true});
const put=(p,b)=>{mkdir(path.dirname(p));fs.writeFileSync(p,b);};
const copy=(a,b)=>{mkdir(path.dirname(b));fs.cpSync(a,b,{recursive:true,filter:file=>path.basename(file)!=='.git'});};
const walk=d=>fs.readdirSync(d,{recursive:true}).filter(p=>fs.statSync(path.join(d,p)).isFile()).sort();
function verifyArchive(file,want){if(hash(fs.readFileSync(file))!==want)throw Error('Archive integrity mismatch: '+file);}
function fetch(url,file){if(!fs.existsSync(file)){mkdir(path.dirname(file));run('curl',['-fLsS',url,'-o',file+'.part']);fs.renameSync(file+'.part',file);}return file;}
export function gitSource(input, revision=gitlink(input.path), directory=path.join(root,input.path)) {
 if(capture('git',['-C',directory,'rev-parse','HEAD'])!==revision)throw Error('Git source differs from its declared commit: '+input.path);
 return directory;
}
export function prepare(work){
 mkdir(work);
 const proton=gitSource(pins.proton);
 const np=gitSource(pins.notproton);
 const wineArchive=fetch(winePin.archive.url,path.join(work,'crossover.tar.gz'));verifyArchive(wineArchive,winePin.archive.sha256);
 const base=path.join(work,'wine-original');if(!fs.existsSync(base)){mkdir(base);run('tar',['xzf',wineArchive,'--strip-components=2','-C',base,winePin.archive.directory]);}
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
 copy(path.join(np,'steam-shim'),shim);
 copy(path.join(lsc,'steamworks_sdk_142'),path.join(shim,'proton-headers/steamworks_sdk_142'));
 for(const input of pins.headers){
  const checkout=gitSource(input),headers=path.join(work,'headers',input.project==='wine-headers'?'wine':input.project);
  if(input.project==='openvr'){copy(path.join(checkout,'headers'),path.join(headers,'headers'));copy(path.join(checkout,'src/ivrclientcore.h'),path.join(headers,'src/ivrclientcore.h'));}
  else copy(path.join(checkout,'include/wine/heap.h'),path.join(headers,'include/wine/heap.h'));
  copy(headers,path.join(shim,'proton-headers',input.project==='wine-headers'?'wine':input.project));
 }
 // Wine 11.0 makedep does not classify .cpp unix-only sources. Build them explicitly.
 const mf=path.join(lsc,'Makefile.in');put(path.join(work,'unix-sources.json'),JSON.stringify([...fs.readFileSync(mf,'utf8').matchAll(/^\s*([A-Za-z0-9_]+\.cpp)\s*\\?\s*$/gm)].map(m=>m[1])));put(mf,fs.readFileSync(mf,'utf8').replace(/^\s*[A-Za-z0-9_]+\.cpp\s*\\?\s*$/gm,''));
 // Register only the owned components, in the disposable assembly.
 let ac=fs.readFileSync(path.join(source,'configure.ac'),'utf8');ac+='\nWINE_CONFIG_MAKEFILE(dlls/lsteamclient)\nWINE_CONFIG_MAKEFILE(programs/steam.exe)\n';put(path.join(source,'configure.ac'),ac);
 // Wine requires registrations before AC_OUTPUT.
 ac=ac.replace(/\nWINE_CONFIG_MAKEFILE\(dlls\/lsteamclient\)[\s\S]*$/,'');
 ac=ac.replace('AC_OUTPUT','WINE_CONFIG_MAKEFILE(dlls/lsteamclient)\nWINE_CONFIG_MAKEFILE(programs/steam.exe)\nAC_OUTPUT');put(path.join(source,'configure.ac'),ac);
 run('autoconf',[],{cwd:source});
 put(path.join(work,'inputs.json'),JSON.stringify({sources:[pins.proton,pins.notproton,...pins.headers].map(input=>({...input,revision:gitlink(input.path)})),wine:winePin.archive,toolchain},null,2)+'\n');
 return source;
}
export const compilerPath=(mingw,search=process.env.PATH)=>[mingw,search].filter(Boolean).join(path.delimiter);
export function build({work,mingw,output}){
 const source=path.join(work,'wine');if(!fs.existsSync(path.join(work,'inputs.json')))prepare(work);
 const unixDir=path.join(source,'dlls/lsteamclient');
 copy(path.join(here,'bridge-paths.cpp'),path.join(unixDir,'bridge-paths.cpp'));
 const unixFile=path.join(unixDir,'unixlib.cpp');let unixText=fs.readFileSync(unixFile,'utf8');
 unixText=unixText.replaceAll('ntdll_get_dos_file_name(', 'bridge_get_dos_file_name(').replaceAll('ntdll_get_unix_file_name(', 'bridge_get_unix_file_name(');
 if(!unixText.includes('extern "C" NTSTATUS bridge_get_dos_file_name'))unixText=unixText.replace('#include "unix_private.h"','#include "unix_private.h"\nextern "C" NTSTATUS bridge_get_dos_file_name(const char *, WCHAR **, UINT);\nextern "C" NTSTATUS bridge_get_unix_file_name(const WCHAR *, char **, UINT);');
 put(unixFile,unixText);
 const unixSources=JSON.parse(fs.readFileSync(path.join(work,'unix-sources.json')));if(!unixSources.includes('bridge-paths.cpp'))unixSources.push('bridge-paths.cpp');put(path.join(work,'unix-sources.json'),JSON.stringify(unixSources));
 const nativeCC=capture('xcrun',['--find','clang']),nativeCXX=capture('xcrun',['--find','clang++']);
 const environment={...process.env,SDKROOT:capture('xcrun',['--sdk','macosx','--show-sdk-path']),CFLAGS:'-O2',CPPFLAGS:'',LDFLAGS:'',PATH:compilerPath(mingw),MACOSX_DEPLOYMENT_TARGET:pins.minimumMacOS};
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

export function warnNativeOutput({architecture,actualArchitecture,unresolved},warn=console.warn) {
 if(/^\s*_(?:wow64_|ISteam|steamclient_)/m.test(unresolved))warn('Steam bridge: unresolved implementation symbols in '+architecture+' output');
 if(actualArchitecture!==architecture)warn('Steam bridge: '+architecture+' output reports '+actualArchitecture);
}
export function packageOutput({work,mingw,output}) {
 const source=path.join(work,'wine');
 const shim=path.join(source,'programs/steam.exe'),pe=path.join(work,'build-x86_64');
 const helper=path.join(source,'programs/steam.exe/steam.cpp');
 put(path.join(work,'helper-client.inc'),helperClientSource(fs.readFileSync(helper,'utf8'),{upstreamHandshake:pins.helperLaunchHandshake===true}));
 buildHelpers({work,mingw,source,pins});
 for(const arch of ['x86_64','arm64']){const file=path.join(work,'build-'+arch,'dlls/lsteamclient/lsteamclient.so');warnNativeOutput({architecture:arch,actualArchitecture:capture('lipo',['-archs',file]),unresolved:capture('nm',['-u',file])});}
 if(fs.existsSync(output))throw Error('Package output already exists');mkdir(output);
 for(const arch of ['x86_64','arm64']){const file=path.join(work,'build-'+arch,'dlls/lsteamclient/lsteamclient.so');copy(file,path.join(output,arch==='arm64'?'aarch64-unix':'x86_64-unix','lsteamclient.so'));}
 for(const arch of ['i386','x86_64']){
  copy(path.join(work,'build-x86_64/dlls/lsteamclient',arch+'-windows/lsteamclient.dll'),path.join(output,arch+'-windows/lsteamclient.dll'));
  copy(path.join(work,'helper-'+arch,'mlsteam-bootstrap.dll'),path.join(output,arch+'-windows/mlsteam-bootstrap.dll'));
 }
 copy(path.join(work,'helper-x86_64/steam.exe'),path.join(output,'steam.exe'));
 copy(path.join(work,'helper-i386/steam.exe'),path.join(output,'i386-windows/steam.exe'));
 addLicense(output,'lsteamclient and Steamworks SDK',path.join(source,'dlls/lsteamclient/LICENSE'),'Steamworks-SDK');
 addLicense(output,'steam_helper',path.join(source,'programs/steam.exe/LICENSE'),'BSD-3-Clause');
 addLicense(output,'Wine headers',path.join(source,'COPYING.LIB'),'LGPL-2.1');
 addLicense(output,'OpenVR',path.join(root,pins.headers.find(input=>input.project==='openvr').path,'LICENSE'),'BSD-3-Clause');
 addLicense(output,'JsonCpp',path.join(here,'licenses/JsonCpp.txt'),'JsonCpp');
 const files=walk(output).map(p=>({path:p,mode:fs.statSync(path.join(output,p)).mode & 0o777,size:fs.statSync(path.join(output,p)).size,sha256:hash(fs.readFileSync(path.join(output,p)))}));
 const steamBridge={native:{x86_64:'x86_64-unix/lsteamclient.so',aarch64:'aarch64-unix/lsteamclient.so'},windows:Object.fromEntries(['i386','x86_64'].map(arch=>[arch,{builtin:arch+'-windows/lsteamclient.dll',bootstrap:arch+'-windows/mlsteam-bootstrap.dll',helper:arch==='i386'?'i386-windows/steam.exe':'steam.exe'}]))};
 const manifest={steamBridge,schemaVersion:1,managerId:pins.id,version:pins.version,platform:'darwin',arch:'universal',minimumMacOS:pins.minimumMacOS,executableRelative:'steam.exe',files,dependencies:[]};
 put(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const mf=path.join(output,'manifest.json');
 const declaration={id:pins.id,version:pins.version,arch:'universal',launcherArchitectures:['arm64','x64'],minimumMacOS:pins.minimumMacOS,sourceRelative:null,sourceSha256:hash(fs.readFileSync(path.join(here,'source.json'))),directoryRelative:[pins.id,pins.version,'universal'].join('/'),manifestRelative:'manifest.json',manifestSha256:hash(fs.readFileSync(mf)),files:[...files,{path:'manifest.json',mode:0o644,size:fs.statSync(mf).size,sha256:hash(fs.readFileSync(mf))}]};
 put(path.join(path.dirname(output),path.basename(output)+'-runtime-package.json'),JSON.stringify(declaration,null,2)+'\n');
 return declaration;
}
export async function buildSteamBridge({work,output}) {
 mkdir(work);
 const mingw=await prepareMingw(work);
 mkdir(output);
 const declaration=build({work,mingw,output:path.join(output,'payload')});
 fs.renameSync(path.join(output,'payload-runtime-package.json'),path.join(output,'declaration.json'));
 return {project:pins.id,version:declaration.version,arch:declaration.arch,output};
}
recipeMain(import.meta,buildSteamBridge);
