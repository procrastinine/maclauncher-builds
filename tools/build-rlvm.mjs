// SPDX-License-Identifier: MIT
import './producer-environment.mjs';
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';
import {stageSource,run,recipeMain,findBuildTool} from './build-source.mjs';
import {buildInput} from './build-input.mjs';import {upstreamRevision} from '../lib/projects.mjs';
import {helperPackage,sha} from './helper-package.mjs';import {addLicenses} from '../lib/licenses.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Fonts=require('../producers/package-support/src/modules/shared/runtime/portable-sdl2-fonts.js');
const Source=require('../producers/package-support/src/modules/shared/runtime/pinned-native-build.js');
const Tools=require('../producers/package-support/scripts/native-binary-tools.cjs');
const MachO=require('../lib/macho-load-commands.cjs');
const here=path.join(root,'producers/rlvm');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,'producers/dependencies',name+'.json')));
export function dependencyInputs(){return Object.fromEntries(['sdl2','sdl12Compat','boost','libpng','freetype','ogg','vorbis','gettext'].map(id=>{const p=read(id);return [id,{...p,url:p.url||p.repository+'/archive/'+p.revision+'.tar.gz'}];}));}
function sourceList(source,file,name){const text=fs.readFileSync(path.join(source,file),'utf8'),body=text.match(new RegExp('\\b'+name+'\\s*=\\s*\\[([\\s\\S]*?)\\]'))?.[1];if(!body)throw Error('Missing upstream production source list: '+file+':'+name);return [...body.matchAll(/"([^"\n]+\.(?:cc|cpp|c|mm|png))"/g)].map(m=>path.join(path.dirname(file),m[1]));}
export function projectSources(source,build){
 const engine=[...['librlvm_files','libsystemsdl_files','guichan_platform'].flatMap(name=>sourceList(source,'SConscript',name)),...sourceList(source,'SConscript.cocoa','cocoarlvm_files')];
 const vendor=[['SDL_image','libsdl_image_files'],['SDL_mixer','libsdl_mixer_files'],['SDL_ttf','libsdl_ttf_files'],['GLEW','libglew_files'],['guichan','libguichan_files']].flatMap(([dir,name])=>sourceList(source,'vendor/'+dir+'/SConscript',name));
 const resources=sourceList(source,'SConscript','guichan_resources');
 for(const name of [...engine,...vendor,...resources])if(!fs.existsSync(path.join(source,name)))throw Error('Missing upstream source '+name);
 const quote=value=>'"'+value.replaceAll('\\','/').replaceAll('"','\\"')+'"';
 fs.mkdirSync(build,{recursive:true});fs.writeFileSync(path.join(build,'upstream-sources.cmake'),[['engine_sources',engine],['vendor_sources',vendor],['resource_inputs',resources]].map(([name,files])=>'set('+name+'\n'+files.map(file=>quote(path.join(source,file))).join('\n')+'\n)\n').join(''));
 return {engine,vendor,resources};
}
async function dependencySources(work){const result={};for(const [id,pin]of Object.entries(dependencyInputs())){const archive=await buildInput(pin),source=path.join(work,'sources',id);if(!fs.existsSync(source)){fs.mkdirSync(source,{recursive:true});run('/usr/bin/tar',['-xf',archive,'--strip-components','1','-C',source]);}result[id]=source;}return result;}
// The shared Boost archive is the release's Boost.Build export, not a CMake tree.
export async function buildBoost({source,prefix,slice,cpu,work,env}){
 const exported=path.join(slice,'boost-source');
 if(!fs.existsSync(exported))fs.cpSync(source,exported,{recursive:true,mode:fs.constants.COPYFILE_FICLONE});
 for(const file of ['Jamroot','boost-build.jam','tools/build/src/engine/build.sh'])if(!fs.existsSync(path.join(exported,file)))throw Error('Boost.Build export is missing '+file);
 const cxx=process.env.CXX||'/usr/bin/clang++',engine=path.join(exported,'tools/build/src/engine');
 run('/bin/sh',[path.join(engine,'build.sh'),'cxx','--cxx='+cxx,'--cxxflags=-ffile-prefix-map='+work+'=RLVM_BUILD'],{cwd:engine,env});
 const config=path.join(slice,'boost-user-config.jam');fs.writeFileSync(config,'using clang : rlvm : "'+cxx+'" ;\n');
 const flags='-arch '+cpu+' -mmacosx-version-min=13.0 -ffile-prefix-map='+work+'=RLVM_BUILD';
 run(path.join(engine,'b2'),['--ignore-site-config','--user-config='+config,'--build-dir='+path.join(slice,'boost-build'),'--prefix='+prefix,'--layout=system','-j2','toolset=clang-rlvm','target-os=darwin','architecture='+(cpu==='arm64'?'arm':'x86'),'address-model=64','variant=release','link=static','threading=multi','cxxstd=14','cxxflags='+flags,'linkflags='+flags,...['filesystem','iostreams','program_options','serialization','thread','date_time'].map(name=>'--with-'+name),'install'],{cwd:exported,env});
}
function compilerArguments(args){return args.map(arg=>arg.startsWith('-DCMAKE_C_COMPILER=')?'-DCMAKE_C_COMPILER='+(process.env.CC||'/usr/bin/clang'):arg.startsWith('-DCMAKE_CXX_COMPILER=')?'-DCMAKE_CXX_COMPILER='+(process.env.CXX||'/usr/bin/clang++'):arg);}
export async function buildSlice({architecture,work,sources,engineSource}){
 const cpu=architecture==='x64'?'x86_64':'arm64',slice=path.join(work,architecture),prefix=path.join(slice,'prefix'),sdk=execFileSync('/usr/bin/xcrun',['--show-sdk-path'],{encoding:'utf8'}).trim();
 fs.mkdirSync(prefix,{recursive:true});const tools={cmake:findBuildTool('cmake'),ninja:findBuildTool('ninja')},pathMappings=[{from:work,to:'RLVM_BUILD'}],env=Fonts.buildEnvironment(prefix,sdk);
 const build=async(id,options=[])=>Fonts.buildProject({sourceRoot:sources[id],outputRoot:path.join(slice,id),prefix,sdk,tools,architecture,pathMappings,options,dependencies:{runBuildCommand:(tool,args,options)=>Source.runBuildCommand(tool,compilerArguments(args),options)}});
 Fonts.sdkCompressionMetadata(sdk,prefix);
 await build('sdl2',['-DSDL_SHARED=ON','-DSDL_STATIC=OFF','-DSDL_TEST=OFF','-DSDL_TESTS=OFF']);
 await build('libpng',['-DPNG_SHARED=ON','-DPNG_STATIC=OFF','-DPNG_TESTS=OFF','-DPNG_TOOLS=OFF','-DPNG_EXECUTABLES=OFF']);
 await build('freetype',['-DFT_DISABLE_HARFBUZZ=ON','-DFT_DISABLE_BROTLI=ON','-DFT_DISABLE_PNG=ON','-DFT_DISABLE_BZIP2=ON']);
 await build('ogg',['-DBUILD_SHARED_LIBS=ON','-DBUILD_TESTING=OFF']);
 await build('vorbis',['-DBUILD_SHARED_LIBS=ON','-DBUILD_TESTING=OFF']);
 await build('sdl12Compat',['-DSDL12DEVEL=ON','-DSDL12TESTS=OFF','-DSDL12COMPAT_STATIC=OFF']);
 // Boost is built from the one shared source declaration; no host package is linked.
 await buildBoost({source:sources.boost,prefix,slice,cpu,work,env});
 const intlBuild=path.join(slice,'intl');fs.mkdirSync(intlBuild,{recursive:true});
 const flags='-arch '+cpu+' -mmacosx-version-min=13.0 -ffile-prefix-map='+work+'=RLVM_BUILD';
 run(path.join(sources.gettext,'gettext-runtime/configure'),['--prefix='+prefix,'--host='+(cpu==='arm64'?'aarch64':'x86_64')+'-apple-darwin','--disable-shared','--enable-static','--disable-java','--disable-csharp','--disable-libasprintf'],{cwd:intlBuild,env:{...env,CC:process.env.CC||'/usr/bin/clang',CFLAGS:flags,LDFLAGS:flags}});
 run('/usr/bin/make',['-C',path.join(intlBuild,'intl'),'-j2','install'],{env});
 const buildRoot=path.join(slice,'rlvm');const lists=projectSources(engineSource,buildRoot);
 run(tools.cmake,compilerArguments(['-S',here,'-B',buildRoot,...Fonts.cmakeOptions({prefix,sdk,ninja:tools.ninja,architecture,pathMappings,options:[]}),'-DRLVM_SOURCE='+engineSource,'-DNODE_EXECUTABLE='+process.execPath]),{env});
 run(tools.cmake,['--build',buildRoot,'--parallel','2'],{env});
 return {architecture,cpu,prefix,binary:path.join(buildRoot,'rlvm'),lists};
}
export async function prepare({arch='universal',work}){
 if(arch!=='universal')throw Error('RLVM engine producer builds the universal engine.');
 fs.mkdirSync(work,{recursive:true});const source=path.join(work,'rlvm-source'),sourceRoot=path.join(here,'source'),revision=upstreamRevision('rlvm','rlvm');
 const staged=await stageSource(sourceRoot,revision,source);
 run('git',['apply','--unsafe-paths','--directory='+source,path.join(here,'vorbis-callback-const.patch')],{cwd:root});
 run('git',['apply','--unsafe-paths','--directory='+source,path.join(here,'boost-parent-path.patch')],{cwd:root});
 run('git',['apply','--unsafe-paths','--directory='+source,path.join(here,'boost-directory-header.patch')],{cwd:root});
 run('git',['apply','--unsafe-paths','--directory='+source,path.join(here,'standard-stream-headers.patch')],{cwd:root});
 run('git',['apply','--unsafe-paths','--directory='+source,path.join(here,'boost-system-directory-header.patch')],{cwd:root});
 run('git',['apply','--unsafe-paths','--directory='+source,path.join(here,'cocoa-application-class.patch')],{cwd:root});
 const sources=await dependencySources(work);
 return {source,sourceRoot,revision,staged,sources};
}
export async function compile({arch='universal',work,prepared}){
 if(arch!=='universal')throw Error('RLVM engine producer builds the universal engine.');
 prepared ||= await prepare({arch,work});
 const slices=[];
 for(const architecture of ['arm64','x64'])slices.push(await buildSlice({architecture,work,sources:prepared.sources,engineSource:prepared.source}));
 const compiled={...prepared,slices};
 fs.writeFileSync(path.join(work,'compiled.json'),JSON.stringify(compiled,null,2)+'\n');
 return compiled;
}
function closure(slice){
 const result=new Map(),pending=[slice.binary],seen=new Set();
 for(let i=0;i<pending.length;i++){const binary=fs.realpathSync(pending[i]);if(seen.has(binary))continue;seen.add(binary);
  const commands=Tools.loadCommands(binary,slice.cpu),ids=Tools.libraryIds(binary,slice.cpu);
  for(const link of Tools.links(binary,slice.cpu)){if(link.startsWith('/usr/lib/')||link.startsWith('/System/Library/')||ids.includes(link))continue;
   const source=Tools.resolveLink(link,binary,slice.binary,commands.rpaths,slice.cpu);if(!source)throw Error('Unresolved runtime dependency '+link);
   const name=path.basename(source);if(result.has(name)&&result.get(name)!==source)throw Error('Dependency basename collision '+name);result.set(name,source);pending.push(source);
  }
 }
 // SDL1.2-compat loads SDL2 dynamically; include that declared runtime dependency.
 const sdl2=fs.realpathSync(path.join(slice.prefix,'lib/libSDL2.dylib'));result.set(path.basename(sdl2),sdl2);
 return result;
}
export async function assemble({project='rlvm',version,arch='universal',output,work,compiled}){
 compiled ||= JSON.parse(fs.readFileSync(path.join(work,'compiled.json'),'utf8'));
 if(fs.existsSync(output))throw Error('Immutable RLVM output exists.');
 const payload=path.join(output,'payload'),app=path.join(payload,'rlvm.app'),bin=path.join(app,'Contents/MacOS'),libs=path.join(app,'Contents/Frameworks'),resources=path.join(app,'Contents/Resources');
 for(const dir of [bin,libs,resources])fs.mkdirSync(dir,{recursive:true});const maps=compiled.slices.map(closure),names=[...maps[0].keys()].sort();
 if(JSON.stringify(names)!==JSON.stringify([...maps[1].keys()].sort()))throw Error('RLVM slice dependency closures differ.');
 // Relocate each owned thin copy using its own load commands before merging.
 const staging=path.join(output,'relocated-slices');fs.mkdirSync(staging,{recursive:true});
 const merge=(inputs,target)=>{
  const relocated=inputs.map((input,i)=>{
   const slice=compiled.slices[i],directory=path.join(staging,slice.cpu);fs.mkdirSync(directory,{recursive:true});
   const copy=path.join(directory,path.basename(target));fs.copyFileSync(input,copy,fs.constants.COPYFILE_FICLONE);fs.chmodSync(copy,0o755);
   Tools.thinStagedMachO(copy,staging,slice.cpu,run);
   const commands=Tools.loadCommands(copy,slice.cpu),ids=Tools.libraryIds(copy,slice.cpu);
   for(const link of Tools.links(copy,slice.cpu))if(!link.startsWith('/usr/lib/')&&!link.startsWith('/System/Library/')&&!ids.includes(link)){
    const dependency=Tools.resolveLink(link,input,slice.binary,commands.rpaths,slice.cpu),name=dependency&&path.basename(dependency);
    if(!dependency||maps[i].get(name)!==dependency)throw Error('Relocation dependency is outside the compiled closure: '+link);
    run('/usr/bin/install_name_tool',['-change',link,'@executable_path/../Frameworks/'+name,copy]);
   }
   for(const rpath of new Set(commands.rpaths))if(path.isAbsolute(rpath)&&!rpath.startsWith('/System/'))run('/usr/bin/install_name_tool',['-delete_rpath',rpath,copy]);
   if(target!==path.join(bin,'rlvm'))run('/usr/bin/install_name_tool',['-id','@rpath/'+path.basename(target),copy]);
   return copy;
  });
  run('/usr/bin/lipo',['-create',...relocated,'-output',target]);
  fs.chmodSync(target,0o755);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',target]);
 };
 const executable=path.join(bin,'rlvm');merge(compiled.slices.map(s=>s.binary),executable);
 for(const name of names)merge(maps.map(m=>m.get(name)),path.join(libs,name));
 fs.copyFileSync(path.join(compiled.source,'src/platforms/osx/Info.plist.in'),path.join(app,'Contents/Info.plist'));
 fs.copyFileSync(path.join(compiled.source,'resources/rlvm.icns'),path.join(resources,'rlvm.icns'));
 run('msgfmt',['-o',path.join(resources,'rlvm.mo'),path.join(compiled.source,'po/ja.po')]);
 const locale=path.join(resources,'locale/ja/LC_MESSAGES');fs.mkdirSync(locale,{recursive:true});fs.renameSync(path.join(resources,'rlvm.mo'),path.join(locale,'rlvm.mo'));
 for(const [name,source] of Object.entries({...compiled.sources,rlvm:compiled.source}))addLicenses(payload,name,source);
 for(const name of ['SDL_image','SDL_mixer','SDL_ttf','GLEW','guichan','xclannad','utf8cpp'])addLicenses(payload,name,path.join(compiled.source,'vendor',name));
 run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',app]);
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(path.join(here,'CMakeLists.txt')),manifestRelative:'manifest.json',record:{managerId:project,platform:'darwin',executableRelative:'rlvm.app/Contents/MacOS/rlvm',upstreamRevision:compiled.revision,dependencies:[]}});
}
recipeMain(import.meta,{prepare,compile,assemble});
