// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const Native=createRequire(import.meta.url)('../package-support/scripts/native-binary-tools.cjs');
import {applyBuildOverlay} from './overlay.mjs';
const here=import.meta.dirname;
// Match the publisher's declared macOS closure rather than optional host libraries.
export const nativeProfileOptions=['-DWITH_HarfBuzz=OFF','-DWITH_PNG=ON','-DALSOFT_BACKEND_PORTAUDIO=OFF','-DALSOFT_BACKEND_COREAUDIO=ON'];
const pngSource=JSON.parse(fs.readFileSync(path.join(here,'../dependencies/libpng.json')));
export const sources=[...JSON.parse(fs.readFileSync(path.join(here,'sources.json'))),{id:'libpng',repository:pngSource.repository,revision:pngSource.revision,archive:{sha256:pngSource.sha256},bytes:pngSource.bytes}];
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
  applyBuildOverlay({love:roots.love,megasource:roots.megasource,luaLibrary,luaInclude:path.join(roots.luajit,'src'),libpng:roots.libpng});
  const build=path.join(slice,'build'),options=[...nativeProfileOptions,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_C_COMPILER='+cc,'-DCMAKE_CXX_COMPILER='+cxx,'-DCMAKE_OSX_ARCHITECTURES='+arch,'-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0','-DCMAKE_OSX_SYSROOT='+sdk,'-DCMAKE_POLICY_VERSION_MINIMUM=3.5','-DCMAKE_POSITION_INDEPENDENT_CODE=ON','-DCMAKE_C_FLAGS='+maps,'-DCMAKE_CXX_FLAGS='+maps,'-DBUILD_SHARED_LIBS=ON','-DMEGA_LOVE='+roots.love,'-DLOVE_JIT=ON','-DOGG_BUILD_SHARED=ON','-DVORBIS_BUILD_SHARED=ON','-DVORBISFILE_BUILD_SHARED=ON','-DTHEORA_BUILD_SHARED=ON','-DMODPLUG_BUILD_SHARED=ON','-DPHYSFS_BUILD_SHARED=ON','-DSDL_SHARED=ON','-DSDL_STATIC=OFF','-DSDL_TEST=OFF','-DSDL_X11=OFF','-DALSOFT_EXAMPLES=OFF','-DALSOFT_UTILS=OFF','-DALSOFT_TESTS=OFF'];
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
 const first=compiled.slices[0],binaries=[],aliases=new Map(),copiedFrameworks=new Set();
 let minimumMacOS='12.0';
 for(let i=0;i<first.outputs.length;i++){
  const input=first.outputs[i];let target;
  if(i===0)target=path.join(macos,'love');else{
   const marker=input.indexOf('.framework/');if(marker<0)throw Error('External native output is not a framework.');
   const start=input.lastIndexOf('/',marker)+1,frameworkRoot=input.slice(0,marker+10),name=path.basename(frameworkRoot);
   if(!copiedFrameworks.has(frameworkRoot)){fs.cpSync(frameworkRoot,path.join(frameworks,name),{recursive:true,verbatimSymlinks:true});copiedFrameworks.add(frameworkRoot);}target=path.join(frameworks,input.slice(start));
  }
  const slices=compiled.slices.map(s=>s.outputs[i]);run('/usr/bin/lipo',['-create',...slices,'-output',target]);
  binaries.push(target);for(const file of slices){aliases.set(file,target);for(const id of Native.libraryIds(file))aliases.set(id,target);}
 }
 const luaRoot=path.join(frameworks,'Lua.framework'),luaVersion=path.join(luaRoot,'Versions/A');fs.mkdirSync(luaVersion,{recursive:true});
 const lua=path.join(luaVersion,'Lua');run('/usr/bin/lipo',['-create',...compiled.slices.map(s=>s.luaLibrary),'-output',lua]);binaries.push(lua);
 for(const s of compiled.slices){aliases.set(s.luaLibrary,lua);for(const id of Native.libraryIds(s.luaLibrary))aliases.set(id,lua);}
 fs.symlinkSync('A',path.join(luaRoot,'Versions/Current'));fs.symlinkSync('Versions/Current/Lua',path.join(luaRoot,'Lua'));
 const luaResources=path.join(luaVersion,'Resources');fs.mkdirSync(luaResources);fs.symlinkSync('Versions/Current/Resources',path.join(luaRoot,'Resources'));
 fs.writeFileSync(path.join(luaResources,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Lua</string><key>CFBundleIdentifier</key><string>org.luajit.LuaJIT</string><key>CFBundleName</key><string>Lua</string><key>CFBundlePackageType</key><string>FMWK</string><key>CFBundleVersion</key><string>2.1</string></dict></plist>`);
 const relocationRoot=path.join(output,'relocation-slices');fs.mkdirSync(relocationRoot);
 for(const [index,file] of binaries.entries()){
  const relocated=[];
  for(const cpu of Native.macho(file)||[]){
   const thin=path.join(relocationRoot,String(index)+'-'+cpu);fs.copyFileSync(file,thin);
   Native.thinStagedMachO(thin,relocationRoot,cpu);
   const ids=new Set(Native.libraryIds(thin,cpu));
   for(const linked of Native.links(thin,cpu)){
    if(ids.has(linked)||linked.startsWith('/System/')||linked.startsWith('/usr/lib/'))continue;
    const target=aliases.get(linked);if(!target)throw Error('Unresolved packaged native dependency: '+linked);
    run('/usr/bin/install_name_tool',['-change',linked,'@loader_path/'+path.relative(path.dirname(file),target),thin]);
   }
   if(ids.size)run('/usr/bin/install_name_tool',['-id','@rpath/'+path.relative(frameworks,file),thin]);
   for(const rpath of new Set(Native.loadCommands(thin,cpu).rpaths))if(path.isAbsolute(rpath))run('/usr/bin/install_name_tool',['-delete_rpath',rpath,thin]);
   relocated.push(thin);
  }
  run('/usr/bin/lipo',['-create',...relocated,'-output',file]);
  const cpus=(Native.macho(file)||[]).sort();
  for(const cpu of cpus){const actual=Native.loadCommands(file,cpu).minimumMacOS;if(!actual)throw Error('Compiled binary has no measured macOS floor: '+path.basename(file));if(actual.localeCompare(minimumMacOS,undefined,{numeric:true})>0)minimumMacOS=actual;}
  if(JSON.stringify(cpus)!==JSON.stringify(['arm64','x86_64']))throw Error('Actual universal slices missing: '+path.relative(payload,file));
  fs.chmodSync(file,0o755);
 }
 fs.writeFileSync(path.join(bundle,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>love</string><key>CFBundleIdentifier</key><string>org.love2d.love</string><key>CFBundleName</key><string>LÖVE</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.10.2</string><key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
 for(const source of Object.values(first.roots))addLicenses(payload,'LÖVE 0.10.2',source);
 for(const folder of fs.readdirSync(path.join(first.roots.megasource,'libs')))addLicenses(payload,folder,path.join(first.roots.megasource,'libs',folder));
 // Sign companion libraries first, then their containing frameworks, then the application.
 for(const name of fs.readdirSync(frameworks)){
  const framework=path.join(frameworks,name),primary=path.join(framework,'Versions/A',path.basename(name,'.framework'));
  for(const binary of binaries)if(binary.startsWith(framework+path.sep)&&binary!==primary)run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',binary]);
  run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',framework]);
 }
 run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',bundle]);
 run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
 const sourceHash=crypto.createHash('sha256').update(JSON.stringify(sources)).digest('hex');
 // Store framework links using the package format's existing file aliases.
 const packageAliases={},links=[],payloadRoot=fs.realpathSync(payload);
 function collect(directory,logical=directory){
  for(const name of fs.readdirSync(directory)){
   const file=path.join(directory,name),logicalFile=path.join(logical,name),stat=fs.lstatSync(file);
   if(stat.isSymbolicLink()){
    const target=fs.realpathSync(file);
    if(!target.startsWith(payloadRoot+path.sep))throw Error('Framework alias leaves the payload.');
    links.push({file,target:fs.readlinkSync(file)});
    if(fs.statSync(target).isDirectory())collect(target,logicalFile);
    else packageAliases[path.relative(payload,logicalFile)]=path.relative(payload,target);
   }else if(stat.isDirectory())collect(file,logicalFile);
   else if(logicalFile!==file)packageAliases[path.relative(payload,logicalFile)]=path.relative(payload,fs.realpathSync(file));
  }
 }
 collect(payload);
 // Only remove actual links; logical directory aliases expand into file aliases.
 const actualLinks=[...new Map(links.map(link=>[link.file,link])).values()];
 for(const link of actualLinks)fs.unlinkSync(link.file);
 let result;
 try{result=helperPackage({id:'love',version,arch:'universal',output,minimumMacOS,sourceSha256:sourceHash,record:{upstreamVersion:'0.10.2',sources,luaApi:'5.1',luaImplementation:'LuaJIT 2.1',nativeBinaries:binaries.map(f=>path.relative(payload,f))}});}
 finally{for(const link of actualLinks)fs.symlinkSync(link.target,link.file);}
 const declarationFile=path.join(output,'declaration.json'),declaration=JSON.parse(fs.readFileSync(declarationFile));
 declaration.aliases={schema:1,files:packageAliases};
 createRequire(import.meta.url)('../../lib/package-contract.cjs').validateDeclaration(declaration);
 fs.writeFileSync(declarationFile,JSON.stringify(declaration,null,2)+'\n');
 return result;
}
function libraryIds(file){return [...new Set(execFileSync('/usr/bin/otool',['-D',file],{encoding:'utf8'}).split('\n').map(l=>l.trim()).filter(l=>l&&!l.endsWith(':')&&(l.startsWith('@')||l.startsWith('/'))))];}
function libraryLinks(file){const ids=libraryIds(file);return [...new Set(execFileSync('/usr/bin/otool',['-L',file],{encoding:'utf8'}).split('\n').map(l=>/^\s+(.+?) \(compatibility version /.exec(l)?.[1]).filter(l=>l&&!ids.includes(l)))];}
