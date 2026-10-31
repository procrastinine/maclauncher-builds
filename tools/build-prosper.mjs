import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {recipeMain} from './build-source.mjs';
import {buildMoltenVKScene} from './build-vulkan-moltenvk-scene.mjs';
import {build,recipe} from '../producers/prosper/build.mjs';
import {packageLocal} from '../producers/prosper/package.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..');
const run=(command,args)=>execFileSync(command,args,{stdio:'inherit'});
export async function buildProsper({project,arch,output,work}){
 const record=buildRecord(resolveProject('prosper',root,{resolvePins:false}));
 fs.mkdirSync(work,{recursive:true});
 // The driver's source recipe supplies a link input, not an installed local runtime.
 const vulkan=path.join(work,'vulkan-input');
 await buildMoltenVKScene({project:'vulkan-moltenvk-scene',arch:'universal',output:vulkan,work:path.join(work,'vulkan-work')});
 const environment=path.join(work,'python');run('uv',['venv','--python','3.13',environment]);
 const sdk=process.env.SDKROOT||execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim();process.env.SDKROOT=sdk;
 const buildDirectory=path.join(work,'prosper');
 await build({buildDirectory,vulkanLibrary:path.join(vulkan,'payload/libMoltenVK-scene.dylib'),python:path.join(environment,'bin/python'),jobs:4});
 await packageLocal({buildDirectory,output,version:record.version});
 return {project,version:record.version,arch,output,upstreamRevision:recipe.source.revision};
}
recipeMain(import.meta,buildProsper);
