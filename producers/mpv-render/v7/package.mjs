import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {pack,catalog} from '../../../tools/runtime-package.mjs';
const require=createRequire(import.meta.url),B=require('../../../lib/bundled-native.cjs'),Native=require('../../../lib/local-native.cjs');
const recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json'))),root=path.resolve(import.meta.dirname,'../../..');
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
 for(const input of recipe.ownedInputs){B.relativeFile(input.path);if(hash(fs.readFileSync(path.join(root,input.path)))!==input.sha256)throw Error('The media producer source differs from its recipe: '+input.path);}
 return {id:recipe.id,revision:recipe.source.revision,inputs:recipe.ownedInputs.length};
}
export async function packageRuntime({input,output,version=recipe.version,catalogFile}){
 checkSources();input=fs.realpathSync(input);output=path.resolve(output);
 if(version!==recipe.version||fs.existsSync(output)||output===input||output.startsWith(input+path.sep))throw Error('Choose a new media package output and the recipe version.');
 const bytes=B.readRegular(path.join(input,'video-runtime.json'),B.LIMITS.manifestBytes).bytes,video=JSON.parse(bytes);
 if(video.schema!==1||video.id!=='mpv-render'||video.decodedFrameAPI!==1||video.architecture!==recipe.architecture||video.minimumMacOS!==recipe.minimumMacOS||
  video.librarySource?.commit!==recipe.source.revision||video.librarySource?.inputSha256!==recipe.libraryInputSha256||JSON.stringify(video.librarySource?.artifact)!==JSON.stringify(recipe.artifact)||
  JSON.stringify(video.librarySource?.backports)!==JSON.stringify(recipe.backports)||video.headerSource?.commit!==recipe.source.revision||!Array.isArray(video.images)||!video.images.length||!Array.isArray(video.notices)||!video.notices.length)throw Error('The media input differs from its selected library and render contract.');
 const imageNames=new Set();for(const image of video.images){B.relativeFile(image.path);if(imageNames.has(image.path)||hash(fs.readFileSync(path.join(input,image.path)))!==image.sha256)throw Error('A sealed media image changed.');imageNames.add(image.path);}
 for(const owned of video.ownedSources||[]){const pin=recipe.ownedInputs.find(row=>row.path==='producers/mpv-render/v7/maclauncher/src/modules/video/native/'+owned.file);if(!pin||pin.sha256!==owned.sha256)throw Error('The render host differs from its declared source.');}
 if(video.ownedSources?.length!==4)throw Error('The media host source inventory is incomplete.');
 if(video.osdLayerAPI!==recipe.osdLayerAPI||video.playerScriptsAPI!==recipe.playerScriptsAPI||video.playerInputAPI!==recipe.playerInputAPI||video.preparationNotificationAPI!==recipe.preparationNotificationAPI||video.decodedColorAPI!==recipe.decodedColorAPI||JSON.stringify(video.intermediateColor)!==JSON.stringify(recipe.intermediateColor)||JSON.stringify(video.outputColor)!==JSON.stringify(recipe.outputColor))throw Error('The media input differs from its decoded color contract.');
 const headers=new Set();for(const owned of video.ownedHeaders||[]){B.relativeFile(owned.file);const pin=recipe.ownedInputs.find(row=>row.path==='producers/mpv-render/v7/maclauncher/'+owned.file);if(headers.has(owned.file)||!pin||pin.sha256!==owned.sha256)throw Error('The media host header differs from its declared source.');headers.add(owned.file);}
 if(headers.size!==7)throw Error('The media host header inventory is incomplete.');
 const allowed=new Set(['video-runtime.json',...imageNames,'mpv.app/Contents/Info.plist','mpv.app/Contents/_CodeSignature/CodeResources']);
 for(const notice of video.notices){B.relativeFile(notice.path);allowed.add(notice.path);if(notice.sha256&&hash(fs.readFileSync(path.join(input,notice.path)))!==notice.sha256)throw Error('A media notice changed.');}
 // Original dependency receipts are consumed source metadata alongside notices.
 for(const name of filesIn(input))if(!allowed.has(name)&&!/^licenses\/dependencies\/[^/]+\/INSTALL_RECEIPT\.json$/.test(name))throw Error('Unexpected media input: '+name);
 fs.mkdirSync(output,{recursive:true});const payload=path.join(output,'payload'),content=path.join(payload,'files');fs.mkdirSync(content,{recursive:true});
 try{
  for(const name of filesIn(input)){const target=path.join(content,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(input,name),target,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.chmodSync(target,fs.statSync(path.join(input,name)).mode&0o777);}
  const producerInputs=['source.json','package.mjs','build.mjs'].map(name=>({path:'producers/mpv-render/v7/'+name,sha256:hash(fs.readFileSync(path.join(import.meta.dirname,name)))}));
  const source={schemaVersion:1,id:recipe.id,version,source:recipe.source,artifact:recipe.artifact,backports:recipe.backports,libraryInputSha256:recipe.libraryInputSha256,ownedInputs:recipe.ownedInputs,libraryBuild:recipe.libraryBuild,producerInputs};
  fs.writeFileSync(path.join(content,'source.json'),json(source));
  const files=filesIn(content).map(name=>record(content,name)),notices=video.notices.map(({name,license,path:noticePath,sourceUrl})=>({name,license,path:noticePath,sourceUrl:sourceUrl||recipe.source.repository}));
  const dependencies=[];
  for(const file of files.filter(file=>file.architectures)){
   if(JSON.stringify(file.architectures)!==JSON.stringify(['arm64']))throw Error('The media closure requires native ARM64 images.');
   const lines=execFileSync('/usr/bin/otool',['-L',path.join(content,file.path)],{encoding:'utf8'}).split('\n').slice(1);
   const links=lines.map(line=>line.trim().split(' (')[0]).filter(Boolean).filter(link=>link!=='@rpath/'+path.basename(file.path));
   if(links.some(link=>!link.startsWith('/usr/lib/')&&!link.startsWith('/System/Library/')&&!link.startsWith('@loader_path/')))throw Error('The media closure contains an external dependency.');
   dependencies.push({file:file.path,links});
   execFileSync('/usr/bin/codesign',['--verify','--strict',path.join(content,file.path)],{stdio:'pipe'});
  }
  const manifest=B.validateManifest({schemaVersion:1,managerId:'mpv',version,platform:'darwin',arch:'arm64',minimumMacOS:recipe.minimumMacOS,upstreamRevision:recipe.source.revision,
   executableRelative:'mpv.app/Contents/MacOS/mpv',runtimeFiles:{decodedFrameManifest:'video-runtime.json'},
   provenance:{sourceRevision:recipe.source.revision,sourceKind:'official-release',verifiedBuild:false},files,notices,dependencies});
  fs.writeFileSync(path.join(payload,'manifest.json'),json(manifest));
  const manifestFile=record(payload,'manifest.json'),sourceFile=files.find(file=>file.path==='source.json');
  const declaration={id:'mpv',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:recipe.minimumMacOS,directoryRelative:'mpv/'+version+'/arm64',sourceRelative:null,sourceSha256:sourceFile.sha256,manifestRelative:'manifest.json',manifestSha256:manifestFile.sha256,
   files:[...files.map(file=>({...file,path:'files/'+file.path})),manifestFile],notices:notices.map(notice=>({...notice,path:'files/'+notice.path})),redistribution:'bundle'};
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
