import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import llvmMingw from '../producers/dependencies/llvmMingw.json' with {type:'json'};
import bridge from '../producers/steam-bridge/source.json' with {type:'json'};
import {source as vulkan} from '../producers/package-support/src/modules/crossover/temporal/vulkan/overlay.mjs';
import {resolveInput} from '../producers/package-support/scripts/build-graphics-runtime.mjs';
test('bridge, Vulkan and graphics toolchain resolve the same shared artifact declarations',()=>{
 const shared=id=>JSON.parse(fs.readFileSync(new URL('../producers/dependencies/'+id+'.json',import.meta.url)));
 assert.deepEqual(shared(bridge.wineDependency),vulkan.archive);
 assert.deepEqual(shared(bridge.toolchainDependency),llvmMingw);
 const input=resolveInput('llvm-mingw');
 assert.equal(input.url,llvmMingw.repository+'/releases/download/'+llvmMingw.version+'/'+llvmMingw.asset);
 assert.equal(input.sha256,llvmMingw.sha256);
});
