import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareSdl} from './android-sdl3-publisher.mjs';
import {buildInput} from './build-input.mjs';
import {verifyProducer} from './build-runtime.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';

const root=path.resolve(import.meta.dirname,'..');
const read=(command,args)=>execFileSync(command,args,{encoding:'utf8',maxBuffer:Infinity}).trim();
const descriptor=path.join(root,'producers/android-inputs/common-publishers.json');
const archiveNames=(archive,gzip=false)=>read('/usr/bin/tar',[gzip?'-tzf':'-tf',archive]).split('\n').filter(Boolean).map(name=>{
 if(path.isAbsolute(name)||name.includes('\\')||name.split('/').includes('..'))throw Error('The publisher archive contains an unsafe path.');
 return name.replace(/\/$/,'');
});
function unique(values,label){const selected=[...new Set(values)];if(selected.length!==1)throw Error('The publisher archive does not identify one '+label+'.');return selected[0];}
/** Supply the publisher framework API without adding aliases to its sealed package. */
export function prepareSharedSdlFramework(input,work){
 const root=fs.realpathSync(input.root),version=fs.realpathSync(path.join(root,'native/SDL3.framework/Versions/A'));
 if(!version.startsWith(root+path.sep)||!fs.statSync(path.join(version,'SDL3')).isFile()||!fs.statSync(path.join(version,'Headers/SDL.h')).isFile())throw Error('The shared SDL3 package has no complete canonical framework API.');
 const framework=path.join(work,'sdl-shared/SDL3.framework');
 if(fs.existsSync(framework))throw Error('Choose a new shared SDL3 framework work directory.');
 fs.mkdirSync(path.join(framework,'Versions'),{recursive:true});
 fs.cpSync(version,path.join(framework,'Versions/A'),{recursive:true,verbatimSymlinks:true,mode:fs.constants.COPYFILE_FICLONE});
 fs.symlinkSync('A',path.join(framework,'Versions/Current'),'dir');
 for(const name of ['SDL3','Headers','Resources'])fs.symlinkSync('Versions/Current/'+name,path.join(framework,name));
 return framework;
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
 const jdkArchive=await buildInput(JSON.parse(fs.readFileSync(path.join(root,'producers/android-inputs/java-converter.json'))).jdk['darwin-arm64'],archiveCache),jdkOutput=path.join(work,'jdk');fs.mkdirSync(jdkOutput);
 const jdkNames=archiveNames(jdkArchive,true),java=unique(jdkNames.filter(name=>name.endsWith('/Contents/Home/bin/java')),'JDK home');
 const home=java.slice(0,-'/bin/java'.length);
 read('/usr/bin/tar',['-xzf',jdkArchive,'-C',jdkOutput,home]);
 const jdk=path.join(jdkOutput,home);
 if(!fs.statSync(path.join(jdk,'include/jni.h')).isFile())throw Error('The supplied JDK has no JNI headers.');
 retireArchive(jdkArchive);
 const sharedSdl=preparedBuildInput('native-sdl3');let sdl;
 if(sharedSdl)sdl=prepareSharedSdlFramework(sharedSdl,work);
 else{const sdlArchive=await buildInput(profile.sdl,archiveCache);sdl=await prepareSdl(sdlArchive,work,profile.sdl);retireArchive(sdlArchive);}
 if(!fs.statSync(path.join(sdl,'SDL3')).isFile()||!fs.statSync(path.join(sdl,'Headers/SDL.h')).isFile())throw Error('The shared SDL3 package has no complete framework API.');
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
