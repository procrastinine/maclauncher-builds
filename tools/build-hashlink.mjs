import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {checkoutSource,stageSource,sourceNotices,run,buildOptions} from './build-source.mjs';
import {sealRuntime} from './seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),moduleRoot=path.join(root,'producers/maclauncher/src/modules/hashlink/runtime');
const Paths=require(path.join(moduleRoot,'compiler-paths.js'));
function bytecodeFacts(source){
 const code=fs.readFileSync(path.join(source,'src/code.c'),'utf8'),sdl=fs.readFileSync(path.join(source,'libs/sdl/sdl.c'),'utf8');
 const maximum=Number(/\bmax_version\s*=\s*(\d+)/.exec(code)?.[1]),minimum=Number(/c->version\s*<=\s*(\d+)\s*\|\|\s*c->version\s*>\s*max_version/.exec(code)?.[1]);
 const loop=/DEFINE_PRIM\s*\(\s*_BOOL\s*,\s*event_loop\s*,\s*(_DYN|_OBJ)/.exec(sdl)?.[1];
 if(!Number.isInteger(minimum)||!Number.isInteger(maximum)||maximum<=minimum||maximum>32||!loop)throw Error('HashLink bytecode or SDL primitive facts are unavailable.');
 return {supportedBytecodeVersions:Array.from({length:maximum-minimum},(_,i)=>minimum+i+1),nativeAbi:{sdlEventLoop:loop==='_DYN'?'dynamic':'typed-event'}};
}
export async function buildHashLink({project,arch,version,output,work}){
 if(project!=='hashlink'||arch!=='x64'||!/^1\.(9|12)-MCLv2$/.test(version||'')||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select HashLink 1.9 or 1.12, Intel and new absolute work/output paths.');
 fs.mkdirSync(work,{recursive:true});const legacy=version.startsWith('1.9'),Builder=require(path.join(moduleRoot,legacy?'legacy-build.js':'dynamic-legacy-build.js'));
 let sourceRoot=path.join(root,'producers/maclauncher/src/external/source-revisions/hashlink-1-9');
 if(!legacy)sourceRoot=checkoutSource({repository:'https://github.com/HaxeFoundation/hashlink',revision:Builder.REVISION,destination:path.join(work,'upstream')});
 const sdlRoot=path.join(root,'producers/maclauncher/src/external/krkrsdl2/external/SDL'),openalRoot=path.join(root,'producers/maclauncher/src/external/openal-soft');
 const source=path.join(work,'source'),sdl=path.join(work,'sdl'),openal=path.join(work,'openal');
 const staged=await stageSource(sourceRoot,Builder.REVISION,source),sdlStage=await stageSource(sdlRoot,Builder.SDL_REVISION,sdl),openalStage=await stageSource(openalRoot,Builder.OPENAL_REVISION,openal);
 const overlaySha256=Builder.adaptSource(source,sdl),flags=Paths.compilerFlags(Paths.compilerPathMappings({source,sdlSource:sdl,openalSource:openal,build:work,runtime:output})),overlay=path.join(work,'compiler-paths.cmake');
 fs.writeFileSync(overlay,Paths.cmakeOverlay(flags));
 const common=['-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES=x86_64','-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0','-DCMAKE_POLICY_VERSION_MINIMUM=3.5','-DCMAKE_PROJECT_INCLUDE='+overlay,'-DFETCHCONTENT_FULLY_DISCONNECTED=ON','-DFETCHCONTENT_UPDATES_DISCONNECTED=ON'];
 const sdlBuild=path.join(work,'sdl-build'),openalBuild=path.join(work,'openal-build');
 run('cmake',['-S',sdl,'-B',sdlBuild,...common,'-DSDL_SHARED=OFF','-DSDL_STATIC=ON','-DSDL_TEST=OFF','-DSDL_X11=OFF','-DHAVE_GCC_WERROR_DECLARATION_AFTER_STATEMENT=OFF']);run('cmake',['--build',sdlBuild,'--parallel','2']);
 run('cmake',['-S',openal,'-B',openalBuild,...common,'-DLIBTYPE=SHARED','-DALSOFT_UTILS=OFF','-DALSOFT_EXAMPLES=OFF','-DALSOFT_TESTS=OFF','-DALSOFT_INSTALL=OFF','-DALSOFT_UPDATE_BUILD_VERSION=OFF','-DALSOFT_BACKEND_COREAUDIO=ON','-DALSOFT_REQUIRE_COREAUDIO=ON','-DALSOFT_BACKEND_PIPEWIRE=OFF','-DALSOFT_BACKEND_PULSEAUDIO=OFF','-DALSOFT_BACKEND_JACK=OFF','-DALSOFT_BACKEND_PORTAUDIO=OFF','-DALSOFT_BACKEND_SDL2=OFF','-DALSOFT_BACKEND_SDL3=OFF']);run('cmake',['--build',openalBuild,'--parallel','2']);
 compileHashLinkVM({work,flags,common});
 return sealHashLink({project,version,arch,output,work,sourceRoot,staged,sdlStage,openalStage,overlaySha256});
}
/** Compile the VM and its native ABI modules after the shared libraries. */
export function compileHashLinkVM({work,flags,common}){
 const source=path.join(work,'source'),sdlBuild=path.join(work,'sdl-build'),openal=path.join(work,'openal'),openalBuild=path.join(work,'openal-build');
 run('make',['-j2','hl','ui','CC=/usr/bin/clang -arch x86_64 -mmacosx-version-min=13.0 '+Paths.flagsString([...flags,'-I',path.join(source,'include/pcre')])],{cwd:source});
 run('cmake',['-S',source,'-B',path.join(work,'native'),...common,'-DCMAKE_SKIP_BUILD_RPATH=ON','-DHASHLINK_SDL_LIBRARY='+path.join(sdlBuild,'libSDL2.a'),'-DHASHLINK_OPENAL_LIBRARY='+path.join(openalBuild,'libopenal.1.24.3.dylib'),'-DHASHLINK_OPENAL_INCLUDE='+path.join(openal,'include')]);run('cmake',['--build',path.join(work,'native'),'--parallel','2']);
}
/** Relocate and seal completed build products without changing upstream checkouts. */
export function sealHashLink({project='hashlink',version,arch='x64',output,work,sourceRoot,staged,sdlStage,openalStage,overlaySha256}){
 const legacy=version.startsWith('1.9'),Builder=require(path.join(moduleRoot,legacy?'legacy-build.js':'dynamic-legacy-build.js'));
 const source=path.join(work,'source'),sdl=path.join(work,'sdl'),openal=path.join(work,'openal'),openalBuild=path.join(work,'openal-build');
 for(const name of ['hl','fmt.hdll','ui.hdll','sdl.hdll','openal.hdll'])run('/usr/bin/install_name_tool',['-change','libhl.dylib','@loader_path/libhl.dylib',path.join(source,name)]);
 run('/usr/bin/install_name_tool',['-change','@rpath/libopenal.1.dylib',path.join(openalBuild,'libopenal.1.24.3.dylib'),path.join(source,'openal.hdll')]);
 const payloads=['libhl.dylib','fmt.hdll','ui.hdll','sdl.hdll','openal.hdll'].map(name=>({source:path.join(source,name),relative:'bin/'+name}));
 payloads.push({source:path.join(openalBuild,'libopenal.1.24.3.dylib'),relative:'bin/libopenal.1.dylib'});
 payloads.push({source:path.join(source,'src/hl.h'),relative:'bin/include/hl.h'});
 return sealRuntime({project,version,arch,output,executable:path.join(source,'hl'),executableRelative:'bin/hl',sourceRoot,upstreamRevision:Builder.REVISION,payloads,
  capabilities:{...bytecodeFacts(source),primitiveProfileId:legacy?'typed-1.9-macos-v2':'legacy-dynamic-1.12-macos-v1',primitiveProfileSha256:createHash('sha256').update(fs.readFileSync(path.join(moduleRoot,'profiles',legacy?'typed-1.9-macos-v2.json':'legacy-dynamic-1.12-macos-v1.json'))).digest('hex'),macPackageVersion:version,sourceKind:'commit'},
  notices:[...sourceNotices(source,{name:'HashLink',repository:'https://github.com/HaxeFoundation/hashlink'}),...sourceNotices(sdl,{name:'SDL2',repository:'https://github.com/libsdl-org/SDL'}),...sourceNotices(openal,{name:'OpenAL-soft',repository:'https://github.com/kcat/openal-soft'})],
  provenance:{upstreamVersion:legacy?'1.9':'1.12',nativeProfile:legacy?'1.9-sdl2.0.22-openal-soft1.24.3-macos-v2':'1.12-sdl2.0.22-openal-soft1.24.3-macos-v1',sourceTreeSha256:staged.treeSha256,overlaySha256,dependencies:[{name:'SDL2',revision:Builder.SDL_REVISION,sourceTreeSha256:sdlStage.treeSha256},{name:'OpenAL-soft',revision:Builder.OPENAL_REVISION,sourceTreeSha256:openalStage.treeSha256}]}});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)buildHashLink(buildOptions(process.argv.slice(2))).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
