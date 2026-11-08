import test from 'node:test';import assert from 'node:assert/strict';
import shared from '../producers/dependencies.json' with {type:'json'};
import bridge from '../producers/steam-bridge/source.json' with {type:'json'};
import {source as vulkan} from '../producers/package-support/src/modules/crossover/temporal/vulkan/overlay.mjs';
import {resolveInput} from '../producers/package-support/scripts/build-graphics-runtime.mjs';
test('bridge, Vulkan and graphics toolchain resolve the same shared artifact declarations',()=>{
 assert.equal(shared[bridge.wineDependency],vulkan.archive);
 assert.equal(shared[bridge.toolchainDependency],shared.llvmMingw);
 const input=resolveInput('llvm-mingw');
 assert.equal(input.url,shared.llvmMingw.repository+'/releases/download/'+shared.llvmMingw.version+'/'+shared.llvmMingw.asset);
 assert.equal(input.sha256,shared.llvmMingw.sha256);
});
