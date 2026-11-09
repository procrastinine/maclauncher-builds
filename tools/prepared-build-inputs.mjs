import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),B=require('../lib/package-format.cjs');
import {projectId} from '../lib/project-identity.mjs';
/** Verified inputs materialized by this build run, without network access. */
export function preparedBuildInput(id,env=process.env){
 projectId(id);if(!env.MACLAUNCHER_BUILD_INPUTS)return undefined;
 const value=env.MACLAUNCHER_BUILD_INPUTS,map=JSON.parse(value.trim().startsWith('{')?value:fs.readFileSync(value,'utf8')),input=map[id];
 if(!input)return undefined;
 if(!input.evidence||!path.isAbsolute(input.root||'')||!path.isAbsolute(input.archive||'')||!fs.statSync(input.root).isDirectory()||!fs.statSync(input.archive).isFile())throw Error('Invalid prepared build input: '+id);
 return input;
}

/** Bind a logical dependency path to its exact verified archive and stored file. */
export function dependencyResolver(inputs){
 return (target,exact)=>{
  const input=inputs[target.project];
  if(!input||!exact)throw Error('The dependency has no prepared input: '+target.project);
  const file=input.declaration.files.find(file=>file.path===target.path);if(!file)throw Error('The prepared dependency has no canonical stored target.');
  return {...file,path:path.join(input.root,file.path)};
 };
}
export function preparedDependencyResolver(environment=process.env){
 const value=environment.MACLAUNCHER_BUILD_INPUTS,inputs=value?JSON.parse(value.trim().startsWith('{')?value:fs.readFileSync(value,'utf8')):{};
 return dependencyResolver(inputs);
}
export function verifyPreparedPayload(root,declaration,environment=process.env){
 return B.verifyPayload(root,declaration,preparedDependencyResolver(environment));
}
