import './producer-environment.mjs';
import sharedDependencies from '../producers/dependencies.json' with {type:'json'};
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildInput} from './build-input.mjs';
import {recipeMain} from './build-source.mjs';
import {base,read,mingw,producerOutput,assemble as sceneAssemble} from './scene-runtime.mjs';
const directory=path.join(base,'src/modules/crossover/temporal/vulkan'),producer=()=>import(pathToFileURL(path.join(directory,'build.mjs')));
/** The shipped module libraries: the compile phase's only output. */
const compiled=work=>path.join(work,'compiled');
/** Download the declared Wine, Bison and MoltenVK archives and the toolchain, and project the Wine source; nothing is compiled. */
export async function prepare({work}){
 fs.mkdirSync(work,{recursive:true});
 const source=read(path.join(directory,'source.json')),downloads=path.join(work,'downloads');
 const [archive,bisonArchive,moltenvkArchive,compiler]=await Promise.all([
  buildInput(sharedDependencies[source.archiveDependency],downloads),buildInput(source.buildTools.bison,downloads),
  buildInput(sharedDependencies.moltenvk.archive,downloads),mingw(work)]);
 const wine=path.join(work,'wine');
 return {bisonArchive,moltenvkArchive,mingw:compiler,wine,source:await (await producer()).prepareSource({archive,work:wine})};
}
/** Build Bison and the Wine Vulkan modules, then stage the shipped module libraries. */
export async function compile({work,prepared:{bisonArchive,moltenvkArchive,mingw:compiler,wine,source}}){
 const module=await producer();
 module.finishModule(await module.buildModule({prepared:source,bisonArchive,moltenvkArchive,mingw:compiler,work:wine,jobs:2}),compiled(work));
}
/** Describe the compiled module libraries and package them. */
export async function assemble({output,work,prepared:{source}}){
 const module=await producer(),staged=path.join(work,'staged');
 for(const file of module.MODULE_FILES){fs.mkdirSync(path.dirname(path.join(staged,file)),{recursive:true});fs.copyFileSync(path.join(compiled(work),file),path.join(staged,file));}
 module.describeModule({directory:source.directory,output:staged});
 return sceneAssemble({output,compiled:producerOutput(staged)});
}
recipeMain(import.meta,{prepare,compile,assemble});
