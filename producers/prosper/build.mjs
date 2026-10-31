import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'../..');
export const recipe=JSON.parse(fs.readFileSync(new URL('./source.json',import.meta.url)));
export const inputs=JSON.parse(fs.readFileSync(new URL('./dependencies.json',import.meta.url)));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',maxBuffer:64*1024**2});
function verify(entry,directory){
 if(git(directory,['rev-parse','HEAD']).trim()!==entry.revision||git(directory,['remote','get-url','origin']).trim()!==entry.repository||git(directory,['status','--porcelain']).trim())throw Error('Source identity differs: '+(entry.id||'prosper'));
}
function write(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});if(!fs.existsSync(file)||!fs.readFileSync(file).equals(Buffer.from(bytes)))fs.writeFileSync(file,bytes);}
function sync(from,to){
 fs.mkdirSync(to,{recursive:true});const names=fs.readdirSync(from);for(const name of fs.readdirSync(to))if(!names.includes(name))fs.rmSync(path.join(to,name),{recursive:true,force:true});
 for(const name of names){const input=path.join(from,name),output=path.join(to,name),stat=fs.lstatSync(input);if(stat.isDirectory())sync(input,output);else if(stat.isFile()){write(output,fs.readFileSync(input));fs.chmodSync(output,stat.mode&0o777);}else if(stat.isSymbolicLink()){const link=fs.readlinkSync(input);try{if(fs.readlinkSync(output)===link)continue;}catch{}fs.rmSync(output,{force:true});fs.symlinkSync(link,output);}else throw Error('Unsupported source input.');}
}
function vulkanInput(library){
 const bytes=fs.readFileSync(library),hash=sha(bytes);
 for(let directory=path.dirname(library),depth=0;depth<5;directory=path.dirname(directory),depth++){
  const file=path.join(directory,'manifest.json');if(!fs.existsSync(file))continue;
  const manifest=JSON.parse(fs.readFileSync(file));const entry=manifest.files?.find(row=>row.sha256===hash&&row.path.endsWith(path.basename(library)));
  if(!entry)continue;
  const source=path.basename(library).startsWith('libvulkan')?manifest.provenance?.targetInputs?.vulkanLoader:{repository:manifest.provenance?.sourceUrl,revision:manifest.upstreamRevision};
  if(!source?.repository||!/^[a-f0-9]{40}$/.test(source.revision||''))throw Error('The Vulkan link input has no exact public source identity.');
  return{managerId:manifest.managerId,version:manifest.version,sha256:hash,source:{repository:source.repository,revision:source.revision},architectures:entry.architectures};
 }
 throw Error('Choose a library from an existing managed Vulkan runtime with its source manifest.');
}
async function dependency(entry,buildDirectory){
 if(entry.reusePath&&fs.existsSync(path.join(root,entry.reusePath))){const selected=path.join(root,entry.reusePath);verify(entry,selected);return selected;}
 const selected=path.join(buildDirectory,'dependencies',entry.id);
 if(!fs.existsSync(path.join(selected,'.git'))){fs.mkdirSync(path.dirname(selected),{recursive:true});run('git',['clone','--filter=blob:none','--no-checkout',entry.repository,selected]);}
 try{verify(entry,selected);return selected;}catch{}
 if(fs.readdirSync(selected).some(name=>name!=='.git')&&git(selected,['status','--porcelain']).trim())throw Error('Dependency checkout has local changes: '+entry.id);
 run('git',['-C',selected,'fetch','--depth','1','origin',entry.revision]);run('git',['-C',selected,'checkout','--detach',entry.revision]);verify(entry,selected);return selected;
}
async function ffmpeg(buildDirectory,downloads){
 const entry=inputs.artifacts[0],cache=path.join(buildDirectory,'downloads',entry.id+'.zip');
 if(!fs.existsSync(cache)||sha(fs.readFileSync(cache))!==entry.sha256){
  const previous=downloads&&path.join(downloads,entry.id+'.zip');let bytes;
  if(previous&&fs.existsSync(previous))bytes=fs.readFileSync(previous);
  else{const response=await fetch(entry.url);if(!response.ok)throw Error('FFmpeg download failed: '+response.status);bytes=Buffer.from(await response.arrayBuffer());}
  if(bytes.length!==entry.bytes||sha(bytes)!==entry.sha256)throw Error('FFmpeg archive identity differs.');write(cache,bytes);
 }
 const directory=path.join(buildDirectory,'dependencies',entry.id),marker=path.join(directory,'.package-sha256');
 if(!fs.existsSync(marker)||fs.readFileSync(marker,'utf8').trim()!==entry.sha256){fs.mkdirSync(directory,{recursive:true});run('cmake',['-E','tar','xf',cache],{cwd:directory});write(marker,entry.sha256+'\n');}
 return directory;
}
export async function build({buildDirectory=path.join(root,'out/prosper'),vulkanLibrary,downloads,python,jobs=4,check=false,configureOnly=false}={}){
 const source=path.join(root,recipe.source.path);verify(recipe.source,source);
 if(check)return{id:recipe.id,revision:recipe.source.revision,redistribution:recipe.redistribution,dependencies:inputs.dependencies};
 if(process.platform!=='darwin'||!path.isAbsolute(buildDirectory)||!Number.isSafeInteger(jobs)||jobs<1||jobs>128)throw Error('Use macOS, an absolute build directory and1–128 jobs.');
 if(!path.isAbsolute(vulkanLibrary||'')||!fs.statSync(vulkanLibrary).isFile())throw Error('Choose the existing managed Intel Vulkan library with --vulkan-library.');
 const relative=path.relative(source,buildDirectory);if(!relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw Error('Build outside the upstream checkout.');
 fs.mkdirSync(buildDirectory,{recursive:true});
 const dependencies={};for(const entry of inputs.dependencies)dependencies[entry.id]=await dependency(entry,buildDirectory);
 const linkedVulkan=vulkanInput(vulkanLibrary),codecs=await ffmpeg(buildDirectory,downloads),projection=path.join(buildDirectory,'source'),binary=path.join(buildDirectory,'build'),staged=fs.mkdtempSync(path.join(buildDirectory,'.source-'));
 try{
  const archive=path.join(buildDirectory,'source.tar');run('git',['-C',source,'archive','--format=tar','--output='+archive,recipe.source.revision,'prosper']);run('/usr/bin/tar',['-xf',archive,'-C',staged]);fs.unlinkSync(archive);
  const revisionFile=path.join(staged,'prosper/cmake/GenerateBuildRevision.cmake');let revision=fs.readFileSync(revisionFile,'utf8');const anchor='set(PROSPER_GENERATED_REVISION "unknown")';if(!revision.includes(anchor))throw Error('Prosper exported revision boundary changed.');write(revisionFile,revision.replace(anchor,'set(PROSPER_GENERATED_REVISION "'+recipe.source.revision+'")'));
  const nidFile=path.join(staged,'prosper/src/hle/dispatch/nid.cpp'),nid=fs.readFileSync(nidFile,'utf8'),sourcePath='load_names_file(PROSPER_SOURCE_DIR "/data/known_names.txt");';
  if(nid.split(sourcePath).length!==2)throw Error('Prosper optional NID database boundary changed.');
  write(nidFile,nid.replace(sourcePath,'load_names_file("/prosper/data/known_names.txt");'));
  sync(staged,projection);
 }finally{fs.rmSync(staged,{recursive:true,force:true});}
 if(!python){try{python=execFileSync('uv',['python','find'],{encoding:'utf8'}).trim();}catch{throw Error('A Python interpreter from uv or --python is required for upstream build metadata.');}}
 const maps='-ffile-prefix-map='+projection+'=/prosper -ffile-prefix-map='+path.join(buildDirectory,'dependencies')+'=/prosper-dependencies';
 run('cmake',['-S',path.join(projection,'prosper'),'-B',binary,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES=x86_64','-DCMAKE_OSX_DEPLOYMENT_TARGET=26.0',
  '-DBUILD_TESTING=OFF','-DPROSPER_APP=ON','-DPROSPER_AUDIO_SDL3=ON','-DPROSPER_PAD_SDL3=ON','-DPROSPER_AUDIO_FFMPEG=ON','-DPROSPER_VIDEO_VAAPI=OFF',
  '-DPROSPER_MACOS_MOLTENVK='+vulkanLibrary,'-DPROSPER_MACOS_VULKAN_INCLUDE='+path.join(dependencies['vulkan-headers'],'include'),
  '-DFETCHCONTENT_SOURCE_DIR_SDL3='+dependencies.sdl3,'-DPython3_EXECUTABLE='+python,'-DCMAKE_C_FLAGS='+maps,'-DCMAKE_CXX_FLAGS='+maps],
  {env:{...process.env,PKG_CONFIG_LIBDIR:path.join(codecs,'lib/pkgconfig'),PKG_CONFIG_PATH:''}});
 if(!configureOnly)run('cmake',['--build',binary,'--target','prosper-app','--parallel',String(jobs)]);
 const result={schemaVersion:1,id:recipe.id,revision:recipe.source.revision,redistribution:recipe.redistribution,architecture:'x86_64',
  executable:path.join(binary,'prosper-app'),source:recipe.source,dependencies:inputs.dependencies,artifacts:inputs.artifacts,vulkanLinkInput:linkedVulkan};
 write(path.join(buildDirectory,'build.json'),JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{const options={};for(let i=2;i<process.argv.length;i++){const flag=process.argv[i];if(['--check','--configure-only'].includes(flag)){options[flag==='--check'?'check':'configureOnly']=true;continue;}const key={'--build-dir':'buildDirectory','--vulkan-library':'vulkanLibrary','--downloads':'downloads','--python':'python','--jobs':'jobs'}[flag];if(!key||!process.argv[i+1])throw Error('Use --check, --build-dir, --vulkan-library, --downloads, --python or --jobs.');options[key]=key==='jobs'?Number(process.argv[++i]):process.argv[++i];}console.log(JSON.stringify(await build(options)));}catch(error){console.error(error.message);process.exitCode=1;}
}
