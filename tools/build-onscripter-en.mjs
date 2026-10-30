import fs from 'node:fs';import path from 'node:path';import{createRequire}from'node:module';import{pathToFileURL}from'node:url';
import{resolveProject,buildRecord}from'../lib/projects.mjs';import{buildInput}from'./build-input.mjs';import{sealRuntime}from'./seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Builder=require('../producers/maclauncher/src/modules/nscripter/runtime/onscripter-en-build-v3.js');
export async function buildONS({project:id,arch,work,output}){
 const project=resolveProject(id,root),registered=buildRecord(project);if(id!=='onscripter-en'||!['arm64','x64'].includes(arch)||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select ONScripter-EN, CPU and new work/output paths.');
 fs.mkdirSync(work,{recursive:true});const sourceDir=path.join(root,'producers/maclauncher/src/external/onscripter-en'),raw=path.join(work,'compiled');let result;
 const manager={core:{getInstallDir:()=>raw,registerLocal:options=>options}};
 try{
  result=await Builder.buildRuntime({manager,userDataDir:work,version:registered.version,sourceDir,architecture:arch,retainBuildDirectory:true,dependencies:{downloadToFile:async(url,destination)=>{const pin=Object.values(Builder.PACKAGES).find(row=>row.url===url);if(!pin)throw Error('Undeclared source archive.');fs.copyFileSync(await buildInput(pin),destination);}}});
  const input=path.join(raw,'files'),notices=result.verifiedBuild.notices.map(row=>({...row,file:path.join(input,row.path)}));
  return await sealRuntime({project:id,arch,output,executable:result.runtimePath,sourceRoot:sourceDir,sourceScope:Builder.SOURCE_SCOPE,upstreamRevision:project.upstreams[0].revision,notices,payloads:[{source:path.join(input,'onscripter-en-runtime.json'),relative:'onscripter-en-runtime.json'}]});
 }finally{if(result?.verifiedBuild?.buildDirectory)fs.rmSync(result.verifiedBuild.buildDirectory,{recursive:true,force:true});}
}
export async function main(args){const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','arch','output','work'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project, --arch, --output and --work.');options[key]=args[i+1];}return buildONS(options);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
