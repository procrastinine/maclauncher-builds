import {recipeMain} from './build-source.mjs';
import fs from 'node:fs';import path from 'node:path';import{createRequire}from'node:module';import{collectSdlNotices}from'./sdl-notices.mjs';
import{resolveProject,buildRecord}from'../lib/projects.mjs';import{buildInput}from'./build-input.mjs';import{sealRuntime}from'./seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Builder=require('../producers/maclauncher/src/modules/nscripter/runtime/onscripter-en-build-v3.js');
export async function buildONS({project:id,version,arch,work,output}){
 const project=resolveProject(id,root),registered=buildRecord(project,version);
 fs.mkdirSync(work,{recursive:true});const sourceDir=path.join(root,'producers/maclauncher/src/external/onscripter-en'),raw=path.join(work,'compiled');let result;
 const manager={core:{getInstallDir:()=>raw,registerLocal:options=>options}};
 try{
  result=await Builder.buildRuntime({manager,userDataDir:work,packageVersion:registered.version,sourceDir,architecture:arch,retainBuildDirectory:true,dependencies:{downloadToFile:async(url,destination)=>{const pin=Object.values(Builder.PACKAGES).find(row=>row.url===url);if(!pin)throw Error('Undeclared source archive.');fs.copyFileSync(await buildInput(pin),destination);}}});
  const input=path.join(raw,'files'),notices=result.verifiedBuild.notices.map(row=>({...row,file:path.join(input,row.path)}));
  notices.push(...collectSdlNotices({source:result.sdl2Source,output:path.join(work,'sdl-notices'),name:'SDL2 '+result.verifiedBuild.nativeVersions.sdl2,sourceUrl:Builder.PACKAGES.sdl2.url,includeLibm:true}).notices);
  return await sealRuntime({project:id,version:registered.version,arch,output,executable:result.runtimePath,sourceRoot:sourceDir,sourceScope:Builder.SOURCE_SCOPE,upstreamRevision:project.upstreams[0].revision,notices,payloads:[{source:path.join(input,'onscripter-en-runtime.json'),relative:'onscripter-en-runtime.json'}]});
 }finally{if(result?.verifiedBuild?.buildDirectory)fs.rmSync(result.verifiedBuild.buildDirectory,{recursive:true,force:true});}
}
recipeMain(import.meta,buildONS);
