import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildOptions} from './build-source.mjs';
import {buildSceneRuntime} from './build-scene-runtime.mjs';
import {build,recipe} from '../producers/prosper/build.mjs';
import {packageLocal} from '../producers/prosper/package.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..');
const run=(command,args)=>execFileSync(command,args,{stdio:'inherit'});
export async function buildProsper({project,arch,output,work}){
 const record=buildRecord(resolveProject('prosper',root,{resolvePins:false}));
 if(project!=='prosper'||arch!=='x64'||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select Prosper for Intel and new absolute output/work directories.');
 fs.mkdirSync(work,{recursive:true});
 // The driver's source recipe supplies a link input, not an installed local runtime.
 const vulkan=path.join(work,'vulkan-input');
 await buildSceneRuntime({project:'vulkan-moltenvk-scene',arch:'universal',output:vulkan,work:path.join(work,'vulkan-work')});
 const environment=path.join(work,'python');run('uv',['venv','--python','3.13',environment]);
 const sdk=process.env.SDKROOT||execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim();process.env.SDKROOT=sdk;
 const buildDirectory=path.join(work,'prosper');
 await build({buildDirectory,vulkanLibrary:path.join(vulkan,'payload/libMoltenVK-scene.dylib'),python:path.join(environment,'bin/python'),jobs:4});
 await packageLocal({buildDirectory,output,version:record.version});
 return {project,version:record.version,arch,output,upstreamRevision:recipe.source.revision};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)buildProsper(buildOptions(process.argv.slice(2))).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
