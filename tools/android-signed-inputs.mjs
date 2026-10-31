import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {githubBuildInput} from './github-build-input.mjs';
import {sha} from './helper-package.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),{validateDeclaration}=require('../lib/declaration.cjs');
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
 B.verifyPayload(input.root,declaration);return {...input,declaration};
}

/** Resolve every input from its exact public signed ledger entry before compilation. */
export async function resolveAndroidSignedInputs({work}){
 if(!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Signed Android inputs require a new absolute work directory.');
 const ledger=json('producers/android-inputs/verified-builds.json'),pins=new Map();
 function visit(value){
  if(!value||typeof value!=='object')return;
  if(value.evidence){
   if(!/^attestations\/[a-f0-9]{64}\.json$/.test(value.evidence.path||'')||!/^[a-f0-9]{64}$/.test(value.evidence.sha256||''))throw Error('Invalid signed Android input evidence.');
   const file=path.join(root,value.evidence.path);if(sha(file)!==value.evidence.sha256)throw Error('Signed Android input evidence changed.');
   const record=JSON.parse(fs.readFileSync(file)).record,key=[record.id,record.version,record.arch].join('/'),previous=pins.get(key);
   if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw Error('Ambiguous signed Android input: '+key);pins.set(key,value);return;
  }
  for(const child of Object.values(value))visit(child);
 }
 visit(ledger);
 const requirements=androidBuildInputRequirements(),missing=requirements.filter(requirement=>!pins.has([requirement.id,requirement.version,requirement.arch].join('/')));
 if(missing.length)throw Error('Missing signed Android inputs: '+missing.map(requirement=>[requirement.id,requirement.version,requirement.arch].join('/')).join(', '));
 fs.mkdirSync(work,{recursive:true});const result={};
 for(const requirement of requirements){
  const key=[requirement.id,requirement.version,requirement.arch].join('/'),input=await githubBuildInput({pin:pins.get(key),output:path.join(work,requirement.key),work:path.join(work,requirement.key+'-download')});
  result[requirement.key]=verifyAndroidBuildInput(requirement,input);
  fs.rmSync(path.join(work,requirement.key+'-download'),{recursive:true});
 }
 return result;
}
