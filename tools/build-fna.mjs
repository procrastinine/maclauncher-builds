import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {declaredSource,run,recipeMain} from "./build-source.mjs";
import {sealRuntime} from './seal-runtime.mjs';
const require=createRequire(import.meta.url),Builder=require('../producers/package-support/src/modules/fna/runtime/build.js');
// The .NET runtime archives are declared build inputs (the build record's archives).
export const RUNTIMES=Object.freeze(require('../producers/package-support/src/modules/fna/runtime/archives.json').dotnetRuntime);

/** Compile the FNA runtime from its pinned sources and the .NET runtime archive. */
export async function compile({arch,work}){
 fs.mkdirSync(work,{recursive:true});const source=declaredSource('fna','fna'),fna3d=declaredSource('fna','fna3d');
 const runtime=path.join(work,'runtime');fs.mkdirSync(runtime);const archive=await buildInput(RUNTIMES[arch]);run('/usr/bin/tar',['-xzf',archive,'-C',runtime]);
 const downloads=new Map(Object.values(Builder.PACKAGES).map(pin=>[pin.url,pin]));
 const runtimeContext=await Builder.compileRuntime({unpacked:runtime,pin:{version:Builder.PROFILE},sourcePath:source,fna3dSourcePath:fna3d,dependencies:{downloadToFile:async(url,destination)=>{const pin=downloads.get(url);if(!pin)throw Error('Undeclared FNA build download.');fs.copyFileSync(await buildInput(pin),destination);}}});
 return {source,fna3d,runtime,runtimeContext};
}
/** Describe and seal the compiled FNA runtime. */
export async function assemble({project,arch,output,compiled:{source,fna3d,runtime,runtimeContext}}){
 Builder.describeRuntime(runtimeContext);
 const dependencies=[source,fna3d].flatMap(directory=>execFileSync('git',['-C',directory,'submodule','status','--recursive'],{maxBuffer:Infinity,encoding:'utf8'}).split('\n').filter(Boolean).map(line=>{const match=/^ ([a-f0-9]{40}) (\S+)/.exec(line);if(!match)throw Error('FNA source dependency is not at its declared pin.');return {path:(directory===source?'FNA/':'FNA3D/')+match[2],revision:match[1],repository:execFileSync('git',['-C',path.join(directory,match[2]),'remote','get-url','origin'],{maxBuffer:Infinity,encoding:'utf8'}).trim()};}));
 const payloads=fs.readdirSync(runtime).filter(name=>name!=='dotnet').map(name=>({source:path.join(runtime,name),relative:'fna/'+name}));
 return sealRuntime({project,arch,output,executable:path.join(runtime,'dotnet'),executableRelative:'fna/dotnet',sourceRoot:source,upstreamRevision:Builder.FNA_REVISION,payloads,provenance:{dependencies,dotnetRuntime:RUNTIMES[arch]},runtimeFiles:{profile:'fna/fna-runtime.json'}});
}
recipeMain(import.meta,{compile,assemble});
