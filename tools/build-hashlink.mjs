import './producer-environment.mjs';
import {addLicenses} from '../lib/licenses.mjs';
import sharedDependencies from '../producers/dependencies.json' with {type:'json'};
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {checkoutSource,stageSource,run,recipeMain} from "./build-source.mjs";
import {sealRuntime} from './seal-runtime.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {nativeStackInput} from './native-stack.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),hashlink=name=>require('../producers/package-support/src/modules/hashlink/runtime/'+name);
const Paths=hashlink('compiler-paths.js');
const Binary=require('../producers/package-support/scripts/native-binary-tools.cjs');
export function hashLinkProfile(version,project=resolveProject('hashlink',root,{resolvePins:false})){
 const profile=project.packageProfiles.find(profile=>profile.version===version),labels=profile?.anchor?project.packageProfiles.filter(row=>row.anchor===profile.anchor).map(row=>row.version):[version],sources=new Set(labels.map(label=>/^(1\.(?:9|12))-MCLv[1-9]\d*$/.exec(label||'')?.[1]).filter(Boolean));
 if(sources.size!==1)throw Error('The HashLink catalog has no ABI release for '+version+'.');return [...sources][0];
}

function bytecodeFacts(source){
 const code=fs.readFileSync(path.join(source,'src/code.c'),'utf8'),sdl=fs.readFileSync(path.join(source,'libs/sdl/sdl.c'),'utf8');
 const maximum=Number(/\bmax_version\s*=\s*(\d+)/.exec(code)?.[1]),minimum=Number(/c->version\s*<=\s*(\d+)\s*\|\|\s*c->version\s*>\s*max_version/.exec(code)?.[1]);
 const loop=/DEFINE_PRIM\s*\(\s*_BOOL\s*,\s*event_loop\s*,\s*(_DYN|_OBJ)/.exec(sdl)?.[1];
 if(!Number.isInteger(minimum)||!Number.isInteger(maximum)||maximum<=minimum||!loop)throw Error('HashLink bytecode or SDL primitive facts are unavailable.');
 return {supportedBytecodeVersions:Array.from({length:maximum-minimum},(_,i)=>minimum+i+1),nativeAbi:{sdlEventLoop:loop==='_DYN'?'dynamic':'typed-event'}};
}
/** Compile the shared libraries, the VM and its native ABI modules. */
export async function compile({project,arch,version,output,work,sourceRoot:cachedSourceRoot}){
 fs.mkdirSync(work,{recursive:true});const legacy=hashLinkProfile(version,resolveProject(project,root,{resolvePins:false}))==='1.9',Builder=hashlink(legacy?'legacy-build.js':'dynamic-legacy-build.js');
 let sourceRoot=path.join(root,'producers/package-support/src/external/source-revisions/hashlink-1-9');
 if(!legacy)sourceRoot=cachedSourceRoot||checkoutSource({repository:'https://github.com/HaxeFoundation/hashlink',revision:Builder.REVISION,destination:path.join(work,'upstream')});
 const sdlRoot=checkoutSource({...sharedDependencies.sdlHeaders,destination:path.join(work,'sdl-upstream')});
 const source=path.join(work,'source'),sdl=path.join(work,'sdl'),openal=path.join(work,'openal');
 const staged=await stageSource(sourceRoot,Builder.REVISION,source),sdlStage=await stageSource(sdlRoot,Builder.SDL_REVISION,sdl),openalStack=nativeStackInput(preparedBuildInput('native-openal'),{arch,work:path.join(work,'openal-prefix')}),openalStage={treeSha256:openalStack.sourceTreeSha256};
 const overlaySha256=Builder.adaptSource(source,sdl),flags=Paths.compilerFlags(Paths.compilerPathMappings({source,sdlSource:sdl,openalSource:openal,build:work,runtime:output})),overlay=path.join(work,'compiler-paths.cmake');
 fs.writeFileSync(overlay,Paths.cmakeOverlay(flags));
 const common=['-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES=x86_64','-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0','-DCMAKE_POLICY_VERSION_MINIMUM=3.5','-DCMAKE_PROJECT_INCLUDE='+overlay,'-DFETCHCONTENT_FULLY_DISCONNECTED=ON','-DFETCHCONTENT_UPDATES_DISCONNECTED=ON'];
 const sdlBuild=path.join(work,'sdl-build'),openalBuild=path.join(work,'openal-build');
 run('cmake',['-S',sdl,'-B',sdlBuild,...common,'-DSDL_SHARED=OFF','-DSDL_STATIC=ON','-DSDL_TEST=OFF','-DSDL_X11=OFF','-DHAVE_GCC_WERROR_DECLARATION_AFTER_STATEMENT=OFF']);run('cmake',['--build',sdlBuild,'--parallel','2']);

 compileHashLinkVM({work,flags,common,openalPrefix:openalStack.prefix});
 return {sourceRoot,staged,sdlStage,openalStage,overlaySha256,openalStack};
}
/** Compile the VM and its native ABI modules after the shared libraries. */
export function compileHashLinkVM({work,flags,common,openalPrefix}){
 const source=path.join(work,'source'),sdlBuild=path.join(work,'sdl-build'),openal=path.join(work,'openal'),openalBuild=path.join(work,'openal-build');
 run('make',['-j2','hl','ui','CC=/usr/bin/clang -arch x86_64 -mmacosx-version-min=13.0 '+Paths.flagsString([...flags,'-I',path.join(source,'include/pcre')])],{cwd:source});
 run('cmake',['-S',source,'-B',path.join(work,'native'),...common,'-DCMAKE_SKIP_BUILD_RPATH=ON','-DHASHLINK_SDL_LIBRARY='+path.join(sdlBuild,'libSDL2.a'),'-DHASHLINK_OPENAL_LIBRARY='+(openalPrefix?path.join(openalPrefix,'lib/libopenal.1.25.2.dylib'):path.join(openalBuild,'libopenal.1.25.2.dylib')),'-DHASHLINK_OPENAL_INCLUDE='+path.join(openalPrefix||openal,'include')]);run('cmake',['--build',path.join(work,'native'),'--parallel','2']);
}
/** Relocate and seal completed build products without changing upstream checkouts. */
export function assemble({project,version,arch,output,work,compiled:{sourceRoot,staged,sdlStage,openalStage,overlaySha256,openalStack}}){
 const legacy=hashLinkProfile(version,resolveProject(project,root,{resolvePins:false}))==='1.9',Builder=hashlink(legacy?'legacy-build.js':'dynamic-legacy-build.js');
 const source=path.join(work,'source'),sdl=path.join(work,'sdl'),openal=path.join(work,'openal'),openalBuild=path.join(work,'openal-build');
 addLicenses(work,'SDL2',sdl);
 addLicenses(work,'SDL2 HIDAPI',`${sdl}/src/hidapi`);
 addLicenses(work,'SDL2 yuv2rgb',`${sdl}/src/video/yuv2rgb`);
 addLicenses(work,'libpng',`${source}/include/png`);
 addLicenses(work,'minimp3',`${source}/include/minimp3`);
 const openalLibrary=openalStack?path.join(openalStack.prefix,'lib/libopenal.1.25.2.dylib'):path.join(openalBuild,'libopenal.1.25.2.dylib');
 for(const name of ['hl','fmt.hdll','ui.hdll','sdl.hdll','openal.hdll'])run('/usr/bin/install_name_tool',['-change','libhl.dylib','@loader_path/libhl.dylib',path.join(source,name)]);
 for(const link of Binary.links(path.join(source,'openal.hdll'),arch==='x64'?'x86_64':arch).filter(link=>/\/(?:libopenal)(?:\.[^/]*)?\.dylib$/.test(link)))run('/usr/bin/install_name_tool',['-change',link,openalLibrary,path.join(source,'openal.hdll')]);
 const payloads=['libhl.dylib','fmt.hdll','ui.hdll','sdl.hdll','openal.hdll'].map(name=>({source:path.join(source,name),relative:'bin/'+name}));
 payloads.push({source:openalLibrary,relative:'bin/libopenal.1.dylib'});
 payloads.push({source:path.join(source,'src/hl.h'),relative:'bin/include/hl.h'});
 return sealRuntime({project,version,arch,output,executable:path.join(source,'hl'),executableRelative:'bin/hl',sourceRoot,upstreamRevision:Builder.REVISION,payloads,capabilities:{...bytecodeFacts(source),primitiveProfileId:legacy?'typed-1.9-macos-v2':'legacy-dynamic-1.12-macos-v1',primitiveProfileSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'producers/package-support/src/modules/hashlink/runtime/profiles',legacy?'typed-1.9-macos-v2.json':'legacy-dynamic-1.12-macos-v1.json'))).digest('hex'),macPackageVersion:version,sourceKind:'commit'},provenance:{upstreamVersion:legacy?'1.9':'1.12',nativeProfile:legacy?'1.9-sdl2.0.22-openal-soft1.25.2-macos-v2':'1.12-sdl2.0.22-openal-soft1.25.2-macos-v1',sourceTreeSha256:staged.treeSha256,overlaySha256,dependencies:[{name:'SDL2',revision:Builder.SDL_REVISION,sourceTreeSha256:sdlStage.treeSha256},{name:'OpenAL-soft',revision:Builder.OPENAL_REVISION,sourceTreeSha256:openalStage.treeSha256}]}});
}
recipeMain(import.meta,{compile,assemble});
