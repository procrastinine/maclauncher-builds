import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {buildInput} from './build-input.mjs';
import {buildOptions,checkoutSource,sourceNotices,run} from './build-source.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {collectSdlNotices} from './sdl-notices.mjs';
const require=createRequire(import.meta.url);
const Builder=require('../producers/maclauncher/src/modules/nitroplus/runtime/portable-build.js'),Media=require('../producers/maclauncher/src/modules/nitroplus/runtime/portable-media.js'),Fonts=require('../producers/maclauncher/src/modules/shared/runtime/portable-sdl2-fonts.js');
const dependencies={findBuildTool:name=>execFileSync('/usr/bin/which',[name],{encoding:'utf8'}).trim()};
const MEDIA_NOTICE_INPUTS=Object.freeze({fontconfig:{version:'2.16.1',filename:'COPYING',url:'https://raw.githubusercontent.com/fontconfig/fontconfig/fdfc3445d1cc9c1c7e587fb2a1287871de16faf9/COPYING',sha256:'51a51aa9823704fd90bccc616cdd17ebabb5b2b3e9cbde886ca02c7002288067',bytes:8616},libpng:{version:'1.6.56',filename:'LICENSE',url:'https://raw.githubusercontent.com/pnggroup/libpng/d5515b5b8be3901aac04e5bd8bd5c89f287bcd33/LICENSE',sha256:'bdb0a645ea18c60507d0368379b1ac5474b92255fcc2d115e07486a7672ba526',bytes:5345}});
const capture=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',maxBuffer:64<<20,...options});
/** Decode the declared PBZX package payload into its cpio archive. */
function decodePayload(input,output){
 const source=fs.openSync(input,'r'),target=fs.openSync(output,'wx'),header=Buffer.alloc(12);let offset=12;
 try{if(fs.readSync(source,header,0,12,0)!==12||header.toString('ascii',0,4)!=='pbzx')throw Error('Expected an official PBZX package payload.');
  const total=fs.statSync(input).size;
  while(offset<total){const entry=Buffer.alloc(16);if(fs.readSync(source,entry,0,16,offset)!==16)throw Error('Truncated package payload.');offset+=16;
   const plain=Number(entry.readBigUInt64BE(0)),size=Number(entry.readBigUInt64BE(8));if(!Number.isSafeInteger(size)||size<=0||size>(32<<20)||plain>(32<<20)||offset+size>total)throw Error('Invalid package payload block.');
   const compressed=Buffer.alloc(size);if(fs.readSync(source,compressed,0,size,offset)!==size)throw Error('Truncated package payload block.');offset+=size;
   const bytes=plain===size?compressed:execFileSync('xz',['--decompress','--stdout'],{input:compressed,maxBuffer:32<<20});if(bytes.length!==plain)throw Error('Package payload expanded size differs.');fs.writeSync(target,bytes);
  }
 }finally{fs.closeSync(source);fs.closeSync(target);}
}
export async function projectMedia(work){
 const prefix=path.join(work,'media');fs.mkdirSync(prefix,{recursive:true});const required=new Set(Media.PIN.requiredFiles.map(row=>row.file));
 for(const [index,pin]of Media.PIN.officialPayloads.entries()){
  const archive=await buildInput({...pin,headers:{Range:'bytes='+pin.offset+'-'+(pin.offset+pin.bytes-1)}}),cpio=path.join(work,'payload-'+index+'.cpio');decodePayload(archive,cpio);
  const listing=capture('/usr/bin/tar',['-tf',cpio]).trim().split('\n'),selected=listing.filter(file=>required.has(file.replace(/^\.\//,'')));
  if(selected.length)run('/usr/bin/tar',['-xf',cpio,'-C',prefix,...selected]);fs.rmSync(cpio);
 }
 for(const alias of Media.PIN.aliases){const file=path.join(prefix,alias.file);fs.mkdirSync(path.dirname(file),{recursive:true});fs.symlinkSync(alias.target,file);}
 const media=Media.validateSDKPrefix(prefix);return {media,notices:await mediaNotices(work)};
}
export async function mediaNotices(work){
 const notices=[];for(const pin of Media.PIN.correspondingSources){if(MEDIA_NOTICE_INPUTS[pin.id]){const selected=MEDIA_NOTICE_INPUTS[pin.id];if(selected.version!==pin.version)throw Error('Media source notice version differs.');const directory=path.join(work,'media-notices',pin.id),file=path.join(directory,selected.filename);fs.mkdirSync(directory,{recursive:true});fs.copyFileSync(await buildInput(selected),file);notices.push({file,name:pin.id+' '+pin.version,license:'See original notice',sourceUrl:selected.url});continue;}const archive=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes}),directory=path.join(work,'media-notices',pin.id);fs.mkdirSync(directory,{recursive:true});
  const listing=capture('/usr/bin/tar',['-tf',archive]).trim().split('\n'),selected=listing.filter(file=>/^(?:LICEN[CS]E|COPYING|NOTICE|COPYRIGHT)(?:[._-]|$)/i.test(path.basename(file))&&!file.endsWith('/'));
  if(!selected.length)throw Error('Missing GStreamer dependency notice for '+pin.id);run('/usr/bin/tar',['-xf',archive,'-C',directory,...selected]);notices.push(...sourceNotices(directory,{name:pin.id+' '+pin.version,repository:pin.archiveUrl}));
 }
 return notices;
}
export async function buildNPengine({project,arch,output,work}){
 if(project!=='npengine'||arch!=='arm64'||process.arch!=='arm64'||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select the npengine ARM profile and new absolute work/output directories.');
 fs.mkdirSync(work,{recursive:true});const repository='https://github.com/FGRE/libnpengine',source=checkoutSource({repository,revision:Builder.REVISION,destination:path.join(work,'upstream-engine')}),npaRepository='https://github.com/FGRE/libnpa',npa=checkoutSource({repository:npaRepository,revision:Builder.NPA_REVISION,destination:path.join(work,'upstream-npa')});
 const {media,notices}=await projectMedia(work);return finishNPengine({project,arch,output,work,source,npa,repository,npaRepository,media,notices});
}
export async function finishNPengine({project,arch,output,work,source,npa,repository,npaRepository,media,notices}){
 const archives={};for(const pin of [...Fonts.PIN.dependencies,...Media.PIN.utilitySources])archives[pin.id]??=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes});
 const sdl=await Fonts.buildDependencies({archives,workRoot:path.join(work,'sdl'),architecture:arch,pathMappings:[...new Set([work,fs.realpathSync(work)])].map(from=>({from,to:'NPENGINE_BUILD'})),dependencies}),utilities=await Media.buildUtilities({archives,workRoot:path.join(work,'utilities'),dependencies});
 const built=await Builder.buildPortableNPengine({sourceDir:source,npaSourceDir:npa,workRoot:path.join(work,'engine'),mediaStack:media,utilityStack:utilities,sdlStack:sdl,dependencies});
 for(const stack of [sdl,utilities])for(const pin of stack.sources)for(const name of pin.notices||[pin.notice])notices.push({file:path.join(stack===utilities?path.join(work,'utilities','source-'+pin.id):pin.sourceRoot||stack.sourceRoots[pin.id],name),name:pin.name||pin.id,license:pin.license,sourceUrl:pin.archiveUrl});
 const pin=Fonts.PIN.dependencies.find(row=>row.id==='sdl2'),sdlNotices=collectSdlNotices({source:sdl.sourceRoots.sdl2,output:path.join(work,'sdl-notices'),name:'SDL2 '+pin.version,sourceUrl:pin.archiveUrl,includeLibm:false});notices.push(...sdlNotices.notices);
 return sealNPengine({project,arch,output,work,source,npa,repository,npaRepository,media,notices,built,sdlNoticeProvenance:sdlNotices.provenance});
}
export async function sealNPengine({project,arch,output,work,source,npa,repository,npaRepository,media,notices,built,sdlNoticeProvenance}){
 const payloads=fs.readdirSync(built.prefix).filter(name=>name!=='bin').map(name=>({source:path.join(built.prefix,name),relative:'npengine/'+name}));
 return sealRuntime({project,arch,output,executable:built.executable,executableRelative:'npengine/bin/npengine-runner',sourceRoot:source,upstreamRevision:Builder.REVISION,payloads,notices:[...sourceNotices(source,{name:'libnpengine',repository}),...sourceNotices(npa,{name:'libnpa',repository:npaRepository}),...notices],runtimeFiles:{profile:'npengine/profile.json'},provenance:{sdlNoticeSources:sdlNoticeProvenance,mediaNoticeInputs:MEDIA_NOTICE_INPUTS,mediaInputs:Media.PIN.officialPayloads.map(({url,member,sha256})=>({url,member,sha256})),dependencySources:Media.PIN.correspondingSources.map(({id,version,archiveUrl,archiveSha256})=>({id,version,archiveUrl,archiveSha256}))}});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)buildNPengine(buildOptions(process.argv.slice(2))).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
