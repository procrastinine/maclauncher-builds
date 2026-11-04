import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {retryNetwork} from './download.mjs';
import {checkoutSource,run,recipeMain} from "./build-source.mjs";
import {sealRuntime} from './seal-runtime.mjs';
const require=createRequire(import.meta.url),Builder=require('../producers/maclauncher/src/modules/fna/runtime/build.js');
export const RUNTIMES=Object.freeze({
 arm64:{url:'https://builds.dotnet.microsoft.com/dotnet/Runtime/8.0.32/dotnet-runtime-8.0.32-osx-arm64.tar.gz',sha256:'0e36796c3415bd95c25184fe81386bfc5a5a0b1668ce2f7d8127e03009dec73c',bytes:29113232},
 x64:{url:'https://builds.dotnet.microsoft.com/dotnet/Runtime/8.0.32/dotnet-runtime-8.0.32-osx-x64.tar.gz',sha256:'bb31ec5f4e6f6b85225672f061fd5ffbc463691a03c1338319e4c57403d30aab',bytes:30745959}
});

export async function buildFNA({project,arch,output,work}){
 fs.mkdirSync(work,{recursive:true});const repository='https://github.com/FNA-XNA/FNA',source=checkoutSource({repository,revision:Builder.FNA_REVISION,destination:path.join(work,'upstream-fna')});
 retryNetwork(()=>run('git',['-C',source,'submodule','update','--init','--recursive','--depth','1']));
 const fna3d=checkoutSource({repository:'https://github.com/FNA-XNA/FNA3D',revision:Builder.FNA3D_REVISION,destination:path.join(work,'upstream-fna3d')});retryNetwork(()=>run('git',['-C',fna3d,'submodule','update','--init','--recursive','--depth','1']));
 const runtime=path.join(work,'runtime');fs.mkdirSync(runtime);const archive=await buildInput(RUNTIMES[arch]);run('/usr/bin/tar',['-xzf',archive,'-C',runtime]);
 const downloads=new Map(Object.values(Builder.PACKAGES).map(pin=>[pin.url,pin]));
 await Builder.prepareRuntime({unpacked:runtime,pin:{version:Builder.PROFILE},sourcePath:source,fna3dSourcePath:fna3d,dependencies:{downloadToFile:async(url,destination)=>{const pin=downloads.get(url);if(!pin)throw Error('Undeclared FNA build download.');fs.copyFileSync(await buildInput(pin),destination);}}});

 const dependencies=[source,fna3d].flatMap(directory=>execFileSync('git',['-C',directory,'submodule','status','--recursive'],{maxBuffer:Infinity,encoding:'utf8'}).split('\n').filter(Boolean).map(line=>{const match=/^ ([a-f0-9]{40}) (\S+)/.exec(line);if(!match)throw Error('FNA source dependency is not at its declared pin.');return {path:(directory===source?'FNA/':'FNA3D/')+match[2],revision:match[1],repository:execFileSync('git',['-C',path.join(directory,match[2]),'remote','get-url','origin'],{maxBuffer:Infinity,encoding:'utf8'}).trim()};}));
 const payloads=fs.readdirSync(runtime).filter(name=>name!=='dotnet').map(name=>({source:path.join(runtime,name),relative:'fna/'+name}));
 return sealRuntime({project,arch,output,executable:path.join(runtime,'dotnet'),executableRelative:'fna/dotnet',sourceRoot:source,upstreamRevision:Builder.FNA_REVISION,payloads,provenance:{dependencies,dotnetRuntime:RUNTIMES[arch]},runtimeFiles:{profile:'fna/fna-runtime.json'}});
}
recipeMain(import.meta,buildFNA);
