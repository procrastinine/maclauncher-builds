import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {recipe,verifySources,prepareSourceProjection,RELINKER_OVERLAYS} from './source-projection.mjs';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'../..');

function run(command,args){
 const result=spawnSync(command,args,{stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(command+' exited with status '+result.status);
}

export async function buildRelinker({buildDirectory=path.join(root,'out/anyps5-relinker'),jobs=4,check=false}={}){
 const {source,repositories}=verifySources({includeDependencies:false});
 if(check)return {id:recipe.id,revision:recipe.source.revision,architecture:recipe.output.architecture};
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('This recipe builds the ARM64 macOS relinker.');
 if(!path.isAbsolute(buildDirectory)||!Number.isSafeInteger(jobs)||jobs<1||jobs>128)throw Error('Use an absolute build directory and between 1 and 128 build jobs.');
 buildDirectory=path.resolve(buildDirectory);
 const relative=path.relative(source,buildDirectory);
 if(!relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw Error('The build directory must be outside the upstream source checkout.');
 const projection=path.join(buildDirectory,'source'),cache=path.join(buildDirectory,'CMakeCache.txt');
 if(fs.existsSync(cache)){
  const configured=/^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$/m.exec(fs.readFileSync(cache,'utf8'))?.[1];
  if(configured&&path.resolve(configured)!==projection)throw Error('The CMake cache uses a different source directory. Choose a fresh --build-dir; the existing build is preserved.');
 }
 await prepareSourceProjection({source,repositories},projection,{overlays:RELINKER_OVERLAYS});
 run('cmake',['-S',projection,'-B',buildDirectory,...Object.entries(recipe.configure).map(([key,value])=>'-D'+key+'='+value),
  '-DCMAKE_CXX_FLAGS=-ffile-prefix-map='+projection+'=/anyps5']);
 run('cmake',['--build',buildDirectory,'--parallel',String(jobs)]);
 const executable=path.join(buildDirectory,recipe.output.executableRelative);
 run(executable,['--help']);
 return {id:recipe.id,revision:recipe.source.revision,architecture:recipe.output.architecture,projection,executable};
}

export async function main(args){
 const options={};
 for(let index=0;index<args.length;index++){
  if(args[index]==='--check'){
   if(options.check)throw Error('Duplicate --check.');
   options.check=true;continue;
  }
  const key=args[index]?.slice(2),value=args[index+1];
  if(!args[index]?.startsWith('--')||!['build-dir','jobs'].includes(key)||!value||Object.hasOwn(options,key))throw Error('Use --check, --build-dir /absolute/path or --jobs <count>.');
  options[key]=value;index++;
 }
 if(options.check&&(options['build-dir']||options.jobs))throw Error('--check does not accept build options.');
 return buildRelinker({check:options.check,buildDirectory:options['build-dir'],jobs:options.jobs===undefined?undefined:Number(options.jobs)});
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{console.log(JSON.stringify(await main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}
}
