import {recipeMain} from './build-source.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {sealRuntime} from './seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Builder=require('../producers/maclauncher/src/modules/gamemaker/runtime/butterscotch.js');
const Catalog=require('../producers/maclauncher/src/modules/gamemaker/runtime/catalog.js');

export async function buildButterscotch({project:id,version,arch,work,output}) {

  const project=resolveProject(id,root),build=buildRecord(project,version),pin=Catalog.BUTTERSCOTCH_BUILDS.find(row=>row.version===Catalog.BUTTERSCOTCH_ARGUMENTS_VERSION);
  if(!pin)throw Error('The registered version has no source recipe.');
  const raw=path.join(work,'compiled'),sourceDir=path.join(root,'producers/maclauncher/src/external/Butterscotch');
  fs.mkdirSync(work,{recursive:true});
  const manager={core:{catalog:[pin],resolveRegistered:()=>null,normalizeVersion:value=>value,getInstallDir:()=>raw,registerLocal:options=>{fs.writeFileSync(path.join(raw,'runtime.json'),JSON.stringify({version:build.version}));return options;}}};
  const built=await Builder.buildRuntime({userDataDir:work,version:pin.version,sourceDir,architecture:arch,runtimeManager:manager});

  return sealRuntime({project:id,version:build.version,arch,output,executable:built.runtimePath,sourceRoot:sourceDir,upstreamRevision:pin.upstreamRevision,provenance:{backend:'appkit',renderer:'legacy-opengl',videoBackend:'none',gameArguments:pin.gameArguments}});
}
recipeMain(import.meta,buildButterscotch);
