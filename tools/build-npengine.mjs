import './producer-environment.mjs';
import {addLicenses,includeLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildInput} from './build-input.mjs';
import {checkoutSource,run,recipeMain} from "./build-source.mjs";
import {sealRuntime} from './seal-runtime.mjs';

import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {nativeStackInput} from './native-stack.mjs';
const require=createRequire(import.meta.url);
const Builder=require('../producers/package-support/src/modules/nitroplus/runtime/portable-build.js'),Media=require('../producers/package-support/src/modules/nitroplus/runtime/portable-media.js'),Fonts=require('../producers/package-support/src/modules/shared/runtime/portable-sdl2-fonts.js');
/** Decode the declared PBZX package payload into its cpio archive. */
function decodePayload(input,output){
 const source=fs.openSync(input,'r'),target=fs.openSync(output,'wx'),header=Buffer.alloc(12);let offset=12;
 try{if(fs.readSync(source,header,0,12,0)!==12||header.toString('ascii',0,4)!=='pbzx')throw Error('Expected an official PBZX package payload.');
  const total=fs.statSync(input).size;
  while(offset<total){const entry=Buffer.alloc(16);if(fs.readSync(source,entry,0,16,offset)!==16)throw Error('Truncated package payload.');offset+=16;
   const plain=Number(entry.readBigUInt64BE(0)),size=Number(entry.readBigUInt64BE(8));if(!Number.isSafeInteger(size)||size<=0||offset+size>total)throw Error('Invalid package payload block.');
   const compressed=Buffer.alloc(size);if(fs.readSync(source,compressed,0,size,offset)!==size)throw Error('Truncated package payload block.');offset+=size;
   const bytes=plain===size?compressed:execFileSync('xz',['--decompress','--stdout'],{input:compressed,maxBuffer:Infinity});if(bytes.length!==plain)throw Error('Package payload expanded size differs.');fs.writeSync(target,bytes);
  }
 }finally{fs.closeSync(source);fs.closeSync(target);}
}
export async function projectMedia(work){
 const prefix=path.join(work,'media');fs.mkdirSync(prefix,{recursive:true});
 for(const [index,pin]of Media.PIN.officialPayloads.entries()){
  const archive=await buildInput({...pin,headers:{Range:'bytes='+pin.offset+'-'+(pin.offset+pin.bytes-1)}}),cpio=path.join(work,'payload-'+index+'.cpio');decodePayload(archive,cpio);
  run('/usr/bin/tar',['-xf',cpio,'-C',prefix]);fs.rmSync(cpio);
 }
 const media=Media.validateSDKPrefix(prefix);return {media};
}

/** Compile libnpengine with its media, font and utility stacks. */
export async function compile({arch,work}){
 fs.mkdirSync(work,{recursive:true});const repository='https://github.com/FGRE/libnpengine',source=checkoutSource({repository,revision:Builder.REVISION,destination:path.join(work,'upstream-engine')}),npaRepository='https://github.com/FGRE/libnpa',npa=checkoutSource({repository:npaRepository,revision:Builder.NPA_REVISION,destination:path.join(work,'upstream-npa')});
 const {media}=await projectMedia(work);
 const archives={};for(const pin of [...Fonts.PIN.dependencies,...Media.PIN.utilitySources])archives[pin.id]??=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes});
 const sdl=nativeStackInput(preparedBuildInput('native-sdl2-fonts'),{arch,work:path.join(work,'sdl')}),utilities=await Media.buildUtilities({archives,workRoot:path.join(work,'utilities')});
 const built=await Builder.buildPortableNPengine({sourceDir:source,npaSourceDir:npa,workRoot:path.join(work,'engine'),mediaStack:media,utilityStack:utilities,sdlStack:sdl});
 return {source,npa,built};
}
/** Describe and seal the compiled engine with its profile, media and notices. */
export async function assemble({project,arch,output,compiled:{source,npa,built}}){
 Builder.describeRuntime(built);
 addLicenses(built.prefix,'libnpa',npa);
 addLicenses(built.prefix,'GStreamer media',path.join(import.meta.dirname,'../producers/package-support/src/modules/nitroplus/runtime'));
 includeLicenses(built.prefix,`${built.dependencyClosure?.utilities?.prefix}/licenses`);
 const payloads=fs.readdirSync(built.prefix).filter(name=>name!=='bin').map(name=>({source:path.join(built.prefix,name),relative:'npengine/'+name}));
 return sealRuntime({project,arch,output,executable:built.executable,executableRelative:'npengine/bin/npengine-runner',sourceRoot:source,upstreamRevision:Builder.REVISION,payloads,runtimeFiles:{profile:'npengine/profile.json'},provenance:{mediaInputs:Media.PIN.officialPayloads.map(({url,member,sha256})=>({url,member,sha256})),dependencySources:Media.PIN.correspondingSources.map(({id,version,archiveUrl,archiveSha256})=>({id,version,archiveUrl,archiveSha256}))}});
}
recipeMain(import.meta,{compile,assemble});
