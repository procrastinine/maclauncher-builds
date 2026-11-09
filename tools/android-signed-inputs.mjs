import './producer-environment.mjs';
import {verifyPreparedPayload} from './prepared-build-inputs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),B=require('../lib/package-format.cjs'),{validateDeclaration}=require('../lib/declaration.cjs');
const json=file=>JSON.parse(fs.readFileSync(path.join(root,file)));

/** Existing package identities required before the unified producer starts. */
export function androidBuildInputRequirements(){
 const angle=json('producers/android-inputs/angle.json'),common=angle.profiles.find(profile=>profile.id==='common');
 const requirements=[{key:'angle',id:angle.id,version:common.version}];
 for(const[key,file]of Object.entries({codecs:'producers/android-inputs/codecs.json',blueprint:'producers/android-inputs/blueprint/source.json',aconfig:'producers/android-inputs/aconfig/source.json',elf:'producers/android-art-inputs/art-source.json',ffi:'producers/android-art-inputs/ffi.json',java:'producers/android-inputs/java-converter.json',javaFramework:'producers/android-inputs/java-framework.json',artJava:'producers/android-art-inputs/java-stage.json'})){
  const profile=json(file);requirements.push({key,id:profile.id,version:profile.version});
 }
 const extractor=json('producers/android-art-inputs/source.json');requirements.push({key:'extractor',id:extractor.id,version:buildRecord(resolveProject(extractor.id,root)).version});
 for(const profile of json('producers/android-image-data/source.json').profiles)requirements.push({key:'image'+profile.shard,id:profile.id,version:profile.version});
 return requirements.map(requirement=>({...requirement,arch:'arm64'}));
}

/** Validate ordinary sealed products for production adapters and local wiring checks. */
export function verifyAndroidBuildInput(requirement,input){
 if(!path.isAbsolute(input?.root||''))throw Error('Missing sealed Android input: '+requirement.id);
 const declaration=input.declaration||JSON.parse(fs.readFileSync(path.join(input.root,'../declaration.json')));validateDeclaration(declaration);
 if(['id','version','arch'].some(key=>declaration[key]!==requirement[key]))throw Error('Android input identity differs: '+requirement.id);
 verifyPreparedPayload(input.root,declaration);return {...input,declaration};
}

/** Resolve every input from its exact public signed ledger entry before compilation. */
export async function resolveAndroidSignedInputs({work}){
 if(!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Signed Android inputs require a new absolute work directory.');
 const declared=json('producers/android-inputs/verified-builds.json'),prepared=new Map(Object.values(declared).filter(row=>row?.project).map(row=>[row.project,preparedBuildInput(row.project)]));
 const requirements=androidBuildInputRequirements();fs.mkdirSync(work,{recursive:true});const result={};
 for(const requirement of requirements){
  const input=prepared.get(requirement.id);
  if(!input)throw Error('The dependency graph did not prepare the Android input: '+requirement.id);
  result[requirement.key]=verifyAndroidBuildInput(requirement,input);
 }
 return result;
}
