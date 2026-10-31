import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {checkoutSource,sourceNotices,run,recipeMain} from './build-source.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {collectSdlNotices} from './sdl-notices.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Builder=require('../producers/maclauncher/src/modules/fna/runtime/build.js');
export const RUNTIMES=Object.freeze({
 arm64:{url:'https://builds.dotnet.microsoft.com/dotnet/Runtime/8.0.32/dotnet-runtime-8.0.32-osx-arm64.tar.gz',sha256:'0e36796c3415bd95c25184fe81386bfc5a5a0b1668ce2f7d8127e03009dec73c',bytes:29113232},
 x64:{url:'https://builds.dotnet.microsoft.com/dotnet/Runtime/8.0.32/dotnet-runtime-8.0.32-osx-x64.tar.gz',sha256:'bb31ec5f4e6f6b85225672f061fd5ffbc463691a03c1338319e4c57403d30aab',bytes:30745959}
});
const STB_NOTICES=Object.freeze([
 ['FNA3D-stb-image.txt','FNA3D','src/stb_image.h'],['FNA3D-stb-image-write.txt','FNA3D','src/stb_image_write.h'],
 ['FAudio-stb-vorbis.txt','FAudio','src/stb_vorbis.h'],['FAudio-stb.txt','FAudio','src/stb.h']
]);
/** Select complete original license terms from the compiled headers. */
export function selectStbNotices(runtime,{output}){
 if(!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select a new absolute notice output directory.');
 const selections=[];fs.mkdirSync(output,{recursive:true});
 for(const [filename,project,sourceRelative]of STB_NOTICES){
  const input=path.join(runtime,'licenses',filename),bytes=fs.readFileSync(input),text=bytes.toString('utf8');
  const blocks=[...text.matchAll(/\/\*\r?\n-+\r?\nThis software is available under 2 licenses -- choose whichever you prefer\.[\s\S]*?\r?\n\*\//g)];
  if(blocks.length!==1||text.slice(blocks[0].index+blocks[0][0].length).trim()||!blocks[0][0].includes('Copyright (c) 2017 Sean Barrett')||!blocks[0][0].includes('ALTERNATIVE A - MIT License')||!blocks[0][0].includes('ALTERNATIVE B - Public Domain'))throw Error('The original stb license block changed: '+filename);
  const notice=Buffer.from(blocks[0][0]+'\n'),file=path.join(output,filename);fs.writeFileSync(file,notice,{flag:'wx',mode:0o644});fs.rmSync(input);
  selections.push({filename,project,sourceRelative,file,sourceHeaderSha256:crypto.createHash('sha256').update(bytes).digest('hex'),noticeSha256:crypto.createHash('sha256').update(notice).digest('hex')});
 }
 return selections;
}
export async function fnaSdlNotices(work){
 const archive=await buildInput(Builder.PACKAGES.sdl),source=path.join(work,'sdl-notice-source');fs.mkdirSync(source);
 run('/usr/bin/tar',['-xf',archive,'--strip-components','1','-C',source]);
 return collectSdlNotices({source,output:path.join(work,'sdl-notices'),name:'SDL3 3.4.18',sourceUrl:Builder.PACKAGES.sdl.url,includeLibm:true});
}
export async function buildFNA({project,arch,output,work}){
 fs.mkdirSync(work,{recursive:true});const repository='https://github.com/FNA-XNA/FNA',source=checkoutSource({repository,revision:Builder.FNA_REVISION,destination:path.join(work,'upstream-fna')});
 run('git',['-C',source,'submodule','update','--init','--recursive','--depth','1']);
 const fna3d=checkoutSource({repository:'https://github.com/FNA-XNA/FNA3D',revision:Builder.FNA3D_REVISION,destination:path.join(work,'upstream-fna3d')});run('git',['-C',fna3d,'submodule','update','--init','--recursive','--depth','1']);
 const runtime=path.join(work,'runtime');fs.mkdirSync(runtime);const archive=await buildInput(RUNTIMES[arch]);run('/usr/bin/tar',['-xzf',archive,'-C',runtime]);
 const downloads=new Map(Object.values(Builder.PACKAGES).map(pin=>[pin.url,pin]));
 await Builder.prepareRuntime({unpacked:runtime,pin:{version:Builder.PROFILE},sourcePath:source,fna3dSourcePath:fna3d,dependencies:{downloadToFile:async(url,destination)=>{const pin=downloads.get(url);if(!pin)throw Error('Undeclared FNA build download.');fs.copyFileSync(await buildInput(pin),destination);}}});
 const selectedLicenses=selectStbNotices(runtime,{output:path.join(work,'stb-notices')}),sdl=await fnaSdlNotices(work);
 const dependencies=[source,fna3d].flatMap(directory=>execFileSync('git',['-C',directory,'submodule','status','--recursive'],{encoding:'utf8'}).split('\n').filter(Boolean).map(line=>{const match=/^ ([a-f0-9]{40}) (\S+)/.exec(line);if(!match)throw Error('FNA source dependency is not at its declared pin.');return {path:(directory===source?'FNA/':'FNA3D/')+match[2],revision:match[1],repository:execFileSync('git',['-C',path.join(directory,match[2]),'remote','get-url','origin'],{encoding:'utf8'}).trim()};}));
 const payloads=fs.readdirSync(runtime).filter(name=>name!=='dotnet').map(name=>({source:path.join(runtime,name),relative:'fna/'+name}));
 return sealRuntime({project,arch,output,executable:path.join(runtime,'dotnet'),executableRelative:'fna/dotnet',sourceRoot:source,upstreamRevision:Builder.FNA_REVISION,payloads,maximumMacOS:'13.0',provenance:{dependencies,dotnetRuntime:RUNTIMES[arch],licenseSelections:selectedLicenses.map(({file,...row})=>row),sdlNoticeSources:sdl.provenance},runtimeFiles:{profile:'fna/fna-runtime.json'},notices:[...sdl.notices,...selectedLicenses.map(row=>({file:row.file,name:row.project+' '+row.sourceRelative,license:'MIT OR Unlicense',sourceUrl:'https://github.com/FNA-XNA/'+row.project+'/blob/'+(row.project==='FNA3D'?Builder.FNA3D_REVISION:dependencies.find(item=>item.path==='FNA/lib/FAudio').revision)+'/'+row.sourceRelative})),...sourceNotices(source,{name:'FNA',repository}),...sourceNotices(fna3d,{name:'FNA3D',repository:'https://github.com/FNA-XNA/FNA3D'}),...sourceNotices(path.join(runtime,'licenses'),{name:'FNA native dependencies',repository}),{file:path.join(runtime,'LICENSE.txt'),name:'.NET runtime',license:'MIT',sourceUrl:'https://github.com/dotnet/runtime'},{file:path.join(runtime,'ThirdPartyNotices.txt'),name:'.NET runtime third-party notices',license:'See original notices',sourceUrl:'https://github.com/dotnet/runtime'}]});
}
recipeMain(import.meta,buildFNA);
