import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {rustNotices,rustEnvironment} from './rust-build.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {resolveProject} from '../lib/projects.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),o={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]?.slice(2);if(!['project','arch','output','work'].includes(key)||!process.argv[i+1]||Object.hasOwn(o,key))throw Error('Use --project, --arch, --output and --work.');o[key]=process.argv[i+1];}
if(o.project!=='gm8-decompiler'||!['arm64','x64'].includes(o.arch)||!path.isAbsolute(o.work||'')||fs.existsSync(o.work))throw Error('Select gm8-decompiler, arm64 or x64, and a new absolute work directory.');
const source=path.join(root,'producers/maclauncher/src/external/OpenGMK'),project=resolveProject(o.project),revision=project.upstreams[0].revision;
const {prepareDecompiler}=require('../producers/maclauncher/src/modules/gamemaker/overlays/opengmk-macos/source-build.js');
const Source=require('../producers/maclauncher/src/modules/shared/runtime/pinned-native-build.js');
await Source.validatePinnedSource(source,revision);fs.mkdirSync(o.work,{recursive:true});
try {
 const owned=path.join(o.work,'source');fs.cpSync(source,owned,{recursive:true,filter:file=>!['.git','target'].includes(path.basename(file))});
 const tools=prepareDecompiler({sourceDir:owned,output:o.work}),target=o.arch==='x64'?'x86_64-apple-darwin':'aarch64-apple-darwin';
 fs.copyFileSync(path.join(root,'producers/maclauncher/helper-builds/gm8-decompiler.lock'),path.join(owned,'Cargo.lock'));
 execFileSync('cargo',['build','--release','--locked','--target',target,'--package','gm8decompiler'],{cwd:owned,stdio:'inherit',timeout:900000,
  env:rustEnvironment({work:o.work,minimumMacOS:'11.0',env:{...process.env,PATH:[tools,path.dirname(process.execPath),process.env.PATH].join(path.delimiter)}})});
 console.log(JSON.stringify(await sealRuntime({project:o.project,arch:o.arch,executable:path.join(o.work,'target',target,'release/gm8decompiler'),sourceRoot:source,upstreamRevision:revision,output:o.output,maximumMacOS:'11.0',
  notices:[{file:path.join(source,'LICENCE.md'),name:'OpenGMK',license:'GPL-2.0-only',sourceUrl:'https://github.com/OpenGMK/OpenGMK'},...rustNotices({source:owned,output:path.join(o.work,'notices')})]})));
}finally{fs.rmSync(o.work,{recursive:true,force:true});}
