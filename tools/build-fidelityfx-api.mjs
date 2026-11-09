import './producer-environment.mjs';
import sharedDependencies from '../producers/dependencies.json' with {type:'json'};
import {gitlink,sourceRevision} from '../lib/pins.mjs';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {checkoutSource,recipeMain} from './build-source.mjs';
import {base,read,run,mingw,finish} from './scene-runtime.mjs';
export async function buildFidelityFXAPI({output,work}){
 fs.mkdirSync(work,{recursive:true});
 const producer=path.join(base,'src/modules/crossover/temporal/fidelityfx'),source=read(path.join(producer,'source.json'));
 source.sdk.revision=gitlink('producers/package-support/src/external/fsr3-sdk');
 source.vulkan.revision=sourceRevision(sharedDependencies.sdlHeaders);
 const sdk=checkoutSource({...source.sdk,destination:path.join(work,'sdk')}),vulkan=checkoutSource({...source.vulkan,destination:path.join(work,'vulkan')});
 const compiler=await mingw(work),staged=path.join(work,'staged');
 run(process.execPath,[path.join(producer,'build.mjs'),'--sdk-source',sdk,'--vulkan-source',vulkan,'--compiler',path.join(compiler,'x86_64-w64-mingw32-clang++'),'--out',staged]);
 return finish({directory:path.join(staged,'payload'),declaration:read(path.join(staged,'runtime-package.json')),output});
}
recipeMain(import.meta,buildFidelityFXAPI);
