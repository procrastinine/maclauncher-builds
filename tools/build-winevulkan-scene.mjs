import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildInput} from './build-input.mjs';
import {recipeMain} from './build-source.mjs';
import {base,read,mingw,finish} from './scene-runtime.mjs';
export async function buildWineVulkanScene({output,work}){
 fs.mkdirSync(work,{recursive:true});
 const producer=path.join(base,'src/modules/crossover/temporal/vulkan'),source=read(path.join(producer,'source.json'));
 const [archive,bisonArchive,moltenvkArchive,compiler]=await Promise.all([
  buildInput(source.archive,path.join(work,'downloads')),buildInput(source.buildTools.bison,path.join(work,'downloads')),
  buildInput(source.vulkanLinkInput.archive,path.join(work,'downloads')),mingw(work)]);
 const module=await import(pathToFileURL(path.join(producer,'build.mjs'))),staged=path.join(work,'staged');
 await module.buildModule({archive,bisonArchive,moltenvkArchive,mingw:compiler,work:path.join(work,'wine'),output:staged,jobs:2});
 return finish({directory:path.join(staged,'payload'),declaration:read(path.join(staged,'runtime-package.json')),output});
}
recipeMain(import.meta,buildWineVulkanScene);
