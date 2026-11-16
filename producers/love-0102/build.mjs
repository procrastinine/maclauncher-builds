// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const Native=createRequire(import.meta.url)('../package-support/scripts/native-binary-tools.cjs');
import {applyBuildOverlay} from './overlay.mjs';
const here=import.meta.dirname;
export const sources=JSON.parse(fs.readFileSync(path.join(here,'sources.json')));
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run=(program,args,options={})=>execFileSync(program,args,{stdio:'inherit',...options});
/** Stage the exact release and vendored dependency source archives without changing their inputs. */
export async function prepare({work,archives={}}){
 const staged={};fs.mkdirSync(work,{recursive:true});
 for(const record of sources){
  const archive=archives[record.id]||await (await import('../../tools/build-input.mjs')).buildInput((await import('../../lib/pins.mjs')).sourceArchive(record));
  if(digest(archive)!==record.archive.sha256)throw Error('Source archive digest differs: '+record.id);
  const target=path.join(work,record.id);if(fs.existsSync(target))throw Error('Source projection already exists: '+record.id);
  fs.mkdirSync(target);run('/usr/bin/tar',['-xzf',archive,'--strip-components=1','-C',target]);staged[record.id]=target;
 }
 fs.writeFileSync(path.join(work,'prepared.json'),JSON.stringify({sources,staged},null,2)+'\n');return{sources,staged};
}
/** Build each requested CPU once, with LuaJIT 2.1 retaining the release's Lua 5.1 interface. */
export function compile({work,prepared,architectures=['arm64','x86_64'],cc=process.env.CC||'/usr/bin/clang',cxx=process.env.CXX||'/usr/bin/clang++',jobs=2}){
 const sdk=process.env.SDKROOT||execFileSync('/usr/bin/xcrun',['--show-sdk-path'],{encoding:'utf8'}).trim(),slices=[];
 for(const arch of architectures){
  if(!['arm64','x86_64'].includes(arch))throw Error('Unsupported native target CPU.');
  const slice=path.join(work,arch);if(fs.existsSync(slice))throw Error('Slice work already exists: '+arch);fs.mkdirSync(slice,{recursive:true});
  const roots={};for(const[id,source]of Object.entries(prepared.staged)){roots[id]=path.join(slice,id);fs.cpSync(source,roots[id],{recursive:true});}
  const maps=['file','debug','macro'].map(kind=>'-f'+kind+'-prefix-map='+work+'=LOVE_0102_BUILD').join(' ');
  run('/usr/bin/make',['-C',roots.luajit,'-j'+jobs,'BUILDMODE=dynamic','CC='+cc,'HOST_CC='+cc,'TARGET_FLAGS=-arch '+arch+' -isysroot '+sdk+' -mmacosx-version-min=12.0','XCFLAGS='+maps],{env:{...process.env,MACOSX_DEPLOYMENT_TARGET:'12.0'}});
  const luaLibrary=path.join(roots.luajit,'src/libluajit.so');if(!fs.existsSync(luaLibrary))throw Error('LuaJIT build did not produce its dynamic library.');
  applyBuildOverlay({love:roots.love,megasource:roots.megasource,luaLibrary,luaInclude:path.join(roots.luajit,'src')});
  const build=path.join(slice,'build'),options=['-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_C_COMPILER='+cc,'-DCMAKE_CXX_COMPILER='+cxx,'-DCMAKE_OSX_ARCHITECTURES='+arch,'-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0','-DCMAKE_OSX_SYSROOT='+sdk,'-DCMAKE_POLICY_VERSION_MINIMUM=3.5','-DCMAKE_POSITION_INDEPENDENT_CODE=ON','-DCMAKE_C_FLAGS='+maps,'-DCMAKE_CXX_FLAGS='+maps,'-DBUILD_SHARED_LIBS=ON','-DMEGA_LOVE='+roots.love,'-DLOVE_JIT=ON','-DOGG_BUILD_SHARED=ON','-DVORBIS_BUILD_SHARED=ON','-DVORBISFILE_BUILD_SHARED=ON','-DTHEORA_BUILD_SHARED=ON','-DMODPLUG_BUILD_SHARED=ON','-DPHYSFS_BUILD_SHARED=ON','-DSDL_SHARED=ON','-DSDL_STATIC=OFF','-DSDL_TEST=OFF','-DSDL_X11=OFF','-DALSOFT_EXAMPLES=OFF','-DALSOFT_UTILS=OFF','-DALSOFT_TESTS=OFF'];
  run('cmake',['-S',roots.megasource,'-B',build,...options]);
  run('cmake',['--build',build,'--target','love','--parallel',String(jobs)]);
  const outputs=fs.readFileSync(path.join(build,'love-outputs.txt'),'utf8').trim().split(/\r?\n/);for(const file of outputs)if(!fs.existsSync(file))throw Error('Declared compiled output missing: '+file);
  const record={architecture:arch,outputs,luaLibrary,roots,build};slices.push(record);
  fs.writeFileSync(path.join(slice,'compiled.json'),JSON.stringify(record,null,2)+'\n');
 }
 const compiled={upstreamVersion:'0.10.2',sources,slices};fs.writeFileSync(path.join(work,'compiled.json'),JSON.stringify(compiled,null,2)+'\n');return compiled;
}
/** Assemble compiled slices, relocate their actual loader dependencies and measure every binary. */
export async function assemble({compiled,output,version='0.10.2-MCLv1'}){
 const {helperPackage}=await import('../../tools/helper-package.mjs'),{addLicenses}=await import('../../lib/licenses.mjs');
 if(compiled.slices.length!==2||new Set(compiled.slices.map(s=>s.architecture)).size!==2)throw Error('Both native slices are required for the universal package.');
 const payload=path.join(output,'payload'),bundle=path.join(payload,'love.app'),frameworks=path.join(bundle,'Contents/Frameworks'),macos=path.join(bundle,'Contents/MacOS');
 if(fs.existsSync(payload))throw Error('Payload output already exists.');fs.mkdirSync(frameworks,{recursive:true});fs.mkdirSync(macos,{recursive:true});
 const first=compiled.slices[0],binaries=[],aliases=new Map();
 let minimumMacOS='12.0';
 for(let i=0;i<first.outputs.length;i++){
  const input=first.outputs[i];let target;
  if(i===0)target=path.join(macos,'love');else{
   const marker=input.indexOf('.framework/');if(marker<0)throw Error('External native output is not a framework.');
   const start=input.lastIndexOf('/',marker)+1,frameworkRoot=input.slice(0,marker+10),name=path.basename(frameworkRoot);
   fs.cpSync(frameworkRoot,path.join(frameworks,name),{recursive:true,verbatimSymlinks:true});target=path.join(frameworks,input.slice(start));
  }
  const slices=compiled.slices.map(s=>s.outputs[i]);run('/usr/bin/lipo',['-create',...slices,'-output',target]);
  binaries.push(target);for(const file of slices){aliases.set(file,target);for(const id of Native.libraryIds(file))aliases.set(id,target);}
 }
 const luaRoot=path.join(frameworks,'Lua.framework'),luaVersion=path.join(luaRoot,'Versions/A');fs.mkdirSync(luaVersion,{recursive:true});
 const lua=path.join(luaVersion,'Lua');run('/usr/bin/lipo',['-create',...compiled.slices.map(s=>s.luaLibrary),'-output',lua]);binaries.push(lua);
 for(const s of compiled.slices){aliases.set(s.luaLibrary,lua);for(const id of Native.libraryIds(s.luaLibrary))aliases.set(id,lua);}
 fs.symlinkSync('A',path.join(luaRoot,'Versions/Current'));fs.symlinkSync('Versions/Current/Lua',path.join(luaRoot,'Lua'));
 for(const file of binaries){
  for(const linked of Native.links(file)){
   if(linked.startsWith('/System/')||linked.startsWith('/usr/lib/'))continue;
   const target=aliases.get(linked);if(!target)throw Error('Unresolved packaged native dependency: '+linked);
   const replacement='@loader_path/'+path.relative(path.dirname(file),target);run('/usr/bin/install_name_tool',['-change',linked,replacement,file]);
  }
  if(libraryIds(file).length)run('/usr/bin/install_name_tool',['-id','@rpath/'+path.relative(frameworks,file),file]);
  const lines=execFileSync('/usr/bin/otool',['-l',file],{encoding:'utf8'}).split('\n');
  for(let i=0;i<lines.length;i++)if(lines[i].trim()==='cmd LC_RPATH'){
   const rpath=lines.slice(i+1,i+5).join('\n').match(/path (.+) \(offset/)?.[1];if(rpath&&path.isAbsolute(rpath))run('/usr/bin/install_name_tool',['-delete_rpath',rpath,file]);
  }
  const cpus=(Native.macho(file)||[]).sort();
  for(const cpu of cpus){const actual=Native.loadCommands(file,cpu).minimumMacOS;if(!actual)throw Error('Compiled binary has no measured macOS floor: '+path.basename(file));if(actual.localeCompare(minimumMacOS,undefined,{numeric:true})>0)minimumMacOS=actual;}
  if(JSON.stringify(cpus)!==JSON.stringify(['arm64','x86_64']))throw Error('Actual universal slices missing: '+path.relative(payload,file));
  fs.chmodSync(file,0o755);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);
 }
 fs.writeFileSync(path.join(bundle,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>love</string><key>CFBundleIdentifier</key><string>org.love2d.love</string><key>CFBundleName</key><string>LÖVE</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.10.2</string><key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
 for(const source of Object.values(first.roots))addLicenses(payload,'LÖVE 0.10.2',source);
 for(const folder of fs.readdirSync(path.join(first.roots.megasource,'libs')))addLicenses(payload,folder,path.join(first.roots.megasource,'libs',folder));
 run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',bundle]);
 const sourceHash=crypto.createHash('sha256').update(JSON.stringify(sources)).digest('hex');
 return helperPackage({id:'love',version,arch:'universal',output,minimumMacOS,sourceSha256:sourceHash,record:{upstreamVersion:'0.10.2',sources,luaApi:'5.1',luaImplementation:'LuaJIT 2.1',nativeBinaries:binaries.map(f=>path.relative(payload,f))}});
}
function libraryIds(file){return [...new Set(execFileSync('/usr/bin/otool',['-D',file],{encoding:'utf8'}).split('\n').map(l=>l.trim()).filter(l=>l&&!l.endsWith(':')&&(l.startsWith('@')||l.startsWith('/'))))];}
function libraryLinks(file){const ids=libraryIds(file);return [...new Set(execFileSync('/usr/bin/otool',['-L',file],{encoding:'utf8'}).split('\n').map(l=>/^\s+(.+?) \(compatibility version /.exec(l)?.[1]).filter(l=>l&&!ids.includes(l)))];}
