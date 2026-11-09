import './producer-environment.mjs';
import sdlHeaders from '../producers/dependencies/sdlHeaders.json' with {type:'json'};
import {sourceRevision} from '../lib/pins.mjs';
import {upstreamRevision} from '../lib/projects.mjs';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {checkoutSource,recipeMain} from './build-source.mjs';
import {base,read,run,mingw,producerOutput,assemble} from './scene-runtime.mjs';
/** Compile the FidelityFX API adapter with the llvm-mingw toolchain. */
export async function compile({project,work}){
 fs.mkdirSync(work,{recursive:true});
 const producer=path.join(base,'src/modules/crossover/temporal/fidelityfx'),source=read(path.join(producer,'source.json'));
 source.sdk.revision=upstreamRevision(project,'fidelityfx-sdk');
 source.vulkan.revision=sourceRevision(sdlHeaders);
 const sdk=checkoutSource({...source.sdk,destination:path.join(work,'sdk')}),vulkan=checkoutSource({...source.vulkan,destination:path.join(work,'vulkan')});
 const compiler=await mingw(work),staged=path.join(work,'staged');
 run(process.execPath,[path.join(producer,'build.mjs'),'--sdk-source',sdk,'--vulkan-source',vulkan,'--compiler',path.join(compiler,'x86_64-w64-mingw32-clang++'),'--out',staged]);
 return producerOutput(staged);
}
export {assemble};
recipeMain(import.meta,{compile,assemble});
