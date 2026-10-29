import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {recipe,inputs,verifySources,prepareSourceProjection,writeChanged} from './source-projection.mjs';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'../..');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function run(command,args,options={}){
 const result=spawnSync(command,args,{stdio:'inherit',...options});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(command+' exited with status '+result.status);
}
async function prepareFfmpeg(buildDirectory){
 const artifact=inputs.artifacts.find(entry=>entry.id==='ffmpeg-macos-x64');
 const cache=path.join(buildDirectory,'downloads',artifact.id+'.zip');
 if(!fs.existsSync(cache)||digest(fs.readFileSync(cache))!==artifact.sha256){
  fs.mkdirSync(path.dirname(cache),{recursive:true});
  const response=await fetch(artifact.url);if(!response.ok)throw Error('FFmpeg download failed: '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length!==artifact.bytes||digest(bytes)!==artifact.sha256)throw Error('FFmpeg package checksum mismatch.');
  writeChanged(cache,bytes);
 }
 const directory=path.join(buildDirectory,'dependencies',artifact.id),identity=path.join(directory,'.package-sha256');
 if(!fs.existsSync(identity)||fs.readFileSync(identity,'utf8').trim()!==artifact.sha256){
  fs.mkdirSync(directory,{recursive:true});run('cmake',['-E','tar','xf',cache],{cwd:directory});writeChanged(identity,artifact.sha256+'\n');
 }
 return directory;
}
export async function buildRuntime({buildDirectory=path.join(root,'out/anyps5-runtime'),jobs=4,check=false,configureOnly=false}={}){
 const {source,repositories}=verifySources();
 if(check)return {id:'anyps5',revision:recipe.source.revision,architecture:'x86_64',dependencies:inputs.dependencies.length};
 if(process.platform!=='darwin')throw Error('The runtime recipe requires macOS.');
 if(!path.isAbsolute(buildDirectory)||!Number.isSafeInteger(jobs)||jobs<1||jobs>128)throw Error('Use an absolute build directory and between 1 and 128 build jobs.');
 buildDirectory=path.resolve(buildDirectory);
 const relative=path.relative(source,buildDirectory);
 if(!relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw Error('The build directory must be outside the upstream checkout.');
 const projection=path.join(buildDirectory,'source'),binary=path.join(buildDirectory,'build');
 await prepareSourceProjection({source,repositories},projection);
 const ffmpeg=await prepareFfmpeg(buildDirectory);
 run('cmake',['-S',projection,'-B',binary,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES=x86_64','-DCMAKE_OSX_DEPLOYMENT_TARGET=26.0',
  '-DBUILD_TESTING=OFF','-DANYPS5_RELINKER_ONLY=OFF','-DANYPS5_USE_SYSTEM_DEPS=OFF','-DFFMPEG_PREBUILT_DIR='+ffmpeg,
  '-DCMAKE_C_FLAGS=-ffile-prefix-map='+projection+'=/anyps5','-DCMAKE_CXX_FLAGS=-ffile-prefix-map='+projection+'=/anyps5']);
 if(!configureOnly)run('cmake',['--build',binary,'--target','libs','--parallel',String(jobs)]);
 return {id:'anyps5',revision:recipe.source.revision,architecture:'x86_64',projection,buildDirectory:binary,libraries:path.join(binary,'core/libs/libs')};
}
async function main(args){
 const options={};
 for(let index=0;index<args.length;index++){
  if(['--check','--configure-only'].includes(args[index])){options[args[index]==='--check'?'check':'configureOnly']=true;continue;}
  const key=args[index]?.slice(2),value=args[++index];
  if(!['build-dir','jobs'].includes(key)||!value)throw Error('Use --check, --configure-only, --build-dir /absolute/path or --jobs <count>.');
  options[key==='build-dir'?'buildDirectory':'jobs']=key==='jobs'?Number(value):value;
 }
 return buildRuntime(options);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{console.log(JSON.stringify(await main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}
}
