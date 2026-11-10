import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import bridge from '../producers/steam-bridge/source.json' with {type:'json'};
import vulkan from '../producers/package-support/src/modules/crossover/temporal/vulkan/source.json' with {type:'json'};
import graphics from '../producers/package-support/scripts/graphics-runtime.json' with {type:'json'};
// Each consumer names its shared artifact record in its own declaration; the records are read
// from those declarations alone, without loading any consumer's build code.
const record=id=>new URL('../producers/dependencies/'+id+'.json',import.meta.url);
test('bridge, Vulkan and graphics toolchain resolve the same shared artifact declarations',()=>{
 assert.equal(vulkan.archiveDependency,bridge.wineDependency);
 assert.ok(fs.existsSync(record(bridge.wineDependency)));
 const toolchain=graphics.inputs['llvm-mingw'].pin;
 // The graphics recipe resolves a pin file against its producer directory (recipePath).
 assert.equal(new URL(toolchain.file,new URL('../producers/package-support/',import.meta.url)).href,record(bridge.toolchainDependency).href);
 assert.equal(toolchain.pointer,'');
 assert.ok(fs.existsSync(record(bridge.toolchainDependency)));
});
