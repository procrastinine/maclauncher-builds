import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {recipe,inputs,verifySources,prepareSourceProjection,writeChanged} from './source-projection.mjs';
import {pathToFileURL} from 'node:url';
import {buildInput} from '../../tools/build-input.mjs';
import {applyArm64LibrariesOverlay} from './overlays/arm64-libs/apply.mjs';

const root=path.resolve(import.meta.dirname,'../..');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function run(command,args,options={}){
 const result=spawnSync(command,args,{stdio:'inherit',...options});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(command+' exited with status '+result.status);
}
// The PRX libraries' CPU. x86_64 is the Rosetta route's runtime; arm64 libraries are native code for the FEX route
// (producers/anyps5-fex), with the arm64 library overlay and the arm64 FFmpeg build.
const LIBRARY_ARCHITECTURES={x86_64:{ffmpeg:'ffmpeg-macos-x64'},arm64:{ffmpeg:'ffmpeg-macos-arm64'}};
async function prepareFfmpeg(buildDirectory,id){
 const artifact=inputs.artifacts.find(entry=>entry.id===id);
 const cache=path.join(buildDirectory,'downloads',artifact.id+'.zip');
 if(!fs.existsSync(cache)||digest(fs.readFileSync(cache))!==artifact.sha256){
  fs.mkdirSync(path.dirname(cache),{recursive:true});
  fs.copyFileSync(await buildInput(artifact),cache);
 }
 const directory=path.join(buildDirectory,'dependencies',artifact.id),identity=path.join(directory,'.package-sha256');
 if(!fs.existsSync(identity)||fs.readFileSync(identity,'utf8').trim()!==artifact.sha256){
  fs.mkdirSync(directory,{recursive:true});run('cmake',['-E','tar','xf',cache],{cwd:directory});writeChanged(identity,artifact.sha256+'\n');
 }
 return directory;
}
export async function buildRuntime({buildDirectory=path.join(root,'out/anyps5-runtime'),jobs=4,check=false,configureOnly=false,python,libraryArchitecture='x86_64',targets=['libs']}={}){
 if(!Object.hasOwn(LIBRARY_ARCHITECTURES,libraryArchitecture))throw Error('The library architecture is x86_64 or arm64.');
 if(!Array.isArray(targets)||!targets.length||targets.some(target=>!/^[A-Za-z0-9_.+-]+$/.test(target)))throw Error('Name one or more CMake targets.');
 const {source,repositories}=verifySources();
 if(check)return {id:'anyps5',revision:recipe.source.revision,architecture:libraryArchitecture,dependencies:inputs.dependencies.length};
 if(process.platform!=='darwin')throw Error('The runtime recipe requires macOS.');
 if(!path.isAbsolute(buildDirectory)||!Number.isSafeInteger(jobs)||jobs<1||jobs>128)throw Error('Use an absolute build directory and between 1 and 128 build jobs.');
 buildDirectory=path.resolve(buildDirectory);
 const relative=path.relative(source,buildDirectory);
 if(!relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw Error('The build directory must be outside the upstream checkout.');
 const projection=path.join(buildDirectory,'source'),binary=path.join(buildDirectory,'build');
 await prepareSourceProjection({source,repositories},projection);
 const arm64=libraryArchitecture==='arm64';
 if(arm64)applyArm64LibrariesOverlay(projection);
 const ffmpeg=await prepareFfmpeg(buildDirectory,LIBRARY_ARCHITECTURES[libraryArchitecture].ffmpeg);
 run('cmake',['-S',projection,'-B',binary,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES='+libraryArchitecture,...(arm64?['-DANYPS5_ARM64_LIBS=ON']:[]),'-DCMAKE_OSX_DEPLOYMENT_TARGET=26.0',
  ...(python?['-DPython3_EXECUTABLE='+python]:[]),'-DBUILD_TESTING=OFF','-DANYPS5_RELINKER_ONLY=OFF','-DANYPS5_USE_SYSTEM_DEPS=OFF','-DFFMPEG_PREBUILT_DIR='+ffmpeg,
  '-DCMAKE_C_FLAGS=-ffile-prefix-map='+projection+'=/anyps5','-DCMAKE_CXX_FLAGS=-ffile-prefix-map='+projection+'=/anyps5']);
 if(!configureOnly)run('cmake',['--build',binary,'--target',...targets,'--parallel',String(jobs)]);
 return {id:'anyps5',revision:recipe.source.revision,architecture:libraryArchitecture,projection,buildDirectory:binary,libraries:path.join(binary,'core/libs/libs')};
}
async function main(args){
 const options={};
 for(let index=0;index<args.length;index++){
  if(['--check','--configure-only'].includes(args[index])){options[args[index]==='--check'?'check':'configureOnly']=true;continue;}
  const key=args[index]?.slice(2),value=args[++index];
  const names={'build-dir':'buildDirectory',jobs:'jobs','library-architecture':'libraryArchitecture',targets:'targets'};
  if(!Object.hasOwn(names,key)||!value)throw Error('Use --check, --configure-only, --build-dir /absolute/path, --jobs <count>, --library-architecture x86_64|arm64 or --targets <target,...>.');
  options[names[key]]=key==='jobs'?Number(value):key==='targets'?value.split(','):value;
 }
 return buildRuntime(options);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{console.log(JSON.stringify(await main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}
}
