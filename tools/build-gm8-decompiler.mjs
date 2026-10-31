import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {rustNotices,rustEnvironment} from './rust-build.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {recipeMain} from './build-source.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
export async function buildGM8Decompiler({project:id,version,arch,output,work}){
 const source=path.join(root,'producers/maclauncher/src/external/OpenGMK'),project=resolveProject(id),revision=project.upstreams[0].revision;
 const {prepareDecompiler}=require('../producers/maclauncher/src/modules/gamemaker/overlays/opengmk-macos/source-build.js');
 const Source=require('../producers/maclauncher/src/modules/shared/runtime/pinned-native-build.js');
 await Source.validatePinnedSource(source,revision);fs.mkdirSync(work,{recursive:true});
 try {
  const owned=path.join(work,'source');fs.cpSync(source,owned,{recursive:true,filter:file=>!['.git','target'].includes(path.basename(file))});
  const tools=prepareDecompiler({sourceDir:owned,output:work}),target=arch==='x64'?'x86_64-apple-darwin':'aarch64-apple-darwin';
  fs.copyFileSync(path.join(root,'producers/maclauncher/helper-builds/gm8-decompiler.lock'),path.join(owned,'Cargo.lock'));
  const env=rustEnvironment({work,minimumMacOS:'11.0',env:{...process.env,PATH:[tools,path.dirname(process.execPath),process.env.PATH].join(path.delimiter)}});
  execFileSync('cargo',['build','--release','--locked','--target',target,'--package','gm8decompiler'],{cwd:owned,stdio:'inherit',timeout:900000,env});
  return await sealRuntime({project:id,version,arch,executable:path.join(work,'target',target,'release/gm8decompiler'),sourceRoot:source,upstreamRevision:revision,output,maximumMacOS:'11.0',
   notices:[{file:path.join(source,'LICENCE.md'),name:'OpenGMK',license:'GPL-2.0-only',sourceUrl:'https://github.com/OpenGMK/OpenGMK'},...rustNotices({source:owned,output:path.join(work,'notices'),env})]});
 }finally{fs.rmSync(work,{recursive:true,force:true});}
}
recipeMain(import.meta,buildGM8Decompiler);
