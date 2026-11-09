import './producer-environment.mjs';
import {recipeMain} from "./build-source.mjs";
import fs from 'node:fs';import path from 'node:path';import{createRequire}from'node:module';;
import{resolveProject,buildRecord}from'../lib/projects.mjs';import{buildInput}from'./build-input.mjs';import{sealRuntime}from'./seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Builder=require('../producers/package-support/src/modules/nscripter/runtime/onscripter-en-build-v3.js');
/** Compile ONScripter-EN and its SDL closure. */
export async function compile({project:id,version,arch,work}){
 const registered=buildRecord(resolveProject(id,root),version);
 fs.mkdirSync(work,{recursive:true});const sourceDir=path.join(root,'producers/package-support/src/external/onscripter-en'),raw=path.join(work,'compiled');
 const manager={core:{getInstallDir:()=>raw,registerLocal:options=>options}};
 const result=await Builder.buildRuntime({manager,userDataDir:work,packageVersion:registered.version,sourceDir,architecture:arch,retainBuildDirectory:true,dependencies:{downloadToFile:async(url,destination)=>{const pin=Object.values(Builder.PACKAGES).find(row=>row.url===url);if(!pin)throw Error('Undeclared source archive.');fs.copyFileSync(await buildInput(pin),destination);}}});
 return {sourceDir,raw,result};
}
/** Seal the compiled runtime with its descriptor, then remove the retained build directory. */
export async function assemble({project:id,version,arch,output,compiled:{sourceDir,raw,result}}){
 const project=resolveProject(id,root),registered=buildRecord(project,version);
 try{
  const input=path.join(raw,'files');
  return await sealRuntime({project:id,version:registered.version,arch,output,executable:result.runtimePath,sourceRoot:sourceDir,sourceScope:Builder.SOURCE_SCOPE,upstreamRevision:project.upstreams[0].revision,extraLibraries:[path.join(input,'lib','libSDL2-2.0.0.dylib')],payloads:[{source:path.join(input,'onscripter-en-runtime.json'),relative:'onscripter-en-runtime.json'}]});
 }finally{if(result?.verifiedBuild?.buildDirectory)fs.rmSync(result.verifiedBuild.buildDirectory,{recursive:true,force:true});}
}
recipeMain(import.meta,{compile,assemble});
