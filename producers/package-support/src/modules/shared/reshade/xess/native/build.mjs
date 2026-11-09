#!/usr/bin/env node
import {sourceRevision} from '../../../../../../../../lib/pins.mjs';
const revision=sourceRevision({gitlink:'producers/package-support/src/external/xess'});
import {addLicenses} from '../../../../../../../../lib/licenses.mjs';
import {appPath} from '../../../../../../../../tools/app-source.mjs';
// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname,module='src/modules/shared/reshade/xess',sources=appPath(module+'/native'),args=Object.fromEntries(process.argv.slice(2).reduce((rows,value,index,all)=>index%2?rows:[...rows,[value.replace(/^--/,''),all[index+1]]],[]));
if(!args.sdk||!args.compiler||!args.out)throw Error('Use --sdk XESS_SOURCE --compiler LLVM_MINGW_BIN --out OUTPUT');
const sdk=fs.realpathSync(args.sdk),compiler=path.resolve(args.compiler),output=path.resolve(args.out),sourceFile=appPath(module+'/source.json'),source=JSON.parse(fs.readFileSync(sourceFile,'utf8'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const componentFile=appPath(module+'/components.json'),components=JSON.parse(fs.readFileSync(componentFile,'utf8'));
const windows=path.join(output,'x86_64-windows'),unix=path.join(output,'x86_64-unix');fs.mkdirSync(windows,{recursive:true});fs.mkdirSync(unix,{recursive:true});
const run=(file,argv)=>execFileSync(file,argv,{stdio:'pipe',maxBuffer: Infinity});
const cxx=path.join(compiler,'x86_64-w64-mingw32-clang++'),cc=path.join(compiler,'x86_64-w64-mingw32-clang');
const common=['-O2','-static','-ffile-prefix-map='+sources+'=MacLauncherXeSS','-I'+sources,'-I'+path.join(sdk,'inc')];
run(cxx,['-std=c++17',...common,path.join(sources,'host.cpp'),'-ld3d12','-ldxgi','-luuid','-o',path.join(windows,'maclauncher-xess-host.exe')]);
run(cxx,['-std=c++17',...common,path.join(sources,'host-fg.cpp'),'-ld3d12','-ldxgi','-luuid','-luser32','-o',path.join(windows,'maclauncher-xess-fg-host.exe')]);
const vulkanSource=JSON.parse(fs.readFileSync(path.join(here,'vulkan-source.json'),'utf8'));
let vulkanHeaders=null;
if(args['vulkan-source']){
  const root=fs.realpathSync(args['vulkan-source']);
  vulkanHeaders=path.join(root,vulkanSource.headerDirectory);
}
if(vulkanHeaders){
  const include=path.join(output,'.include','vulkan');fs.mkdirSync(include,{recursive:true});
  for(const row of vulkanSource.headers)fs.copyFileSync(path.join(vulkanHeaders,row.path),path.join(include,row.path));
  try{run(cxx,['-std=c++17',...common,'-I'+path.dirname(include),path.join(sources,'host-vulkan.cpp'),'-o',path.join(windows,'maclauncher-xess-vulkan-host.exe')]);}
  finally{fs.rmSync(path.join(output,'.include'),{recursive:true,force:true});}
}
run(cc,[...common,'-shared',path.join(sources,'bridge.c'),'-o',path.join(windows,'maclauncher-xess-gpu.dll')]);
const thunk=path.join(windows,'maclauncher-xess-gpu.dll'),bytes=fs.readFileSync(thunk);if(bytes.readUInt32LE(0x3c)<80)throw Error('The helper PE image has no builtin marker space.');bytes.write('Wine builtin DLL\0',64,'ascii');fs.writeFileSync(thunk,bytes);
const native=path.join(unix,'maclauncher-xess-gpu.so');run('xcrun',['clang++','-std=c++17','-fobjc-arc','-arch','x86_64','-mmacosx-version-min=13','-dynamiclib','-O2','-ffile-prefix-map='+sources+'=MacLauncherXeSS',path.join(sources,'bridge.mm'),'-framework','Foundation','-framework','Metal','-framework','IOSurface','-Wl,-install_name,@rpath/maclauncher-xess-gpu.so','-o',native]);run('codesign',['--force','--sign','-',native]);
if(vulkanHeaders){const target=path.join(output,'source/vulkan');fs.mkdirSync(target,{recursive:true});for(const row of vulkanSource.headers)fs.copyFileSync(path.join(vulkanHeaders,row.path),path.join(target,row.path));}
addLicenses(output,'Intel-XeSS',sdk);
const files=[];function inventory(directory,prefix=''){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const relative=path.posix.join(prefix,entry.name),file=path.join(directory,entry.name);if(entry.isDirectory())inventory(file,relative);else if(relative!=='provider.json')files.push({path:relative,size:fs.statSync(file).size,sha256:sha(file)});}}inventory(output);
const descriptor={schema:1,providerABI:1,backend:'d3d12',backends:['d3d12',...(vulkanHeaders?['vulkan']:[])],architecture:'x86_64',minimumMacOS:'13.0.0',hostPath:'x86_64-windows/maclauncher-xess-host.exe',hostPaths:{d3d12:'x86_64-windows/maclauncher-xess-host.exe',...(vulkanHeaders?{vulkan:'x86_64-windows/maclauncher-xess-vulkan-host.exe'}:{})},bridge:{name:'maclauncher-xess-gpu',windows:'x86_64-windows/maclauncher-xess-gpu.dll',unix:'x86_64-unix/maclauncher-xess-gpu.so'},sdk:{repository:source.repository,commit:revision,sha256:source.sha256,bytes:source.bytes},source:{repository:'https://github.com/procrastinine/maclauncher',sdkRevision:revision,...(vulkanHeaders?{vulkanHeaders:vulkanSource}:{})},generation:{providerABI:1,hostPath:'x86_64-windows/maclauncher-xess-fg-host.exe',backend:'d3d12',operation:'interpolate',maxInterpolatedFrames:1,requires:['color','depth','motion','viewMatrix','projectionMatrix'],formats:['rgba8-srgb','rgb10a2-pq-bt2020'],sdk:Object.fromEntries(components.files.map(component=>[component.id,{path:'bin/'+component.file,sha256:component.sha256,bytes:component.bytes}]))},transport:{version:1,surfaces:'iosurface',pixels:'gpu',copies:'aliased-gpu-buffers',maxInFlight:3,opaqueModelAllocations:true},files:files.sort((a,b)=>a.path.localeCompare(b.path))};
fs.writeFileSync(path.join(output,'provider.json'),JSON.stringify(descriptor,null,2)+'\n');console.log(JSON.stringify({output,host:descriptor.hostPath,files:files.length}));
