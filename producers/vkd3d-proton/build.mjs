// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {gitlink} from '../../lib/pins.mjs';
import {addLicense,addLicenses} from '../../lib/licenses.mjs';
const here=import.meta.dirname;
const run=(program,args,options={})=>execFileSync(program,args,{stdio:'inherit',...options});
const quote=value=>"'"+String(value).replaceAll('\\','/').replaceAll("'","\\'")+"'";
export const sourceRevision=()=>gitlink('producers/vkd3d-proton/source');
export const ngxRevision=()=>gitlink('producers/vkd3d-proton/ngx');

/** Build VKD3D-Proton with ID3D12GraphicsCommandListMetalFX, and the NGX core (x64) that records DLSS through it. */
export function buildProvider({work,output,mingw,glslang,source=path.join(here,'source'),ngx=path.join(here,'ngx'),
    architectures=['x64','x86'],jobs=2,meson='meson',ninja='ninja'}={}){
  work=path.resolve(work);output=path.resolve(output);source=path.resolve(source);ngx=path.resolve(ngx);mingw=path.resolve(mingw);
  if(work===output||work.startsWith(output+path.sep)||output.startsWith(work+path.sep))
    throw Error('Build work and runtime output must be separate directories.');
  if(fs.existsSync(output))throw Error('The immutable translator output already exists.');
  if(!architectures.length||architectures.some(a=>!['x64','x86'].includes(a)))throw Error('VKD3D-Proton target must be x64 or x86.');
  const built=[];
  for(const architecture of [...new Set(architectures)]){
    const prefix=architecture==='x64'?'x86_64-w64-mingw32':'i686-w64-mingw32';
    const root=path.join(work,architecture),exported=path.join(root,'source'),build=path.join(root,'build');
    fs.mkdirSync(root,{recursive:true});
    fs.cpSync(source,exported,{recursive:true,filter:file=>!path.basename(file).startsWith('.git')});
    run('git',['apply','--unsafe-paths','--directory='+exported,path.join(here,'metalfx.patch')],{cwd:path.resolve(here,'../..')});
    fs.copyFileSync(path.join(here,'metalfx.c'),path.join(exported,'libs/vkd3d/metalfx.c'));
    fs.copyFileSync(path.join(here,'vkd3d_metalfx.h'),path.join(exported,'include/private/vkd3d_metalfx.h'));
    const cross=path.join(root,'cross.ini'),tool=name=>quote(path.join(mingw,name));
    fs.writeFileSync(cross,`[binaries]\nc = ${tool(prefix+'-clang')}\ncpp = ${tool(prefix+'-clang++')}\nar = ${tool('llvm-ar')}\nstrip = ${tool('llvm-strip')}\nwidl-mingw-tools-fallback = ${tool(prefix+'-widl')}\n[properties]\nneeds_exe_wrapper = true\n[host_machine]\nsystem = 'windows'\ncpu_family = '${architecture==='x64'?'x86_64':'x86'}'\ncpu = '${architecture==='x64'?'x86_64':'i686'}'\nendian = 'little'\n`);
    const env={...process.env,CFLAGS:'',CXXFLAGS:'',CPPFLAGS:'',LDFLAGS:'',GIT_CEILING_DIRECTORIES:root,PATH:[glslang?path.dirname(path.resolve(glslang)):null,mingw,process.env.PATH].filter(Boolean).join(path.delimiter)};
    run(meson,['setup',build,exported,'--cross-file',cross,'--buildtype','release'],{env});
    run(ninja,['-C',build,'-j'+String(jobs)],{env});
    built.push({architecture,build});
  }
  // The NGX core finds the interface through vkd3d_metalfx.h. ngx.patch offers Frame Generation only where the
  // device's command lists interpolate frames, takes the game's camera from MacLauncher's Streamline proxy
  // (MacLauncherSetTemporalCamera) and passes region offsets, conventions and frame time to the frame.
  const nvngx=path.join(work,'nvngx.dll'),core=path.join(work,'ngx');
  fs.cpSync(path.join(ngx,'ngx'),path.join(core,'ngx'),{recursive:true});
  run('git',['apply','--unsafe-paths','--directory='+core,path.join(here,'ngx.patch')],{cwd:path.resolve(here,'../..')});
  run(path.join(mingw,'x86_64-w64-mingw32-clang++'),['-std=c++20','-O2','-shared','-static','-static-libgcc','-static-libstdc++',
    '-ffile-prefix-map='+core+'=VKD3D-Proton-MacOS','-Wl,--enable-stdcall-fixup','-Wl,--no-insert-timestamp','-I'+here,
    path.join(core,'ngx/nvngx/nvngx.cpp'),'-o',nvngx]);
  fs.mkdirSync(output,{recursive:true});
  for(const {architecture,build}of built){
    const folder=path.join(output,architecture);fs.mkdirSync(folder,{recursive:true});
    for(const name of ['d3d12','d3d12core'])fs.copyFileSync(path.join(build,'libs',name,name+'.dll'),path.join(folder,name+'.dll'));
    if(architecture==='x64')fs.copyFileSync(nvngx,path.join(folder,'nvngx.dll'));
    for(const name of fs.readdirSync(folder))run(path.join(mingw,'llvm-strip'),['--strip-debug',path.join(folder,name)]);
  }
  const version=fs.readFileSync(path.join(source,'meson.build'),'utf8').match(/version\s*:\s*'([^']+)'/)?.[1];
  if(version)fs.writeFileSync(path.join(output,'version'),version+'\n');
  addLicenses(output,'VKD3D-Proton',source);
  addLicenses(output,'MacLauncher',path.resolve(here,'../..'));
  addLicenses(output,'LLVM-MinGW',path.dirname(mingw));
  for(const {architecture}of built)addLicenses(output,'MinGW-w64 '+architecture,path.join(path.dirname(mingw),architecture==='x64'?'x86_64-w64-mingw32':'i686-w64-mingw32','share/mingw32'));
  for(const [name,relative]of [['Vulkan-Headers','khronos/Vulkan-Headers'],['SPIRV-Headers','khronos/SPIRV-Headers'],['dxil-spirv','subprojects/dxil-spirv']])
    addLicenses(output,name,path.join(source,relative));
  // Only the NGX core's own files are used: LGPL-2.1-or-later (from Mullion), like VKD3D-Proton.
  addLicense(output,'VKD3D-Proton-MacOS NGX core',path.join(source,'LICENSE'),'LGPL-2.1');
  return {output,source:{repository:'https://github.com/HansKristian-Work/vkd3d-proton',revision:sourceRevision()},
    ngx:{repository:'https://github.com/metalsharp/VKD3D-Proton-MacOS',revision:ngxRevision()},architectures:built.map(b=>b.architecture)};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].slice(2);if(!['work','output','mingw','glslang','source','ngx','jobs','architectures'].includes(key)||!process.argv[i+1])throw Error('Use --work --output --mingw --glslang and optional --source --ngx --jobs --architectures.');options[key]=process.argv[i+1];}
  if(options.architectures)options.architectures=options.architectures.split(',');
  console.log(JSON.stringify(buildProvider(options)));
}
