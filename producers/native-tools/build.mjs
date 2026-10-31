import {recipeMain} from '../../tools/build-source.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {buildInput} from '../../tools/build-input.mjs';
import {sealRuntime} from '../../tools/seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'../..');
const Source=require('../maclauncher/src/modules/shared/runtime/pinned-native-build.js');
const Portable=require('../maclauncher/src/modules/shared/runtime/portable-sdl2-fonts.js');
const profiles=JSON.parse(fs.readFileSync(new URL('./source.json',import.meta.url))).projects;
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:600000,maxBuffer:16<<20,...options});

function goBuild({pin,arch,source,work}){
 const environment={...process.env,GOOS:'darwin',GOARCH:arch==='x64'?'amd64':'arm64',CGO_ENABLED:'0',GOWORK:'off',
  GOCACHE:path.join(work,'go-cache'),GOMODCACHE:path.join(work,'go-modules'),GOPATH:path.join(work,'go-path'),
  GOFLAGS:'-mod=readonly',GOTOOLCHAIN:'local'};
 const execute=args=>run('go',args,{cwd:source,env:environment});
 const used=[...new Set(execute(['list','-deps','-f','{{if .Module}}{{.Module.Path}}{{end}}','./src/ziggy/ziggy.go']).split('\n').filter(value=>value&&value!=='uosc/bins'))].sort();
 if(JSON.stringify(used)!==JSON.stringify(pin.modules.map(entry=>entry.module).sort()))throw Error('The Ziggy module closure differs from its declared inputs.');
 const notices=[{file:path.join(source,'LICENSE.LGPL'),name:'uosc',license:pin.license,sourceUrl:pin.repository}];
 for(const entry of pin.modules){
  const module=JSON.parse(execute(['mod','download','-json',entry.module+'@'+entry.version]));
  if(module.Error||module.Sum!==entry.sum)throw Error('A Ziggy Go module differs from its declared checksum.');
  notices.push({file:path.join(module.Dir,'LICENSE'),name:entry.module,license:entry.license,sourceUrl:'https://'+entry.module+'/tree/'+entry.revision});
 }
 const goRoot=execute(['env','GOROOT']).trim(),goLicense=[path.join(goRoot,'LICENSE'),path.join(goRoot,'../LICENSE')].find(file=>fs.statSync(file,{throwIfNoEntry:false})?.isFile());
 if(!goLicense)throw Error('The Go toolchain license is missing.');
 notices.push({file:goLicense,name:'Go runtime',license:'BSD-3-Clause',sourceUrl:'https://go.dev/'});
 const executable=path.join(work,'ziggy-darwin');
 execute(['build','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',executable,'./src/ziggy/ziggy.go']);
 return {executable,notices,provenance:{goVersion:execute(['version']).trim(),modules:pin.modules.map(({module,version,revision,sum})=>({module,version,revision,sum}))},
  capabilities:{uoscVersion:pin.version,helper:'ziggy',commands:['get-clipboard','set-clipboard','download','http-get','http-post','http-put','http-patch','http-delete','open','search-subtitles','download-subtitles']}};
}

async function scummvmBuild({pin,arch,source,work}){
 const sdk=run('/usr/bin/xcrun',['--show-sdk-path']).trim(),prefix=path.join(work,'prefix');fs.mkdirSync(prefix);
 const tools={cmake:Source.findBuildTool('cmake'),ninja:Source.findBuildTool('ninja')},notices=[];
 const mappings=[{from:source,to:'scummvm-tools'},{from:work,to:'build'}];
 fs.mkdirSync(path.join(work,'dependencies'));
 const compilerFlags=['-O2','-Werror=unguarded-availability-new','-arch',arch==='x64'?'x86_64':'arm64','-isysroot',sdk,'-mmacosx-version-min=13.0',
  '-ffile-prefix-map='+source+'=scummvm-tools','-ffile-prefix-map='+work+'=build','-I'+path.join(prefix,'include')].join(' ');
 for(const group of pin.dependencies){
  const declared=JSON.parse(fs.readFileSync(path.join(root,group.file))).dependencies;
  for(const id of group.ids){
   const item=declared.find(entry=>entry.id===id);if(!item)throw Error('A ScummVM Tools dependency is not declared.');
   const archive=await buildInput({url:item.archiveUrl,sha256:item.archiveSha256,bytes:item.archiveBytes},path.join(work,'downloads'));
   const dependencySource=path.join(work,'sources',id);fs.mkdirSync(dependencySource,{recursive:true});
   run('/usr/bin/tar',['-xf',archive,'--strip-components','1','-C',dependencySource]);
   const options=[...item.options,...(id==='libpng'?['-DZLIB_LIBRARY='+sdk+'/usr/lib/libz.tbd','-DZLIB_INCLUDE_DIR='+sdk+'/usr/include']:[])];
   await Portable.buildProject({sourceRoot:dependencySource,outputRoot:path.join(work,'dependencies',id),prefix,sdk,tools,architecture:arch,pathMappings:mappings,options});
   for(const file of item.notices)notices.push({file:path.join(dependencySource,file),name:item.name,license:item.license,sourceUrl:item.sourceUrl});
  }
 }
 const build=path.join(work,'cli');fs.mkdirSync(build);
 const toolDirectory=path.join(work,'tools');fs.mkdirSync(toolDirectory);fs.symlinkSync(Source.findBuildTool('pkg-config'),path.join(toolDirectory,'pkg-config'));
 const env={...Portable.buildEnvironment(prefix,sdk),PATH:toolDirectory+':/usr/bin:/bin:/usr/sbin:/sbin',CPPFLAGS:'',CXX:'/usr/bin/clang++',CXXFLAGS:compilerFlags,
  LDFLAGS:['-arch',arch==='x64'?'x86_64':'arm64','-isysroot',sdk,'-mmacosx-version-min=13.0','-L'+prefix+'/lib','-Wl,-headerpad_max_install_names','-Wl,-rpath,'+prefix+'/lib'].join(' ')};
 // The managed payload is the CLI. GUI, standalone font generation and the
 // separate Boost decompiler are not part of that executable.
 const args=['--disable-wxwidgets','--disable-boost','--disable-freetype2','--disable-iconv','--disable-mad','--disable-tremor',
  '--with-staticlib-prefix='+prefix,'--disable-debug','--enable-vorbis','--enable-flac','--enable-png','--enable-zlib','--with-ogg-prefix='+prefix,'--with-vorbis-prefix='+prefix,'--with-flac-prefix='+prefix,'--with-png-prefix='+prefix];
 fs.writeFileSync(path.join(work,'configure.log'),run('/bin/sh',[path.join(source,'configure'),...args],{cwd:build,env}));
 fs.writeFileSync(path.join(work,'make.log'),run('/usr/bin/make',['-j4','scummvm-tools-cli'],{cwd:build,env}));
 const configuration=fs.readFileSync(path.join(build,'config.h'),'utf8');
 for(const symbol of ['USE_VORBIS','USE_FLAC','USE_PNG','USE_ZLIB'])if(!new RegExp('^#define '+symbol+'(?: 1)?$','m').test(configuration))throw Error('The CLI codec is absent: '+symbol);
 for(const file of ['COPYING','COPYING.BSD2','COPYING.LUA'])notices.push({file:path.join(source,file),name:'ScummVM Tools',license:pin.license,sourceUrl:pin.repository});
 return {executable:path.join(build,'scummvm-tools-cli'),notices,provenance:{sdkVersion:run('/usr/bin/xcrun',['--show-sdk-version']).trim()},capabilities:{tools:['extract_kyra','extract_gob_stk'],codecs:['vorbis','flac','png','zlib']}};
}

export async function buildNativeTool({project,version,arch,output,work,sources={}}){
 const pin=profiles[project];

 fs.mkdirSync(work,{recursive:true});
 const source=sources[project]||path.join(work,'source');
 if(!sources[project]){
  run('git',['clone','--filter=blob:none','--no-checkout',pin.repository,source]);
  run('git',['-C',source,'checkout','--detach',pin.revision]);
 }
 await Source.validatePinnedSource(source,pin.revision);
 const result=await (project==='uosc-helper'?goBuild:scummvmBuild)({pin,arch,source,work});
 await Source.validatePinnedSource(source,pin.revision);
 return sealRuntime({project,version,arch,output,sourceRoot:source,upstreamRevision:pin.revision,...result});
}
recipeMain(import.meta,buildNativeTool);
