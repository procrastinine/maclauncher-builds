// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {gitlink} from '../../lib/pins.mjs';
import {addLicenses} from '../../lib/licenses.mjs';
import {applyComposition} from './patch.mjs';
import {applyAdaptations} from './adapt.mjs';
const here=import.meta.dirname;
const run=(program,args,options={})=>execFileSync(program,args,{stdio:'inherit',...options});
const quote=value=>"'"+String(value).replaceAll('\\','/').replaceAll("'","\\'")+"'";
export const sourceRevision=()=>gitlink('producers/dxvk/source');

/** Build the ordinary upstream renderer with its paired HWND composition DLL. */
export function buildProvider({work,output,mingw,glslang,source=path.join(here,'source'),
    architectures=['x64','x86'],jobs=2,meson='meson',ninja='ninja'}={}){
  work=path.resolve(work);output=path.resolve(output);source=path.resolve(source);mingw=path.resolve(mingw);
  if(work===output||work.startsWith(output+path.sep)||output.startsWith(work+path.sep))
    throw Error('Build work and runtime output must be separate directories.');
  if(fs.existsSync(output))throw Error('The immutable renderer output already exists.');
  if(!architectures.length||architectures.some(a=>!['x64','x86'].includes(a)))throw Error('DXVK target must be x64 or x86.');
  const targets=[];
  fs.mkdirSync(work,{recursive:true});
  for(const architecture of [...new Set(architectures)]){
    const prefix=architecture==='x64'?'x86_64-w64-mingw32':'i686-w64-mingw32';
    const root=path.join(work,architecture),exported=path.join(root,'source'),build=path.join(root,'build');
    fs.mkdirSync(root,{recursive:true});
    fs.cpSync(source,exported,{recursive:true,filter:file=>path.basename(file)!=='.git'});
    applyComposition(exported);
    applyAdaptations(exported);
    const cc=path.join(mingw,prefix+'-clang'),cpp=path.join(mingw,prefix+'-clang++');
    const dcomp=path.join(root,'dcomp.dll'),importlib=path.join(exported,'src/dxgi/libmaclauncher-dcomp.a');
    run(cpp,['-std=c++17','-O2','-shared','-static','-static-libgcc','-static-libstdc++',
      '-ffile-prefix-map='+here+'=MacLauncherDXVK','-ffile-prefix-map='+root+'=DXVKBuild',
      '-Wl,--no-insert-timestamp','-Wl,--out-implib,'+importlib,'-I'+here,
      path.join(here,'dcomp.cpp'),path.join(here,'dcomp.def'),'-luser32','-ldxguid','-lole32','-o',dcomp]);
    const cross=path.join(root,'cross.ini');
    fs.writeFileSync(cross,`[binaries]\nc = ${quote(cc)}\ncpp = ${quote(cpp)}\nar = ${quote(path.join(mingw,'llvm-ar'))}\nstrip = ${quote(path.join(mingw,'llvm-strip'))}\nwindres = ${quote(path.join(mingw,prefix+'-windres'))}\n[properties]\nneeds_exe_wrapper = true\n[host_machine]\nsystem = 'windows'\ncpu_family = '${architecture==='x64'?'x86_64':'x86'}'\ncpu = '${architecture==='x64'?'x86_64':'i686'}'\nendian = 'little'\n`);
    const env={...process.env,NINJA:ninja,CFLAGS:'',CXXFLAGS:'',CPPFLAGS:'',LDFLAGS:'',GIT_CEILING_DIRECTORIES:root,PATH:[glslang?path.dirname(path.resolve(glslang)):null,mingw,process.env.PATH].filter(Boolean).join(path.delimiter)};
    run(meson,['setup',build,exported,'--cross-file',cross,'--buildtype','release'],{env});
    run(ninja,['-C',build,'-j'+String(jobs)],{env});
    targets.push({architecture,build,dcomp});
  }
  fs.mkdirSync(output,{recursive:true});
  for(const target of targets){
    const folder=path.join(output,target.architecture==='x64'?'x64':'x32');fs.mkdirSync(folder,{recursive:true});
    for(const module of ['d3d8','d3d9','d3d10core','d3d11','dxgi']){
      const binary=path.join(target.build,'src',module==='d3d10core'?'d3d10':module,module+'.dll');
      fs.copyFileSync(binary,path.join(folder,module+'.dll'));
    }
    fs.copyFileSync(target.dcomp,path.join(folder,'dcomp.dll'));
    for(const name of fs.readdirSync(folder))run(path.join(mingw,'llvm-strip'),['--strip-debug',path.join(folder,name)]);
  }
  const version=fs.readFileSync(path.join(source,'meson.build'),'utf8').match(/version\s*:\s*'([^']+)'/)?.[1];
  if(version)fs.writeFileSync(path.join(output,'version'),version+'\n');
  else console.warn('DXVK source has no readable component version; binary facts remain available.');
  addLicenses(output,'DXVK',source);
  addLicenses(output,'MacLauncher',path.resolve(here,'../..'));
  addLicenses(output,'LLVM-MinGW',path.dirname(mingw));
  for(const target of targets)addLicenses(output,'MinGW-w64 '+target.architecture,path.join(path.dirname(mingw),target.architecture==='x64'?'x86_64-w64-mingw32':'i686-w64-mingw32','share/mingw32'));
  for(const [name,relative]of [['Vulkan-Headers','include/vulkan'],['SPIRV-Headers','include/spirv'],['DXBC-SPIRV','subprojects/dxbc-spirv'],['libdisplay-info','subprojects/libdisplay-info']])
    addLicenses(output,name,path.join(source,relative));
  return {output,source:{repository:'https://github.com/doitsujin/dxvk',revision:sourceRevision()},architectures:targets.map(t=>t.architecture)};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].slice(2);if(!['work','output','mingw','glslang','source','jobs','architectures'].includes(key)||!process.argv[i+1])throw Error('Use --work --output --mingw --glslang and optional --source --jobs --architectures.');options[key]=process.argv[i+1];}
  if(options.architectures)options.architectures=options.architectures.split(',');
  console.log(JSON.stringify(buildProvider(options)));
}
