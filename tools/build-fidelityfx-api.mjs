import './producer-environment.mjs';
import vulkanHeaders from '../producers/dependencies/vulkanHeaders.json' with {type:'json'};
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {declaredSource,recipeMain} from './build-source.mjs';
import {root,base,run,mingw,producerOutput,assemble} from './scene-runtime.mjs';
/** Compile the FidelityFX API adapter with the llvm-mingw toolchain. */
export async function compile({project,work}){
 fs.mkdirSync(work,{recursive:true});
 const producer=path.join(base,'src/modules/crossover/temporal/fidelityfx');
 const sdk=declaredSource(project,'fidelityfx-sdk'),vulkan=declaredSource(vulkanHeaders);
 const compiler=await mingw(work),staged=path.join(work,'staged');
 run(process.execPath,[path.join(producer,'build.mjs'),'--sdk-source',sdk,'--vulkan-source',vulkan,'--carrier-headers',path.join(root,'producers/vkd3d-proton'),'--compiler',path.join(compiler,'x86_64-w64-mingw32-clang++'),'--out',staged]);
 return producerOutput(staged);
}
export {assemble};
recipeMain(import.meta,{compile,assemble});
