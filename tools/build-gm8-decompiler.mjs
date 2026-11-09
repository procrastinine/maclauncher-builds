import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {rustEnvironment} from "./rust-build.mjs";
import {sealRuntime} from './seal-runtime.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {recipeMain} from './build-source.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
/** Compile the GameMaker 8 decompiler from its owned source copy. */
export async function compile({project:id,arch,work}){
 const source=path.join(root,'producers/package-support/src/external/OpenGMK'),project=resolveProject(id),revision=project.upstreams[0].revision;
 const {prepareDecompiler}=require('../producers/package-support/src/modules/gamemaker/overlays/opengmk-macos/source-build.js');
 const Source=require('../producers/package-support/src/modules/shared/runtime/pinned-native-build.js');
 await Source.validatePinnedSource(source,revision);fs.mkdirSync(work,{recursive:true});
 try {
  const owned=path.join(work,'source');fs.cpSync(source,owned,{recursive:true,filter:file=>!['.git','target'].includes(path.basename(file))});
  const tools=prepareDecompiler({sourceDir:owned,output:work}),target=arch==='x64'?'x86_64-apple-darwin':'aarch64-apple-darwin';
  fs.copyFileSync(path.join(root,'producers/package-support/helper-builds/gm8-decompiler.lock'),path.join(owned,'Cargo.lock'));
  const env=rustEnvironment({work,minimumMacOS:'11.0',env:{...process.env,PATH:[tools,path.dirname(process.execPath),process.env.PATH].join(path.delimiter)}});
  execFileSync('cargo',['build','--release','--locked','--target',target,'--package','gm8decompiler'],{maxBuffer:Infinity,cwd:owned,stdio:'inherit',timeout:900000,env});
  return {owned,env,target,source,revision};
 }catch(error){fs.rmSync(work,{recursive:true,force:true});throw error;}
}
/** Seal the compiled decompiler, then remove the work tree. */
export async function assemble({project:id,version,arch,output,work,compiled:{owned,env,target,source,revision}}){
 try{
  return await sealRuntime({cargoRoot:owned,env,project:id,version,arch,executable:path.join(work,'target',target,'release/gm8decompiler'),sourceRoot:source,upstreamRevision:revision,output});
 }finally{fs.rmSync(work,{recursive:true,force:true});}
}
recipeMain(import.meta,{compile,assemble});
