import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {buildGraphicsSource} from './graphics-producer.mjs';
import {recipeMain} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');
export async function buildGraphics({project:id,version,...options}){
 const registered=buildRecord(resolveProject(id,root,{resolvePins:false}),version),data=preparedBuildInput('graphics-data'),moltenvk=preparedBuildInput('graphics-moltenvk');
 if(!data||!moltenvk)throw Error('Graphics requires prepared graphics-data and graphics-moltenvk packages.');
 const result=await buildGraphicsSource({...options,version:registered.version,inputs:{moltenvk:moltenvk.root}});
 // Shared resources must match the independently source-produced data package.
 const metadata=JSON.parse(fs.readFileSync(path.join(data.root,data.declaration.manifestRelative)));
 if(!Array.isArray(metadata.sharedInventory)||!metadata.sharedInventory.length)throw Error('The shared graphics data inventory is missing.');
 for(const row of metadata.sharedInventory){
  const file=path.join(options.output,'payload',row.path);
  if(!fs.existsSync(file)||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==row.sha256)throw Error('Graphics resource differs from its shared data package: '+row.path);
 }
 // The shared packaging boundary removes matching bytes and records dependency aliases.
 return {project:id,version:registered.version,arch:options.arch,output:options.output};
}
recipeMain(import.meta,buildGraphics);
