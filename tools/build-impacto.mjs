import './producer-environment.mjs';
import {addLicense,addLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {buildInput} from './build-input.mjs';
import {run,recipeMain} from "./build-source.mjs";
import {sealRuntime} from './seal-runtime.mjs';

import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {nativeStackInput} from './native-stack.mjs';
import {sourceRevision} from '../lib/pins.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),native=name=>path.join(root,'producers/package-support/src/modules/mages/native',name),mages=name=>require(native(name));
const Builder=mages('current-build.js'),Dependency=mages('portable-dependencies.js'),Portable=mages('portable-build.js'),Patches=mages('source-patches.js'),Bink2=mages('sources.json').bink2;
const FFmpeg=require('../producers/package-support/src/modules/shared/runtime/portable-ffmpeg.json').source;
/** The Bink2 decoder source record a package states, with the digest of the patch it applies. */
const bink2Source=()=>({repository:Bink2.repository,revision:sourceRevision(Bink2),patchPath:Bink2.patchPath,adaptations:Bink2.adaptations,license:Bink2.license});
const Fonts=require('../producers/package-support/src/modules/shared/runtime/portable-sdl2-fonts.js'),Audio=require('../producers/package-support/src/modules/shared/runtime/portable-sndfile.js');
const Source=require('../producers/package-support/src/modules/shared/runtime/pinned-native-build.js'),AVCPP_SOURCE_SCOPE=Object.freeze({kind:'primary-tree',omittedSubmodules:['catch2']});
const dependencies={runBuildCommand:(command,args,options)=>Source.runBuildCommand(command,args.map((value,index)=>index>0&&args[index-1]==='--parallel'?'2':value),options)};
/** Compile Impacto with its FFmpeg, avcpp and shared native stacks. */
export async function compile({project,arch,work}){
 fs.mkdirSync(work,{recursive:true});const pins=mages('sources.json'),sources=Object.fromEntries(Object.keys(Builder.SOURCES).map(id=>[id,path.join(root,pins[id].gitlink)]));
 // CMake reads magic_enum in place, so its pinned files are staged inside the work directory, whose path the build maps.
 const magicEnum=path.join(work,'upstream-magicEnum');Source.stagePinnedFiles(sources.magicEnum,(await Source.pinnedFiles(sources.magicEnum,Builder.SOURCES.magicEnum.revision)).files,magicEnum);sources.magicEnum=magicEnum;
 const archives={};for(const pin of [...Fonts.PIN.dependencies,...Audio.PIN.dependencies,...Dependency.PIN.dependencies])archives[pin.id]??=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes});
 const maps=[...new Set([work,fs.realpathSync(work)])].map(from=>({from,to:'IMPACTO_BUILD'}));
 const fonts=nativeStackInput(preparedBuildInput('native-sdl2-fonts'),{arch,work:path.join(work,'fonts')}),audio=nativeStackInput(preparedBuildInput('native-sndfile'),{arch,work:path.join(work,'audio')});
 const dependencyStack=await Dependency.buildDependencies({archives,workRoot:path.join(work,'dependencies'),reusedStacks:{fonts,audio},pathMappings:maps,dependencies});
 return finishImpacto({project,arch,work,sources,fonts,audio,dependencyStack,maps});
}
export async function finishImpacto({project,arch,work,sources,fonts,audio,dependencyStack,maps}){
 const sdk=dependencyStack.sdk,ffmpeg=path.join(work,'ffmpeg-source'),ffmpegOutput=path.join(work,'ffmpeg-build'),ffmpegPrefix=path.join(work,'ffmpeg');
 fs.mkdirSync(ffmpeg);run('/usr/bin/tar',['-xf',await buildInput({url:FFmpeg.url,sha256:FFmpeg.sha256,bytes:FFmpeg.bytes}),'--strip-components','1','-C',ffmpeg]);
 await Patches.applyPinnedPatch(ffmpeg,native('bink2.patch'),{logPath:path.join(work,'patches.log')});
 fs.mkdirSync(ffmpegOutput);const env=Dependency.environment(ffmpegPrefix,sdk,[ffmpegPrefix,dependencyStack.prefix]);
 run(path.join(ffmpeg,'configure'),Portable.ffmpegOptions({prefix:ffmpegPrefix,sdk,pathMappings:maps}),{cwd:ffmpegOutput,env});
 mages('build.js').normalizeGeneratedFfmpegConfiguration(ffmpegOutput,maps);run('/usr/bin/make',['-j2'],{cwd:ffmpegOutput,env});run('/usr/bin/make',['install'],{cwd:ffmpegOutput,env});
 return finishImpactoEngine({project,arch,work,sources,fonts,audio,dependencyStack,maps,ffmpegPrefix});
}
export async function finishImpactoEngine({project,arch,work,sources,fonts,audio,dependencyStack,maps,ffmpegPrefix}){
 const sdk=dependencyStack.sdk,ffmpeg=path.join(work,'ffmpeg-source'),avcpp=path.join(work,'avcpp-source'),avcppPrefix=path.join(work,'avcpp');
 addLicenses(ffmpegPrefix,'FFmpeg 7.1.2',ffmpeg);
 const checked=await Source.pinnedFiles(sources.avcpp,Builder.SOURCES.avcpp.revision,{sourceScope:AVCPP_SOURCE_SCOPE});Source.stagePinnedFiles(sources.avcpp,checked.files,avcpp);
 await Patches.applyPinnedPatch(avcpp,path.join(sources.impacto,'portfiles/avcpp/0002-av_init_packet_deprecation.patch'),{logPath:path.join(work,'patches.log')});
 const tools=dependencyStack.tools;await Dependency.buildCmake({sourceRoot:avcpp,outputRoot:path.join(work,'avcpp-build'),prefix:avcppPrefix,sdk,tools,prefixes:[ffmpegPrefix,dependencyStack.prefix],pathMappings:maps,dependencies,options:['-DAV_ENABLE_STATIC=ON','-DAV_ENABLE_SHARED=OFF','-DAV_BUILD_EXAMPLES=OFF','-DAV_BUILD_TESTS=OFF','-DAV_DISABLE_AVDEVICE=ON','-DAV_DISABLE_AVFILTER=ON']});
 const built=await Builder.buildCurrentImpacto({sourceDir:sources.impacto,workRoot:path.join(work,'engine'),dependencyStack,ffmpegPrefix,avcppPrefix,atrac9Source:sources.atrac9,magicEnumSource:sources.magicEnum,pathMappings:maps,dependencies});

 return {built,sources};
}
/** Add the notices and seal the compiled engine. */
export function assemble({project,arch,output,compiled:{built,sources}}){
 for(const id of ['avcpp','atrac9','magicEnum'])addLicenses(built.runtimeRoot,id,sources[id]);
 for(const [id,directory] of Object.entries(built.dependencyStack?.sourceRoots||{})){
  addLicenses(built.runtimeRoot,id,directory);
  if(id==='sdl3'){
   addLicenses(built.runtimeRoot,'SDL3 HIDAPI',`${directory}/src/hidapi`);
   addLicense(built.runtimeRoot,'SDL3 HIDAPI authors',`${directory}/src/hidapi/AUTHORS.txt`);
   addLicenses(built.runtimeRoot,'SDL3 yuv2rgb',`${directory}/src/video/yuv2rgb`);
  }
  if(id==='webp')addLicense(built.runtimeRoot,id,`${directory}/PATENTS`);
 }
 return sealRuntime({project,arch,output,executable:built.executable,appRoot:path.dirname(path.dirname(path.dirname(built.executable))),payloads:fs.readdirSync(built.runtimeRoot).filter(name=>name!=='Impacto.app').map(name=>({source:path.join(built.runtimeRoot,name),relative:name})),sourceRoot:sources.impacto,upstreamRevision:Builder.REVISION,provenance:{profile:Builder.PROFILE,upstreamRevision:Builder.REVISION,avcppSourceScope:AVCPP_SOURCE_SCOPE,codecSource:{version:FFmpeg.version,archiveSha256:FFmpeg.sha256,bink2:bink2Source()},additionalSources:Object.fromEntries(Object.entries(Builder.SOURCES).filter(([id])=>id!=='impacto'))}});
}
recipeMain(import.meta,{compile,assemble});
