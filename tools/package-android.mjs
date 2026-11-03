import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {printWarnings,copyNotices,tidyNotices} from '../lib/notices.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),{validateDeclaration,validatePublicMetadata}=require('../lib/package-contract.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

/** Compose both execution engines into one package, retaining their exact files. */
export function packageAndroid({commonRoot,commonDeclaration,artRoot,artDeclaration,version,output}){
 if([commonRoot,artRoot,output].some(value=>!path.isAbsolute(value||''))||fs.existsSync(output)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version||'')||version.includes('..'))throw Error('Android composition requires both producer roots, declarations, a version and a new absolute output path.');
 for(const [root,declaration,id]of [[commonRoot,commonDeclaration,'android'],[artRoot,artDeclaration,'android-art']]){
  validateDeclaration(declaration);
  if(declaration.id!==id||declaration.arch!=='arm64'||declaration.manifestRelative!=='runtime.json')throw Error('The Android engine input has a different package profile.');
  const actual=fs.realpathSync(root),destination=path.resolve(output);
  if(destination===actual||destination.startsWith(actual+path.sep)||actual.startsWith(destination+path.sep))throw Error('Android output overlaps an engine input.');
  B.verifyPayload(root,declaration);
 }
 const common=JSON.parse(fs.readFileSync(path.join(commonRoot,'runtime.json'))),art=JSON.parse(fs.readFileSync(path.join(artRoot,'runtime.json')));
 if(common.profile?.javaMajor!==21||common.profile?.nativeLoadTarget!=='maclauncher.android.bridge.GuestNativeLoader'||art.profile?.artExecutionVersion!==1)throw Error('The Android JVM and ART producer profiles are incompatible.');
 const inventory=new Map(),notices=new Map(),dependencies=new Map();
 const inputs=[[commonRoot,commonDeclaration,common],[artRoot,artDeclaration,art]],names=['jvm','art'];
 const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
 try{
  for(const [index,[root,declaration,manifest]]of inputs.entries()){
   const candidateRows=Array.isArray(declaration.notices)?declaration.notices:[],noticePaths=new Set(candidateRows.filter(row=>typeof row?.path==='string').map(row=>row.path));
   for(const file of declaration.files){
    if(file.path===declaration.manifestRelative||file.path===declaration.sourceRelative||noticePaths.has(file.path)||file.path.startsWith('notices/')||file.path==='package-notice.txt')continue;
    const previous=inventory.get(file.path);
    if(previous){
     if(previous.sha256===file.sha256&&previous.size===file.size&&previous.mode===file.mode&&JSON.stringify(previous.architectures||[])===JSON.stringify(file.architectures||[]))continue;
     throw Error('The Android engines contain different shared input bytes: '+file.path);
    }
    const destination=path.join(payload,file.path);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(root,file.path),destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.chmodSync(destination,file.mode);inventory.set(file.path,file);
   }
   const copied=copyNotices(candidateRows.map(notice=>({...notice,file:typeof notice?.path==='string'?path.join(root,notice.path):undefined,path:'notices/engines/'+names[index]+'/'+(notice?.path||'notice.txt')})),{output:payload});printWarnings(copied.warnings);
   for(const {file,...notice}of copied.notices)notices.set(JSON.stringify(notice),notice);
   for(const dependency of manifest.dependencies||[]){
    const old=dependencies.get(dependency.file);
    if(old&&JSON.stringify(old)!==JSON.stringify(dependency))throw Error('The Android engines describe different shared library dependencies: '+dependency.file);
    dependencies.set(dependency.file,dependency);
   }
  }
  if(!inventory.has('art/runtime.json')||!inventory.has('art/host/linux-run'))throw Error('The Android ART supplier component is incomplete.');
  const judged={id:'android',version,notices:[...notices.values()],files:[...notices.values()].filter(row=>typeof row?.path==='string').map(row=>({path:row.path}))};
  const sanitized=tidyNotices(payload,judged,{share:false});notices.clear();for(const notice of sanitized.notices)notices.set(JSON.stringify(notice),notice);
  const files=[...inventory.values()].sort((a,b)=>a.path.localeCompare(b.path));
  const minimumMacOS=B.versionAtLeast(common.minimumMacOS,art.minimumMacOS)?common.minimumMacOS:art.minimumMacOS;
  const {upstreamRevision,sourceRevision,...commonMetadata}=common;
  // The aggregate source is the Builds recipe, rather than one upstream revision.
  const manifest={...commonMetadata,version,profile:{...common.profile,artExecutionVersion:1},capabilities:{...common.capabilities,artExecutionVersion:1},minimumMacOS,
   sourceHash:sha(JSON.stringify([common.sourceHash,art.sourceHash])),inputHash:sha(JSON.stringify(files)),dependencies:[...dependencies.values()].sort((a,b)=>a.file.localeCompare(b.file)),files};
  validatePublicMetadata(manifest);
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(payload,'runtime.json'),bytes,{mode:0o644});
  const declaration={id:'android',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS,directoryRelative:'android/'+version+'/arm64',manifestRelative:'runtime.json',manifestSha256:sha(bytes),sourceRelative:null,sourceSha256:sha(bytes),
   files:[...files,{path:'runtime.json',size:bytes.length,mode:0o644,sha256:sha(bytes)}],notices:[...notices.values()]};
  validateDeclaration(declaration);B.verifyPayload(payload,declaration);
  fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
  return {project:'android',version,arch:'arm64',output,sharedFiles:commonDeclaration.files.length+artDeclaration.files.length-declaration.files.length-1};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
