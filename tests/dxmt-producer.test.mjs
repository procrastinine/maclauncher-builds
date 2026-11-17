import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {crossFile,configureVersion,sourceVersion} from '../producers/dxmt/build.mjs';
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

test('DXMT version metadata comes from the declared source revision',t=>{
 const root=temporary(t),file=path.join(root,'meson.build'),revision='7c8dee1c2d73415301ceb7d1fa810861cef4cd67';
 fs.writeFileSync(file,"dxmt_version = vcs_tag(\n input: 'version.h.in',\n output: 'version.h'\n)\n");
 configureVersion(root,revision);assert.ok(fs.readFileSync(file,'utf8').includes(sourceVersion(revision)));
 assert.throws(()=>configureVersion(root,revision),/source anchor changed/);
});

test('the declared DXMT project separates native arm64 delivery from its build-only Wine SDK',()=>{
 const registry=JSON.parse(fs.readFileSync(new URL('../projects/downloadable.json',import.meta.url))),row=registry.find(row=>row.id==='dxmt');
 assert.deepEqual(row.build.architectures,['arm64']);
 const inputs=JSON.parse(fs.readFileSync(new URL('../producers/dxmt/inputs.json',import.meta.url)));
 for(const name of ['llvm','llvmCmake','wineSdk']){
  assert.match(inputs[name].sha256,/^[a-f0-9]{64}$/);assert.ok(inputs[name].bytes>0);
  assert.ok(row.build.archives.some(item=>item.pointer==='/'+name));
 }
 assert.match(inputs.wineSdk.usage,/no Wine runtime is packaged/);
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
