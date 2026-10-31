import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {pathToFileURL} from 'node:url';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {sealRuntime} from './seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Builder=require('../producers/maclauncher/src/modules/gamemaker/runtime/butterscotch.js');
const Catalog=require('../producers/maclauncher/src/modules/gamemaker/runtime/catalog.js');

export async function buildButterscotch({project:id,version,arch,work,output}) {
  if(id!=='butterscotch'||!['arm64','x64'].includes(arch)||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select Butterscotch, a CPU and new absolute work/output paths.');
  const project=resolveProject(id,root),build=buildRecord(project,version),pin=Catalog.BUTTERSCOTCH_BUILDS.find(row=>row.version===Catalog.BUTTERSCOTCH_ARGUMENTS_VERSION);
  if(!pin)throw Error('The registered version has no source recipe.');
  const raw=path.join(work,'compiled'),sourceDir=path.join(root,'producers/maclauncher/src/external/Butterscotch');
  fs.mkdirSync(work,{recursive:true});
  const manager={core:{catalog:[pin],resolveRegistered:()=>null,normalizeVersion:value=>value,getInstallDir:()=>raw,registerLocal:options=>{fs.writeFileSync(path.join(raw,'runtime.json'),JSON.stringify({version:build.version}));return options;}}};
  const built=await Builder.buildRuntime({userDataDir:work,version:pin.version,sourceDir,architecture:arch,runtimeManager:manager});
  const notices=[['LICENSE','Butterscotch','AGPL-3.0-only'],['vendor/box2d/LICENSE','Box2D','MIT'],['vendor/miniz/LICENSE','miniz','MIT'],['vendor/mojoal/LICENSE.txt','MojoAL','Zlib']].map(([file,name,license])=>({file:path.join(sourceDir,file),name,license,sourceUrl:'https://github.com/ButterscotchRunner/Butterscotch'}));
  const noticeRoot=path.join(work,'notices');fs.mkdirSync(noticeRoot);
  for(const entry of fs.readdirSync(path.join(sourceDir,'vendor'),{recursive:true,withFileTypes:true})) {
    if(!entry.isFile()||!/[.](?:h|c)$/.test(entry.name))continue;
    const file=path.join(entry.parentPath,entry.name),relative=path.relative(sourceDir,file);
    if(relative.startsWith('vendor/ps3gl/'))continue;
    const blocks=[...fs.readFileSync(file,'utf8').matchAll(/\/\*[\s\S]*?\*\//g)].map(match=>match[0]).filter(value=>/copyright|public domain|permission is hereby|license/i.test(value));
    if(!blocks.length)continue;
    const noticeFile=path.join(noticeRoot,relative.replaceAll('/','_')+'.txt');fs.writeFileSync(noticeFile,blocks.join('\n\n')+'\n');
    notices.push({file:noticeFile,name:relative,license:'LicenseRef-Upstream-Notice',sourceUrl:'https://github.com/ButterscotchRunner/Butterscotch'});
  }
  const bzip=await buildInput({url:'https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz',sha256:'ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269',bytes:810029});
  const bzipNotice=path.join(noticeRoot,'bzip2-LICENSE.txt');fs.writeFileSync(bzipNotice,execFileSync('/usr/bin/tar',['-xOzf',bzip,'bzip2-1.0.8/LICENSE']));
  notices.push({file:bzipNotice,name:'bzip2 1.0.8',license:'bzip2-1.0.6',sourceUrl:'https://sourceware.org/bzip2/'});
  return sealRuntime({project:id,version:build.version,arch,output,executable:built.runtimePath,sourceRoot:sourceDir,upstreamRevision:pin.upstreamRevision,notices,provenance:{backend:'appkit',renderer:'legacy-opengl',videoBackend:'none',gameArguments:pin.gameArguments}});
}
export async function main(args) {
  const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','version','arch','output','work'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project, --version, --arch, --output and --work.');options[key]=args[i+1];}return buildButterscotch(options);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
