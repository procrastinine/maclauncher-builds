import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildInput} from './build-input.mjs';
import {verifyProducer} from './build-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..'),execute=promisify(execFile);
const read=(command,args)=>execFileSync(command,args,{encoding:'utf8',maxBuffer:64<<20}).trim();
const descriptor=path.join(root,'producers/android-inputs/common-publishers.json');
const archiveNames=(archive,gzip=false)=>read('/usr/bin/tar',[gzip?'-tzf':'-tf',archive]).split('\n').filter(Boolean).map(name=>{
 if(path.isAbsolute(name)||name.includes('\\')||name.split('/').includes('..'))throw Error('The publisher archive contains an unsafe path.');
 return name.replace(/\/$/,'');
});
function unique(values,label){const selected=[...new Set(values)];if(selected.length!==1)throw Error('The publisher archive does not identify one '+label+'.');return selected[0];}
const isMounted=mount=>{try{return fs.statSync(mount).dev!==fs.statSync(path.dirname(mount)).dev;}catch{return false;}};

/** Extract only the selected original SDL framework from a read-only volume. */
async function prepareSdl(archive,work,profile){
 const image=path.join(work,'SDL3.dmg');fs.copyFileSync(archive,image,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
 const mount=path.join(work,'sdl-volume');fs.mkdirSync(mount);
 const methods=[{attach:['/usr/sbin/diskutil',['image','attach','--readOnly','--nobrowse','--mountPoint',mount,image]],detach:['/usr/sbin/diskutil',['eject',mount]]},{attach:['/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mount,image]],detach:['/usr/bin/hdiutil',['detach',mount]]}];
 let selected,attached=false;
 try{
  for(const [index,method] of methods.entries()){
   selected=method;
   try{await execute(...method.attach,{timeout:60000,maxBuffer:64<<10});attached=true;break;}
   catch(error){if(isMounted(mount)){attached=true;break;}if(index===methods.length-1)throw error;}
  }
  if(!attached)throw Error('SDL disk image did not mount.');
  let level=[mount];const matches=[];
  for(let depth=0;depth<5&&level.length;depth++){
   const next=[];
   for(const directory of level)for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(entry.name.startsWith('.')||entry.isSymbolicLink()||!entry.isDirectory())continue;
    const file=path.join(directory,entry.name);
    if(file.endsWith(profile.frameworkSuffix))matches.push(file);
    else next.push(file);
   }
   level=next;
  }
  const source=unique(matches,'SDL macOS framework'),sdl=path.join(work,'sdl','SDL3.framework');
  fs.mkdirSync(path.dirname(sdl),{recursive:true});fs.cpSync(source,sdl,{recursive:true,verbatimSymlinks:true});
  const version=read('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(sdl,'Resources/Info.plist')]);
  if(version!==profile.version)throw Error('The SDL framework differs from its declared publisher version.');
  if(!fs.statSync(path.join(sdl,'Resources/LICENSE.txt')).isFile())throw Error('The SDL framework license is missing.');
  read('/usr/bin/codesign',['--verify','--strict',sdl]);
  return sdl;
 }finally{
  if(selected&&(attached||isMounted(mount)))await execute(...selected.detach,{timeout:30000,maxBuffer:64<<10});
  if(!isMounted(mount)){if(fs.existsSync(mount))fs.rmdirSync(mount);fs.rmSync(image,{force:true});}
 }
}

/** Acquire the unchanged publisher binaries and complete framework build input. */
export async function prepareAndroidCommonPublisherInputs({work}){
 if(process.platform!=='darwin'||process.arch!=='arm64'||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Android publisher inputs require Apple Silicon macOS and a new absolute work directory.');
 const profile=JSON.parse(fs.readFileSync(descriptor));
 const recipe=JSON.parse(fs.readFileSync(path.join(root,profile.androidRecipe)));
 const android=verifyProducer(root,recipe),frameworkPin=JSON.parse(fs.readFileSync(path.join(android,profile.frameworkDefinition)));
 if(frameworkPin.files.length!==1)throw Error('The framework profile must supply one original Java artifact.');
 fs.mkdirSync(work,{recursive:true});
 const archiveCache=path.join(work,'archives');
 const retireArchive=archive=>{if(path.dirname(archive)!==archiveCache)throw Error('Publisher archive is outside its owned cache.');fs.rmSync(archive);};
 const jdkArchive=await buildInput(profile.jdk,archiveCache),jdkOutput=path.join(work,'jdk');fs.mkdirSync(jdkOutput);
 const jdkNames=archiveNames(jdkArchive,true),java=unique(jdkNames.filter(name=>name.endsWith('/Contents/Home/bin/java')),'JDK home');
 const home=java.slice(0,-'/bin/java'.length);
 read('/usr/bin/tar',['-xzf',jdkArchive,'-C',jdkOutput,home]);
 const jdk=path.join(jdkOutput,home);
 if(!fs.statSync(path.join(jdk,'include/jni.h')).isFile())throw Error('The supplied JDK has no JNI headers.');
 retireArchive(jdkArchive);
 const sdlArchive=await buildInput(profile.sdl,archiveCache),sdl=await prepareSdl(sdlArchive,work,profile.sdl);retireArchive(sdlArchive);
 const mvkArchive=await buildInput(profile.vulkanHeaders,archiveCache),mvkOutput=path.join(work,'vulkan');fs.mkdirSync(mvkOutput);
 const mvkNames=archiveNames(mvkArchive),include=unique(mvkNames.filter(name=>name.endsWith(profile.vulkanHeaders.includeSuffix)),'Vulkan header directory');
 const notices=mvkNames.filter(name=>/\/(?:LICEN[CS]E|NOTICE)(?:[._-][^/]*)?$/.test(name));
 read('/usr/bin/tar',['-xf',mvkArchive,'-C',mvkOutput,include,...notices]);
 const vulkanHeaders=path.join(mvkOutput,include);
 if(!fs.statSync(path.join(vulkanHeaders,'vulkan/vulkan.h')).isFile())throw Error('The publisher SDK has no Vulkan headers.');
 retireArchive(mvkArchive);
 const file=frameworkPin.files[0],framework=path.join(work,'framework');fs.mkdirSync(framework);
 const frameworkArchive=await buildInput({url:frameworkPin.url,sha256:file.sha256,bytes:file.size},archiveCache);
 fs.copyFileSync(frameworkArchive,path.join(framework,file.path),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);retireArchive(frameworkArchive);
 const sdkArchive=await buildInput(profile.buildTools,archiveCache),sdkOutput=path.join(work,'build-tools');fs.mkdirSync(sdkOutput);
 const sdkNames=archiveNames(sdkArchive),sdkAidl=unique(sdkNames.filter(name=>name.endsWith('/aidl')),'Android AIDL executable');
 read('/usr/bin/unzip',['-q',sdkArchive,'-d',sdkOutput]);
 const aidl=path.join(sdkOutput,sdkAidl),buildTools=path.dirname(aidl);
 if(!fs.statSync(path.join(buildTools,'lib64/libc++.dylib')).isFile()||!fs.statSync(path.join(buildTools,'source.properties')).isFile())throw Error('The original Android build tools have no AIDL runtime closure.');
 retireArchive(sdkArchive);
 return {jdk,sdl,vulkanHeaders,framework,aidl,buildTools};
}
