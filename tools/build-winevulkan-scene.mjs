import './producer-environment.mjs';
import sharedDependencies from '../producers/dependencies.json' with {type:'json'};
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildInput} from './build-input.mjs';
import {recipeMain} from './build-source.mjs';
import {base,read,mingw,producerOutput,assemble} from './scene-runtime.mjs';
/** Compile the Wine Vulkan scene adapter from the declared Wine, Bison and MoltenVK archives. */
export async function compile({work}){
 fs.mkdirSync(work,{recursive:true});
 const producer=path.join(base,'src/modules/crossover/temporal/vulkan'),source=read(path.join(producer,'source.json'));
 const [archive,bisonArchive,moltenvkArchive,compiler]=await Promise.all([
  buildInput(sharedDependencies[source.archiveDependency],path.join(work,'downloads')),buildInput(source.buildTools.bison,path.join(work,'downloads')),
  buildInput(sharedDependencies.moltenvk.archive,path.join(work,'downloads')),mingw(work)]);
 const module=await import(pathToFileURL(path.join(producer,'build.mjs'))),staged=path.join(work,'staged');
 await module.buildModule({archive,bisonArchive,moltenvkArchive,mingw:compiler,work:path.join(work,'wine'),output:staged,jobs:2});
 return producerOutput(staged);
}
export {assemble};
recipeMain(import.meta,{compile,assemble});
