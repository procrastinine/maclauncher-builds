import {retryNetwork} from '../../tools/download.mjs';
import {recipeMain} from '../../tools/build-source.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {preparedBuildInput} from '../../tools/prepared-build-inputs.mjs';
import {nativeStackInput} from '../../tools/native-stack.mjs';
import {sealRuntime} from '../../tools/seal-runtime.mjs';
import {addLicense} from '../../lib/licenses.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'../..');
const Source=require('../package-support/src/modules/shared/runtime/pinned-native-build.js');
const Portable=require('../package-support/src/modules/shared/runtime/portable-sdl2-fonts.js'),Prefix=require('../package-support/src/modules/shared/runtime/portable-dependency-prefix.js');
const profiles=JSON.parse(fs.readFileSync(new URL('./source.json',import.meta.url))).projects;
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:600000,maxBuffer: Infinity,...options});

function goBuild({pin,arch,source,work}){
 const environment={...process.env,GOOS:'darwin',GOARCH:arch==='x64'?'amd64':'arm64',CGO_ENABLED:'0',GOWORK:'off',
  GOCACHE:path.join(work,'go-cache'),GOMODCACHE:path.join(work,'go-modules'),GOPATH:path.join(work,'go-path'),
  GOFLAGS:'-mod=readonly',GOTOOLCHAIN:'local'};
 const execute=args=>{const action=()=>run('go',args,{cwd:source,env:environment});return ['list','mod'].includes(args[0])?retryNetwork(action):action();};
 const executable=path.join(work,'ziggy-darwin');
 execute(['build','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',executable,'./src/ziggy/ziggy.go']);
 addLicense(path.dirname(work),'github.com/atotto/clipboard',path.join(import.meta.dirname,'licenses/clipboard.txt'));
 addLicense(path.dirname(work),'github.com/pkg/browser',path.join(import.meta.dirname,'licenses/browser.txt'));
 addLicense(path.dirname(work),'Go runtime',path.join(import.meta.dirname,'licenses/Go.txt'));
 return {executable,provenance:{goVersion:execute(['version']).trim()},
  capabilities:{uoscVersion:pin.version,helper:'ziggy',commands:['get-clipboard','set-clipboard','download','http-get','http-post','http-put','http-patch','http-delete','open','search-subtitles','download-subtitles']}};
}

async function scummvmBuild({pin,arch,source,work}){
 const sdk=process.env.SDKROOT||run('/usr/bin/xcrun',['--show-sdk-path']).trim(),prefix=path.join(work,'prefix');fs.mkdirSync(prefix);
 const tools={cmake:Source.findBuildTool('cmake'),ninja:Source.findBuildTool('ninja')};
 const mappings=[{from:source,to:'scummvm-tools'},{from:work,to:'build'}];
 fs.mkdirSync(path.join(work,'dependencies'));
 const compilerFlags=['-O2','-Werror=unguarded-availability-new','-arch',arch==='x64'?'x86_64':'arm64','-isysroot',sdk,'-mmacosx-version-min=13.0',
  '-ffile-prefix-map='+source+'=scummvm-tools','-ffile-prefix-map='+work+'=build','-I'+path.join(prefix,'include')].join(' ');
 const fonts=nativeStackInput(preparedBuildInput('native-sdl2-fonts'),{arch,work:path.join(work,'fonts')}),audio=nativeStackInput(preparedBuildInput('native-sndfile'),{arch,work:path.join(work,'audio')});
 Prefix.linkPrefix(fonts.prefix,prefix);Prefix.linkPrefix(audio.prefix,prefix);
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
 return {executable:path.join(build,'scummvm-tools-cli'),provenance:{sdkVersion:run('/usr/bin/xcrun',['--show-sdk-version']).trim()},capabilities:{tools:['extract_kyra','extract_gob_stk'],codecs:['vorbis','flac','png','zlib']}};
}

// Each project's build path and the published packages that path uses.
const BUILDS={'uosc-helper':{build:goBuild,inputs:[]},'scummvm-tools':{build:scummvmBuild,inputs:['native-sdl2-fonts','native-sndfile']}};
export function recipeInputs({project}){
 if(!BUILDS[project])throw Error('No native tool build is declared for '+project+'.');
 return BUILDS[project].inputs;
}

export async function buildNativeTool({project,version,arch,output,work,sources={}}){
 if(!BUILDS[project])throw Error('No native tool build is declared for '+project+'.');
 const pin=profiles[project];

 fs.mkdirSync(work,{recursive:true});
 const source=sources[project]||path.join(work,'source');
 if(!sources[project]){
  retryNetwork(()=>run('git',['clone','--filter=blob:none','--no-checkout',pin.repository,source]));
  run('git',['-C',source,'checkout','--detach',pin.revision]);
 }
 await Source.validatePinnedSource(source,pin.revision);
 const result=await BUILDS[project].build({pin,arch,source,work});
 await Source.validatePinnedSource(source,pin.revision);
 return sealRuntime({project,version,arch,output,sourceRoot:source,upstreamRevision:pin.revision,...result});
}
recipeMain(import.meta,buildNativeTool);
