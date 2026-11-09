import {APP_REFERENCE,appRequire} from '../../../tools/app-source.mjs';
import {gitlink,sourceRevision} from '../../../lib/pins.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {pack,catalog} from '../../../tools/runtime-package.mjs';
const require=createRequire(import.meta.url),B=appRequire('src/modules/shared/runtime/bundled-native.js'),Native=appRequire('src/modules/shared/runtime/local-native.js');
const recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json')));
recipe.source.revision=gitlink(recipe.source.path);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
function filesIn(root,prefix=''){
 return fs.readdirSync(path.join(root,prefix),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  const relative=path.posix.join(prefix,entry.name);if(entry.isDirectory())return filesIn(root,relative);
  if(!entry.isFile())throw Error('Media packages require regular input files.');return [relative];
 });
}
function record(root,relative){const file=path.join(root,relative),content=B.readRegular(file,B.LIMITS.fileBytes),{bytes,...value}=content;
 const magic=bytes.length>=4?bytes.readUInt32BE(0):0;const image=[0xfeedface,0xcefaedfe,0xfeedfacf,0xcffaedfe,0xcafebabe,0xbebafeca,0xcafebabf,0xbfbafeca].includes(magic)?Native.readMachOArchitectures(file,{allowLibrary:true}):[];return {path:relative,...value,...(image.length?{architectures:image}:{})};}
export function checkSources(){
 for(const input of recipe.ownedInputs)B.relativeFile(input.path.startsWith(APP_REFERENCE)?input.path.slice(APP_REFERENCE.length):input.path);
 return {id:recipe.id,revision:sourceRevision(recipe.source),inputs:recipe.ownedInputs.length};
}
export async function packageRuntime({input,output,version=recipe.version,catalogFile}){
 checkSources();input=fs.realpathSync(input);output=path.resolve(output);
 if(version!==recipe.version||fs.existsSync(output)||output===input||output.startsWith(input+path.sep))throw Error('Choose a new media package output and the recipe version.');
 const bytes=B.readRegular(path.join(input,'video-runtime.json'),B.LIMITS.manifestBytes).bytes,video=JSON.parse(bytes);
 const imageNames=new Set();for(const image of video.images){B.relativeFile(image.path);if(imageNames.has(image.path)||hash(fs.readFileSync(path.join(input,image.path)))!==image.sha256)throw Error('A sealed media image changed.');imageNames.add(image.path);}
 for(const owned of video.ownedHeaders||[])B.relativeFile(owned.file);
 const allowed=new Set(['video-runtime.json',...imageNames,'mpv.app/Contents/Info.plist','mpv.app/Contents/_CodeSignature/CodeResources']);
 for(const name of filesIn(input))allowed.add(name);
 fs.mkdirSync(output,{recursive:true});const payload=path.join(output,'payload'),content=path.join(payload,'files');fs.mkdirSync(content,{recursive:true});
 try{
  for(const name of filesIn(input)){const target=path.join(content,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(input,name),target,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.chmodSync(target,fs.statSync(path.join(input,name)).mode&0o777);}
  const producerInputs=['source.json','package.mjs','build.mjs'].map(name=>({path:'producers/mpv-render/v7/'+name,sha256:hash(fs.readFileSync(path.join(import.meta.dirname,name)))}));
  const source={schemaVersion:1,id:recipe.id,version,source:recipe.source,artifact:recipe.artifact,backports:recipe.backports,ownedInputs:recipe.ownedInputs,producerInputs};
  fs.writeFileSync(path.join(content,'source.json'),json(source));
  const files=filesIn(content).map(name=>record(content,name));
  const dependencies=[];
  for(const file of files.filter(file=>file.architectures)){
   const lines=execFileSync('/usr/bin/otool',['-L',path.join(content,file.path)],{encoding:'utf8'}).split('\n').slice(1);
   const links=lines.map(line=>line.trim().split(' (')[0]).filter(Boolean).filter(link=>link!=='@rpath/'+path.basename(file.path));
   dependencies.push({file:file.path,links});
  }
  const manifest=B.validateManifest({schemaVersion:1,managerId:'mpv',version,platform:'darwin',arch:'arm64',minimumMacOS:recipe.minimumMacOS,upstreamRevision:sourceRevision(recipe.source),
   executableRelative:'mpv.app/Contents/MacOS/mpv',runtimeFiles:{decodedFrameManifest:'video-runtime.json'},
   provenance:{sourceRevision:sourceRevision(recipe.source),sourceKind:'official-release',verifiedBuild:false},files,dependencies});
  fs.writeFileSync(path.join(payload,'manifest.json'),json(manifest));
  const manifestFile=record(payload,'manifest.json'),sourceFile=files.find(file=>file.path==='source.json');
  const declaration={id:'mpv',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:recipe.minimumMacOS,directoryRelative:'mpv/'+version+'/arm64',sourceRelative:null,sourceSha256:sourceFile.sha256,manifestRelative:'manifest.json',manifestSha256:manifestFile.sha256,
   files:[...files.map(file=>({...file,path:'files/'+file.path})),manifestFile],redistribution:'bundle'};
  const archive=path.join(output,'mpv-'+version+'-arm64.tar.gz'),release=await pack({project:'mpv',input:payload,declaration,output:archive});
  fs.writeFileSync(path.join(output,'declaration.json'),json(declaration));
  if(catalogFile){if(fs.existsSync(catalogFile))throw Error('The catalog output already exists.');fs.writeFileSync(catalogFile,json(catalog([release],{project:'mpv',repository:'procrastinine/maclauncher-builds'})));}
  return {archive,record:release,images:video.images.length,payload};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]?.slice(2),value=process.argv[i+1];if(!['input','output','version','catalog'].includes(key)||!value||Object.hasOwn(options,key))throw Error('Use --input, --output and optional --version, --catalog.');options[key==='catalog'?'catalogFile':key]=value;}
 packageRuntime(options).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
