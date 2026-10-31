import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
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
 const inventory=new Map(),notices=new Map(),dependencies=new Map(),owners=new Map(),noticeAliases=[new Map(),new Map()];
 const inputs=[[commonRoot,commonDeclaration,common],[artRoot,artDeclaration,art]],names=['jvm','art'];
 const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
 try{
  for(const [index,[root,declaration,manifest]]of inputs.entries()){
   for(const file of declaration.files){
    if(file.path===declaration.manifestRelative||file.path===declaration.sourceRelative)continue;
    const previous=inventory.get(file.path);let delivered=file.path;
    if(previous){
     if(previous.sha256===file.sha256&&previous.size===file.size&&previous.mode===file.mode&&JSON.stringify(previous.architectures||[])===JSON.stringify(file.architectures||[]))continue;
     if(!file.path.startsWith('notices/'))throw Error('The Android engines contain different shared input bytes: '+file.path);
     // Each engine retains its own original notice when build provenance or
     // license text differs. Executable/shared framework conflicts stay errors.
     const owner=owners.get(file.path),previousPath='notices/engines/'+names[owner]+'/'+file.path.slice(8);
     delivered='notices/engines/'+names[index]+'/'+file.path.slice(8);
     if(inventory.has(previousPath)||inventory.has(delivered))throw Error('Android notice namespace collision: '+file.path);
     const moved=path.join(payload,previousPath);fs.mkdirSync(path.dirname(moved),{recursive:true});fs.renameSync(path.join(payload,file.path),moved);
     inventory.delete(file.path);inventory.set(previousPath,{...previous,path:previousPath});owners.delete(file.path);owners.set(previousPath,owner);
     noticeAliases[owner].set(file.path,previousPath);noticeAliases[index].set(file.path,delivered);
    }
    const destination=path.join(payload,delivered);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(root,file.path),destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.chmodSync(destination,file.mode);inventory.set(delivered,{...file,path:delivered});owners.set(delivered,index);
   }
   for(const dependency of manifest.dependencies||[]){
    const old=dependencies.get(dependency.file);
    if(old&&JSON.stringify(old)!==JSON.stringify(dependency))throw Error('The Android engines describe different shared library dependencies: '+dependency.file);
    dependencies.set(dependency.file,dependency);
   }
  }
  for(const [index,[,declaration]]of inputs.entries())for(const notice of declaration.notices){const delivered={...notice,path:noticeAliases[index].get(notice.path)||notice.path};notices.set(JSON.stringify(delivered),delivered);}
  if(!inventory.has('art/runtime.json')||!inventory.has('art/host/linux-run'))throw Error('The Android ART supplier component is incomplete.');
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
