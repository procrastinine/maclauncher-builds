import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {runtimeBuildEnvironment} from '../tools/runtime-build-environment.mjs';
import {providerPath} from '../producers/vkd3d-proton/build.mjs';
const script=(file,body)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'#!/bin/sh\n'+body+'\n',{mode:0o755});};
const which=(name,PATH)=>execFileSync('/usr/bin/which',[name],{env:{PATH},encoding:'utf8'}).trim();

test('declared formulae come ahead of the Xcode toolchain directory, except a formula with its own clang',{skip:process.platform!=='darwin'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'build-tool-order-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 // Homebrew keeps bison and llvm keg-only: brew --prefix names their own prefixes.
 script(path.join(root,'host/brew'),`case "$1" in deps) ;; --prefix) printf '%s\\n' "${root}/prefix/$2" ;; *) exit 1 ;; esac`);
 script(path.join(root,'prefix/bison/bin/bison'),'printf formula-bison');
 script(path.join(root,'prefix/llvm/bin/clang'),'printf formula-clang');
 const context=runtimeBuildEnvironment({tools:['bison','llvm']},{environment:{...process.env,PATH:[path.join(root,'host'),'/usr/bin','/bin'].join(path.delimiter)},platform:'darwin'});
 t.after(()=>context.dispose());
 const xcode=path.dirname(execFileSync('/usr/bin/xcrun',['--find','clang'],{encoding:'utf8'}).trim());
 assert.equal(which('bison',context.env.PATH),path.join(root,'prefix/bison/bin/bison'));
 assert.equal(which('clang',context.env.PATH),path.join(xcode,'clang'));
 const entries=context.env.PATH.split(path.delimiter);
 assert.ok(entries.indexOf(path.join(root,'prefix/llvm/bin'))>entries.indexOf(xcode));
});

test('VKD3D-Proton meson setup finds the ninja its compile step runs',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vkd3d-ninja-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const ninja=path.join(root,'build-tools/bin/ninja');script(ninja,'printf pinned-ninja');
 const PATH=providerPath({ninja,mingw:path.join(root,'mingw/bin')},'/usr/bin:/bin');
 assert.equal(execFileSync('/usr/bin/env',['ninja'],{env:{PATH},encoding:'utf8'}),'pinned-ninja');
 assert.equal(providerPath({ninja:'ninja',mingw:'/m'},'/usr/bin'),['/m','/usr/bin'].join(path.delimiter));
});
