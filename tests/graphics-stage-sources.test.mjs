import test from 'node:test';
import {sourceRevision} from '../lib/pins.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {plan} from '../producers/package-support/scripts/build-graphics-runtime.mjs';
test('graphics staging validates the SPIRV-Cross checkout supplied by the build',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-stage-source-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const checkout=path.join(root,'shared-cross'),sdk=path.join(root,'sdk');
 fs.mkdirSync(checkout);fs.mkdirSync(sdk);fs.writeFileSync(path.join(sdk,'SDKSettings.json'),JSON.stringify({Version:'27.0'}));
 const git=args=>execFileSync('git',['-C',checkout,...args],{encoding:'utf8',stdio:'pipe'}).trim();
 git(['init']);fs.writeFileSync(path.join(checkout,'README'),'source\n');git(['add','README']);
 git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','source']);
 const revision=git(['rev-parse','HEAD']);
 const planned=plan({work:root,only:['core'],sdkPath:sdk,sources:{'macfx-spirv-cross':checkout}});
 assert.equal(planned.stage[planned.stage.indexOf('--spirv-cross-source')+1],checkout);
 const file=fileURLToPath(new URL('../producers/package-support/scripts/stage-reshade.mjs',import.meta.url)),text=fs.readFileSync(file,'utf8');
 const block=text.slice(text.indexOf('const pins = registeredSources.sources.map'),text.indexOf('const nativeFiles ='))+'\npins;';
 const context={path,execFileSync,upstreamRoot:root,options:{'--spirv-cross-source':checkout},
  registeredSources:{sources:[{id:'macfx-spirv-cross',sourcePath:'third_party/spirv-cross',submodulePath:'removed-checkout'}]},
  consumed:new Set(['third_party/spirv-cross']),sharedDependencies:{spirvCross:{revision}},sourceRevision};
 assert.deepEqual([...vm.runInNewContext(block,{...context})],[` ${revision} third_party/spirv-cross`]);
 context.sharedDependencies.spirvCross.revision='0'.repeat(40);
 assert.throws(()=>vm.runInNewContext(block,{...context}),/Initialize the selected graphics source commit/);
});
test('processor declaration consistency uses validated source paths without copied commit fields',()=>{
 const file=fileURLToPath(new URL('../producers/package-support/scripts/stage-reshade.mjs',import.meta.url)),text=fs.readFileSync(file,'utf8');
 const block=text.slice(text.indexOf('const processorSources='),text.indexOf('let libplacebo;')).replaceAll('import.meta.dirname',JSON.stringify(path.dirname(file)));
 const metadata={schema:1,baseSourceHash:'fixture-base',sources:[{sourcePath:'third_party/spirv-cross'}]},extraOwned=new Map();
 const context={path,fs:{existsSync:()=>true,readFileSync:name=>JSON.stringify(name.endsWith('processor-sources.json')?metadata:{baseSourceHash:'fixture-base'})},
  pins:[' '+ 'a'.repeat(40)+' third_party/spirv-cross'],consumed:new Set(['third_party/spirv-cross']),extraOwned};
 vm.runInNewContext(block,{...context});assert.ok(extraOwned.has('maclauncher/native/processor-sources.json'));
 assert.throws(()=>vm.runInNewContext(block,{...context,pins:[]}),/processor source identities differ/);
});
