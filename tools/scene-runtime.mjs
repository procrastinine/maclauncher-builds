import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {publicDeclaration} from './runtime-package.mjs';
/** Shared steps of the scene adapter recipes. */
export const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/maclauncher');
export const read=file=>JSON.parse(fs.readFileSync(file));
export const run=(command,args)=>execFileSync(command,args,{stdio:'inherit'});
/** The declared llvm-mingw toolchain for Windows-side adapter libraries. */
export async function mingw(work){
 const pin=read(path.join(base,'src/modules/crossover/temporal/xess/source.json')).toolchain;
 const archive=await buildInput({url:pin.repository+'/releases/download/'+pin.version+'/'+pin.asset,sha256:pin.sha256},path.join(work,'downloads'));
 const directory=path.join(work,'toolchain');fs.mkdirSync(directory);run('/usr/bin/tar',['-xf',archive,'-C',directory]);
 return path.join(directory,'llvm-mingw-'+pin.version+'-ucrt-macos-universal/bin');
}
export function finish({directory,declaration,output}){
 publicDeclaration(declaration);fs.mkdirSync(output,{recursive:true});
 fs.cpSync(directory,path.join(output,'payload'),{recursive:true});
 fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
 return {project:declaration.id,version:declaration.version,arch:declaration.arch,output};
}
