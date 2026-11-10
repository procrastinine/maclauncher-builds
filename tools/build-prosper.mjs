import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {recipeMain} from './build-source.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {buildPython} from './python-build-tools.mjs';
import {build,recipe} from '../producers/prosper/build.mjs';
import {packageLocal} from '../producers/prosper/package.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..');
/** Compile Prosper against the MoltenVK scene driver package, a declared build input. */
export async function compile({work}){
 const record=buildRecord(resolveProject('prosper',root,{resolvePins:false}));
 fs.mkdirSync(work,{recursive:true});
 const vulkan=preparedBuildInput('vulkan-moltenvk-scene');if(!vulkan)throw Error('The Prosper build needs the vulkan-moltenvk-scene input.');
 const python=await buildPython(work);
 const sdk=process.env.SDKROOT||execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{maxBuffer:Infinity,encoding:'utf8'}).trim();process.env.SDKROOT=sdk;
 const buildDirectory=path.join(work,'prosper');
 await build({buildDirectory,vulkanLibrary:path.join(vulkan.root,'libMoltenVK-scene.dylib'),python,jobs:4});
 return {buildDirectory,record};
}
/** Package the compiled Prosper build. */
export async function assemble({project,arch,output,compiled:{buildDirectory,record}}){
 await packageLocal({buildDirectory,output,version:record.version});
 return {project,version:record.version,arch,output,upstreamRevision:recipe.source.revision};
}
recipeMain(import.meta,{compile,assemble});
