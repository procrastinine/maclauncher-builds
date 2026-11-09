import './producer-environment.mjs';
import {appSourceRoot} from './app-source.mjs';
import sharedDependencies from '../producers/dependencies.json' with {type:'json'};
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildInput,llvmMingwInput} from './build-input.mjs';
import {publicDeclaration} from './runtime-package.mjs';
/** Shared steps of the scene adapter recipes. */
export const root=path.resolve(import.meta.dirname,'..'),base=appSourceRoot().directory;
export const read=file=>JSON.parse(fs.readFileSync(file));
export const run=(command,args)=>execFileSync(command,args,{maxBuffer:Infinity,stdio:'inherit'});
/** The declared llvm-mingw toolchain for Windows-side adapter libraries. */
export async function mingw(work){
 const pin=sharedDependencies.llvmMingw;
 const archive=await buildInput(llvmMingwInput(),path.join(work,'downloads'));
 const directory=path.join(work,'toolchain');fs.mkdirSync(directory);run('/usr/bin/tar',['-xf',archive,'-C',directory]);
 return path.join(directory,'llvm-mingw-'+pin.version+'-ucrt-macos-universal/bin');
}
export function finish({directory,declaration,output}){
 publicDeclaration(declaration);fs.mkdirSync(output,{recursive:true});
 fs.cpSync(directory,path.join(output,'payload'),{recursive:true});
 fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
 return {project:declaration.id,version:declaration.version,arch:declaration.arch,output};
}
