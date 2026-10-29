import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const root=path.resolve(import.meta.dirname,'../..');
export const recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json'),'utf8'));
export const inputs=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'dependencies.json'),'utf8'));
const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});

export function writeChanged(file,bytes,mode=0o644){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 if(!fs.existsSync(file)||!fs.readFileSync(file).equals(Buffer.from(bytes)))fs.writeFileSync(file,bytes,{mode});
 fs.chmodSync(file,mode);
}
export function verifySources({includeDependencies=true}={}){
 const source=fs.realpathSync(path.join(root,recipe.source.path));
 const repositories=[{...recipe.source,path:''},...(includeDependencies?inputs.dependencies:[])];
 for(const entry of repositories){
  const directory=entry===repositories[0]?source:path.join(source,entry.path);
  if(git(directory,['rev-parse','HEAD']).trim()!==entry.revision)throw Error('Source pin mismatch: '+(entry.path||'AnyPS5'));
  if(git(directory,['remote','get-url','origin']).trim()!==entry.repository)throw Error('Source origin mismatch: '+entry.path);
  if(git(directory,['status','--porcelain','--untracked-files=normal']).trim())throw Error('Source checkout has local changes: '+entry.path);
 }
 return {source,repositories};
}
function exportSources(source,repositories,destination){
 fs.mkdirSync(destination,{recursive:true});
 for(const [index,entry]of repositories.entries()){
  const directory=index===0?source:path.join(source,entry.path),output=index===0?destination:path.join(destination,entry.path);
  const files=git(directory,['ls-files','--stage','-z']).split('\0').filter(Boolean);
  for(const record of files){
   const separator=record.indexOf('\t'),mode=record.slice(0,6),relative=record.slice(separator+1);
   if(mode==='160000')continue;
   const from=path.join(directory,relative),to=path.join(output,relative);
   if(mode==='120000'){
    const link=fs.readlinkSync(from);fs.mkdirSync(path.dirname(to),{recursive:true});
    let existing;try{existing=fs.lstatSync(to);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing){
     try{if(fs.readlinkSync(to)===link)continue;}catch{}
     fs.rmSync(to,{force:true});
    }
    fs.symlinkSync(link,to);
   }else writeChanged(to,fs.readFileSync(from),mode==='100755'?0o755:0o644);
  }
 }
 // The runtime projection has no Git metadata. Its prebuilt FFmpeg package
 // is supplied explicitly; converter-only projections do not consume FFmpeg.
 if(!repositories.some(entry=>entry.path==='3rdparty/ffmpeg-core'))return;
 const ffmpeg=path.join(destination,'3rdparty/ffmpeg-core/CMakeLists.txt');
 const content=fs.readFileSync(ffmpeg,'utf8');
 const start=content.indexOf('execute_process('),end=content.indexOf('\n\n# An existing package',start);
 if(start<0||end<0)throw Error('Unexpected FFmpeg source revision.');
 writeChanged(ffmpeg,content.slice(0,start)+'set(FFMPEG_GIT_SHA "'+inputs.artifacts[0].revision.slice(0,12)+'")'+content.slice(end));
}
function syncProjection(from,to){
 fs.mkdirSync(to,{recursive:true});
 const entries=fs.readdirSync(from,{withFileTypes:true}),names=new Set(entries.map(entry=>entry.name));
 for(const name of fs.readdirSync(to))if(!names.has(name))fs.rmSync(path.join(to,name),{recursive:true,force:true});
 for(const entry of entries){
  const input=path.join(from,entry.name),output=path.join(to,entry.name);
  if(entry.isDirectory())syncProjection(input,output);
  else if(entry.isSymbolicLink()){
   const link=fs.readlinkSync(input);let previous;
   try{previous=fs.lstatSync(output);}catch(error){if(error.code!=='ENOENT')throw error;}
   if(previous){if(previous.isSymbolicLink()&&fs.readlinkSync(output)===link)continue;if(previous.isDirectory())throw Error('Source projection type changed: '+entry.name);fs.unlinkSync(output);}
   fs.symlinkSync(link,output);
  }else if(entry.isFile())writeChanged(output,fs.readFileSync(input),fs.statSync(input).mode&0o777);
  else throw Error('Unsupported source projection input.');
 }
}

function applyExportedSourceMetadata(destination,repositories){
 const revision=entry=>{
  if(!/^[0-9a-f]{40}$/i.test(entry.revision))throw Error('Invalid exported source revision.');
  return entry.revision.toLowerCase();
 };
 const file='AnyPS5ExportedSources.cmake';
 let metadata='# Exported source revisions.\nset(ANYPS5_EXPORTED_REVISION "'+revision(repositories[0])+'")\nset(ANYPS5_EXPORTED_DIRTY 1)\n';
 for(const entry of repositories.slice(1)){
  if(!entry.path||entry.path.includes('\\')||path.posix.normalize(entry.path)!==entry.path||entry.path.startsWith('../')||path.posix.isAbsolute(entry.path))throw Error('Invalid exported dependency path.');
  const key=createHash('sha256').update(entry.path).digest('hex');
  metadata+='set(ANYPS5_EXPORTED_PIN_'+key+' "'+revision(entry)+'")\n';
 }
 writeChanged(path.join(destination,file),metadata);
 const adapt=(relative,before,after)=>{
  const target=path.join(destination,relative),source=fs.readFileSync(target,'utf8');
  if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('AnyPS5 exported source metadata boundary changed: '+relative);
  writeChanged(target,source.replace(before,after));
 };
 // These tracked build-script adaptations make the export an adapted source.
 adapt('core/libs/prx/libSceAgcDriver/trace_revision.cmake','if(GIT)',
  'if(EXISTS "${SOURCE}/'+file+'")\n    include("${SOURCE}/'+file+'")\n    string(SUBSTRING "${ANYPS5_EXPORTED_REVISION}" 0 12 commit)\n    set(dirty "${ANYPS5_EXPORTED_DIRTY}")\nelseif(GIT)');
 adapt('core/shader/recompiler/ShaderCacheVersion.cmake','cmake_minimum_required(VERSION 3.20)',
  'cmake_minimum_required(VERSION 3.20)\nif(EXISTS "${ROOT}/'+file+'")\n    include("${ROOT}/'+file+'")\nendif()');
 adapt('core/shader/recompiler/ShaderCacheVersion.cmake','    set(commit)\n    if(GIT)',
  '    set(commit)\n    string(SHA256 exportedPin "${relative}")\n    if(DEFINED ANYPS5_EXPORTED_PIN_${exportedPin})\n        set(commit "${ANYPS5_EXPORTED_PIN_${exportedPin}}")\n    elseif(GIT)');
 adapt('core/shader/recompiler/CMakeLists.txt','    set(shaderCacheSubmoduleStamps)',
  '    set(shaderCacheSubmoduleStamps "${PROJECT_SOURCE_DIR}/'+file+'")');
}

export const RELINKER_OVERLAYS=[['macos-loader','applyLoaderOverlay']];
export const RUNTIME_OVERLAYS=[
 ["macos-startup","applyStartupOverlay"],
 ["vulkan","applyVulkanOverlay"],
 ["macos-build","applyBuildOverlay"],
 ["macos-kernel","applyKernelOverlay"],
 ["macos-loader","applyLoaderOverlay"],
 ["macos-buffer","applyBufferOverlay"],
 ["macos-nid","applyNidOverlay"],
 ["macos-sdl","applySdlOverlay"],
 ["macos-images","applyImagesOverlay"],
 ["macos-window","applyWindowOverlay"],
 ["macos-host-graphics","applyHostGraphicsOverlay"],
 ["macos-host-libraries","applyHostLibrariesOverlay"],
 ["macos-host-kernel","applyHostKernelOverlay"],
 ["generated-shaders","applyGeneratedShadersOverlay"],
 ["pipeline-state","applyPipelineStateOverlay"],
 ["resource-preparation","applyResourcePreparationOverlay"],
 ["validation-cache","applyValidationCacheOverlay"],
 ["mouse-routing","applyMouseRoutingOverlay"],
];

export async function prepareSourceProjection({source,repositories},projection,{overlays=RUNTIME_OVERLAYS}={}){
 fs.mkdirSync(path.dirname(projection),{recursive:true});
 const staged=fs.mkdtempSync(path.join(path.dirname(projection),'.source-'));
 try{
  exportSources(source,repositories,staged);
  for(const [directory,method]of overlays){
   const file=path.join(import.meta.dirname,'overlays',directory,'apply.mjs');
   await(await import(pathToFileURL(file).href))[method](staged);
  }
  applyExportedSourceMetadata(staged,repositories);
  syncProjection(staged,projection);
 }finally{fs.rmSync(staged,{recursive:true,force:true});}
 return projection;
}
