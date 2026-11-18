import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {crossFile,nativeFile,configureVersion,sourceVersion} from '../producers/dxmt/build.mjs';
import {buildRecord} from '../lib/projects.mjs';
import {applyWindowOverlay} from '../producers/dxmt/window-overlay.mjs';
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'dxmt-producer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};

test('the DXMT cross file preserves the upstream ARM64X compile and link contract',t=>{
 const root=temporary(t),bin=path.join(root,'bin');fs.mkdirSync(bin);
 const files=['clang','clang++','ar','strip','windres'].map(name=>path.join(bin,'arm64ec-w64-mingw32-'+name));
 for(const file of files)fs.writeFileSync(file,'');
 const text=crossFile({compiler:root});
 for(const key of ['c_args','cpp_args','c_link_args','cpp_link_args'])assert.ok(text.includes(key+" = ['-marm64x']"));
 assert.match(text,/cpu_family = 'aarch64'/);assert.match(text,/needs_exe_wrapper = true/);
 fs.unlinkSync(files[1]);assert.throws(()=>crossFile({compiler:root}),/lacks ARM64EC clang\+\+/);
});

test('DXMT machine files hold only single-quoted Meson strings',t=>{
 const root=temporary(t),bin=path.join(root,'bin');fs.mkdirSync(bin);
 for(const name of ['clang','clang++','ar','strip','windres'])fs.writeFileSync(path.join(bin,'arm64ec-w64-mingw32-'+name),'');
 const native=nativeFile({clang:"/X/it's/clang",clangxx:'/X/clang++',args:['-arch','arm64','-ffile-prefix-map=/w=source/dxmt']});
 for(const text of [crossFile({compiler:root}),native])assert.doesNotMatch(text,/"/);
 assert.ok(native.includes("c = '/X/it\\'s/clang'"));
 assert.ok(native.includes("c_args = ['-arch', 'arm64', '-ffile-prefix-map=/w=source/dxmt']"));
 assert.ok(native.includes("cpp_link_args = ['-arch', 'arm64']"));
});


test('DXMT Meson uses the same pinned Ninja as LLVM with no host Ninja on PATH',async t=>{
 const work=temporary(t),compiler=path.join(work,'llvm-mingw'),bin=path.join(work,'build-tools','tools','bin');
 const source=fs.readFileSync(new URL('../producers/dxmt/build.mjs',import.meta.url),'utf8');
 const start=source.indexOf('export async function compile('),end=source.indexOf('export async function inspectBuiltPayload(',start);
 assert.ok(start>=0&&end>start);
 const calls=[],hostPath='/usr/bin:/bin';
 const compile=vm.runInNewContext(source.slice(start,end).replace(/^export /,'')+'\ncompile',{
  path,fs:{realpathSync:fs.realpathSync,statSync:()=>({isFile:()=>true}),writeFileSync:()=>{}},
  inputs:{minimumMacOS:'15.0'},process:{env:{PATH:hostPath,NINJA:'/host/unpinned/ninja'}},
  findBuildTool:name=>'/usr/bin/'+name,read:(_command,args)=>'/sdk/'+args.at(-1),
  reproducibleEnvironment:env=>env,crossFile:()=>'',nativeFile:()=>'',write:()=>{},
  run:(command,args,{env})=>calls.push({command,action:args[0],args:Array.from(args),env})
 });
 await compile({work,prepared:{compiler,tools:{bin},source:path.join(work,'source'),sdk:path.join(work,'wine-sdk'),llvmSource:path.join(work,'llvm-source')}});
 const ninja=path.join(bin,'ninja');
 assert.ok(calls[0].args.includes('-DCMAKE_MAKE_PROGRAM='+ninja));
 const meson=calls.filter(call=>call.command===path.join(bin,'meson'));
 assert.deepEqual(meson.map(call=>call.action),['setup','compile','install']);
 for(const call of meson){
  assert.equal(call.env.NINJA,ninja);
  assert.equal(call.env.PATH,path.join(compiler,'bin')+path.delimiter+hostPath);
 }
});

test('DXMT version metadata comes from the declared source revision',t=>{
 const root=temporary(t),file=path.join(root,'meson.build'),revision='7c8dee1c2d73415301ceb7d1fa810861cef4cd67';
 fs.mkdirSync(path.join(root,'include'));fs.writeFileSync(path.join(root,'version.h.in'),'#pragma once\n\n#define DXMT_VERSION "@VCS_TAG@"\n');
 fs.writeFileSync(file,"dxmt_version = vcs_tag(\n input: 'version.h.in',\n output: 'version.h'\n)\nstatic_library('dxmt', dxmt_version)\n");
 configureVersion(root,revision);
 // The header sits in the searched include folder; Meson generates no second one.
 assert.equal(fs.readFileSync(path.join(root,'include/version.h'),'utf8'),'#pragma once\n\n#define DXMT_VERSION "v0.80-244-g7c8dee1"\n');
 assert.equal(fs.readFileSync(file,'utf8'),"dxmt_version = []\nstatic_library('dxmt', dxmt_version)\n");
 assert.throws(()=>configureVersion(root,revision),/source anchor changed/);
});

test('the declared DXMT builds keep separate arm64 SDK and x64 publisher inputs',()=>{
 const registry=JSON.parse(fs.readFileSync(new URL('../projects/downloadable.json',import.meta.url))),row=registry.find(row=>row.id==='dxmt');
 const arm=buildRecord(row,'0.80-244-g7c8dee1-MCLv1');
 const intel=buildRecord(row,'0.80.244');
 assert.deepEqual(arm?.architectures,['arm64']);
 assert.deepEqual(intel?.architectures,['x64']);
 assert.equal(arm.command,intel.command);
 const inputs=JSON.parse(fs.readFileSync(new URL('../producers/dxmt/inputs.json',import.meta.url)));
 for(const name of ['llvm','llvmCmake','wineSdk']){
  assert.match(inputs[name].sha256,/^[a-f0-9]{64}$/);assert.ok(inputs[name].bytes>0);
  assert.ok(arm.archives.some(item=>item.pointer==='/'+name));
  assert.ok(!intel.archives.some(item=>item.pointer==='/'+name));
 }
 assert.match(inputs.wineSdk.usage,/no Wine runtime is packaged/);
 const template=JSON.parse(fs.readFileSync(new URL('../producers/dxmt/x64-template.json',import.meta.url)));
 assert.deepEqual(intel.archives.find(item=>item.pointer==='/archive'),
  {file:'producers/dxmt/x64-template.json',pointer:'/archive'});
 assert.match(template.archive.url,/github[.]com\/Sikarugir-App\/Template\/releases\/download\//);
 assert.match(template.archive.sha256,/^[a-f0-9]{64}$/);
 assert.ok(template.archive.bytes>0);
 for(const name of ['x86_64-windows/d3d10core.dll','x86_64-windows/d3d11.dll',
  'x86_64-windows/winemetal.dll','x86_64-unix/winemetal.so'])
  assert.match(template.files[name],/^[a-f0-9]{64}$/);
});

test('the Wine window adapter retains both original call tables and appends one matching operation',t=>{
 const source=path.resolve(import.meta.dirname,'../producers/package-support/src/external/dxmt-camera');
 if(!fs.existsSync(path.join(source,'src/winemetal/unix/winemetal_unix.c')))return t.skip('Optional DXMT source is not initialized.');
 const root=temporary(t),files=['src/winemetal/winemetal.h','src/winemetal/winemetal_thunks.h','src/winemetal/winemetal_thunks.c','src/winemetal/unix/winemetal_unix.c','src/d3d11/d3d11_swapchain.cpp','src/d3d12/d3d12_swapchain.cpp'];
 for(const file of files){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(source,file),target);}
 const unix=path.join(root,'src/winemetal/unix/winemetal_unix.c'),before=fs.readFileSync(unix,'utf8');
 const tables=text=>[...text.matchAll(/const void \*__wine_unix_call(?:_wow64)?_funcs\[\] = \{([\s\S]+?)\};/g)].map(match=>match[1].split(',').map(s=>s.trim()).filter(Boolean));
 assert.ok(!before.includes('objc_getClass("WineWindow")'));
 const abi=applyWindowOverlay(root),after=fs.readFileSync(unix,'utf8'),original=tables(before),adapted=tables(after);
 assert.equal(adapted.length,2);assert.equal(abi.tableCount,abi.originalTableCount+1);
 for(let i=0;i<2;i++)assert.deepEqual(adapted[i],[...original[i],'&_UpdateMetalViewPlacement']);
 assert.ok(after.includes('objc_getClass("WineWindow")'));assert.ok(after.includes('pfn_release_win_data(win_data)'));
 assert.ok(after.includes('dispatch_async(dispatch_get_main_queue()'));assert.ok(!after.includes('dispatch_sync(dispatch_get_main_queue(), ^{ DXMTPlace'));
 for(const api of ['d3d11','d3d12'])assert.ok(fs.readFileSync(path.join(root,'src',api,api+'_swapchain.cpp'),'utf8').includes('UpdateMetalViewPlacement((intptr_t)hWnd, native_view_.handle)'));
 assert.throws(()=>applyWindowOverlay(root),/source anchor changed/);
});
