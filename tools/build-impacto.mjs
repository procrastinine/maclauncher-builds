import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {checkoutSource,sourceNotices,run,recipeMain} from './build-source.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {collectSdlNotices} from './sdl-notices.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),modules=path.join(root,'producers/maclauncher/src/modules'),native=path.join(modules,'mages/native');
const Builder=require(path.join(native,'current-build.js')),Dependency=require(path.join(native,'portable-dependencies.js')),Portable=require(path.join(native,'portable-build.js')),Adapter=require(path.join(native,'adapter.js')),Patches=require(path.join(native,'source-patches.js')),DependencyOverlays=require(path.join(native,'dependency-overlays.json'));
const Fonts=require(path.join(modules,'shared/runtime/portable-sdl2-fonts.js')),Audio=require(path.join(modules,'shared/runtime/portable-sndfile.js'));
const Source=require(path.join(modules,'shared/runtime/pinned-native-build.js')),AVCPP_SOURCE_SCOPE=Object.freeze({kind:'primary-tree',omittedSubmodules:['catch2']});
const dependencies={findBuildTool:name=>execFileSync('/usr/bin/which',[name],{encoding:'utf8'}).trim(),runBuildCommand:(command,args,options)=>Source.runBuildCommand(command,args.map((value,index)=>index>0&&args[index-1]==='--parallel'?'2':value),options)};
export async function buildImpacto({project,arch,output,work}){
 fs.mkdirSync(work,{recursive:true});const sources={};for(const id of ['impacto','avcpp','atrac9','magicEnum']){const pin=id==='impacto'?{...Adapter.SOURCES.impacto,revision:Builder.REVISION}:Adapter.SOURCES[id];sources[id]=checkoutSource({...pin,destination:path.join(work,'upstream-'+id)});}
 const archives={};for(const pin of [...Fonts.PIN.dependencies,...Audio.PIN.dependencies,...Dependency.PIN.dependencies])archives[pin.id]??=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes});
 const maps=[...new Set([work,fs.realpathSync(work)])].map(from=>({from,to:'IMPACTO_BUILD'}));
 const fonts=await Fonts.buildDependencies({archives,workRoot:path.join(work,'fonts'),architecture:arch,pathMappings:maps,dependencies}),audio=await Audio.buildDependencies({archives,workRoot:path.join(work,'audio'),architecture:arch,pathMappings:maps,dependencies});
 const dependencyStack=await Dependency.buildDependencies({archives,workRoot:path.join(work,'dependencies'),reusedStacks:{fonts,audio},pathMappings:maps,dependencies});
 return finishImpacto({project,arch,output,work,sources,fonts,audio,dependencyStack,maps});
}
export async function finishImpacto({project,arch,output,work,sources,fonts,audio,dependencyStack,maps}){
 const sdk=dependencyStack.sdk,ffmpeg=path.join(work,'ffmpeg-source'),ffmpegOutput=path.join(work,'ffmpeg-build'),ffmpegPrefix=path.join(work,'ffmpeg');
 fs.mkdirSync(ffmpeg);run('/usr/bin/tar',['-xf',await buildInput({url:Adapter.SOURCES.ffmpeg.archive,sha256:Adapter.SOURCES.ffmpeg.sha256,bytes:Portable.FFMPEG_ARCHIVE_BYTES}),'--strip-components','1','-C',ffmpeg]);
 await Patches.applyPinnedPatch(ffmpeg,path.join(native,'bink2.patch'),DependencyOverlays.ffmpegBink2,{logPath:path.join(work,'patches.log')});
 fs.mkdirSync(ffmpegOutput);const env=Dependency.environment(ffmpegPrefix,sdk,[ffmpegPrefix,dependencyStack.prefix]);
 run(path.join(ffmpeg,'configure'),Portable.ffmpegOptions({prefix:ffmpegPrefix,sdk,pathMappings:maps}),{cwd:ffmpegOutput,env});
 require(path.join(native,'build.js')).normalizeGeneratedFfmpegConfiguration(ffmpegOutput,maps);run('/usr/bin/make',['-j2'],{cwd:ffmpegOutput,env});run('/usr/bin/make',['install'],{cwd:ffmpegOutput,env});
 return finishImpactoEngine({project,arch,output,work,sources,fonts,audio,dependencyStack,maps,ffmpegPrefix});
}
export async function finishImpactoEngine({project,arch,output,work,sources,fonts,audio,dependencyStack,maps,ffmpegPrefix}){
 Portable.validateDependencyStack(dependencyStack);
 const sdk=dependencyStack.sdk,ffmpeg=path.join(work,'ffmpeg-source'),avcpp=path.join(work,'avcpp-source'),avcppPrefix=path.join(work,'avcpp');
 const checked=await Source.validatePinnedSource(sources.avcpp,Adapter.SOURCES.avcpp.revision,{sourceScope:AVCPP_SOURCE_SCOPE});Source.stagePinnedFiles(sources.avcpp,checked.files,avcpp);
 await Patches.applyPinnedPatch(avcpp,path.join(sources.impacto,'portfiles/avcpp/0002-av_init_packet_deprecation.patch'),DependencyOverlays.avcppPacket,{logPath:path.join(work,'patches.log')});
 const tools=dependencyStack.tools;await Dependency.buildCmake({sourceRoot:avcpp,outputRoot:path.join(work,'avcpp-build'),prefix:avcppPrefix,sdk,tools,prefixes:[ffmpegPrefix,dependencyStack.prefix],pathMappings:maps,dependencies,options:['-DAV_ENABLE_STATIC=ON','-DAV_ENABLE_SHARED=OFF','-DAV_BUILD_EXAMPLES=OFF','-DAV_BUILD_TESTS=OFF','-DAV_DISABLE_AVDEVICE=ON','-DAV_DISABLE_AVFILTER=ON']});
 const built=await Builder.buildCurrentImpacto({sourceDir:sources.impacto,workRoot:path.join(work,'engine'),dependencyStack,ffmpegPrefix,avcppPrefix,atrac9Source:sources.atrac9,magicEnumSource:sources.magicEnum,pathMappings:maps,dependencies});
 const notices=[{file:path.join(native,'bink2-license.txt'),name:'FFmpeg Bink2 decoder adaptation',license:Adapter.SOURCES.bink2.license,sourceUrl:Adapter.SOURCES.bink2.repository+'/tree/'+Adapter.SOURCES.bink2.revision}];for(const [id,source]of Object.entries(sources))notices.push(...sourceNotices(source,{name:id,repository:Adapter.SOURCES[id].repository}));notices.push(...sourceNotices(ffmpeg,{name:'FFmpeg 7.1.2',repository:Adapter.SOURCES.ffmpeg.archive}));
 for(const stack of [fonts,audio,dependencyStack])for(const pin of stack.sources)for(const name of pin.notices)notices.push({file:path.join(pin.sourceRoot||stack.sourceRoots[pin.id],name),name:pin.name,license:pin.license,sourceUrl:pin.archiveUrl});
 const pin=Dependency.PIN.dependencies.find(row=>row.id==='sdl3'),sdl=collectSdlNotices({source:dependencyStack.sourceRoots.sdl3,output:path.join(work,'sdl-notices'),name:'SDL3 '+pin.version,sourceUrl:pin.archiveUrl,includeLibm:false});notices.push(...sdl.notices);
 return sealImpacto({project,arch,output,built,sources,notices,sdlNoticeProvenance:sdl.provenance});
}
export function sealImpacto({project,arch,output,built,sources,notices,sdlNoticeProvenance}){
 return sealRuntime({project,arch,output,executable:built.executable,appRoot:path.dirname(path.dirname(path.dirname(built.executable))),payloads:fs.readdirSync(built.runtimeRoot).filter(name=>name!=='Impacto.app').map(name=>({source:path.join(built.runtimeRoot,name),relative:name})),sourceRoot:sources.impacto,upstreamRevision:Builder.REVISION,notices,provenance:{sdlNoticeSources:sdlNoticeProvenance,profile:Builder.PROFILE,upstreamRevision:Builder.REVISION,avcppSourceScope:AVCPP_SOURCE_SCOPE,codecSource:{version:Adapter.SOURCES.ffmpeg.version,archiveSha256:Adapter.SOURCES.ffmpeg.sha256,bink2:Adapter.SOURCES.bink2},additionalSources:Object.fromEntries(Object.entries(Adapter.SOURCES).filter(([id])=>['avcpp','atrac9','magicEnum'].includes(id)))}});
}
recipeMain(import.meta,buildImpacto);
