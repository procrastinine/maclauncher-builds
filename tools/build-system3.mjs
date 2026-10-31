import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {recipeMain} from './build-source.mjs';
import {buildInput} from './build-input.mjs';import {sealRuntime} from './seal-runtime.mjs';import {collectSdlNotices} from './sdl-notices.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Builder=require('../producers/maclauncher/src/modules/alicesoft/system3-portable.js'),Fonts=require('../producers/maclauncher/src/modules/shared/runtime/portable-sdl2-fonts.js');
export async function buildSystem3({project,arch,version,output,work,sourceDir,sdkPath}){
 sourceDir??=path.join(root,'producers/maclauncher/src/external/system3-sdl2');
 const archives={};for(const pin of Fonts.PIN.dependencies)archives[pin.id]=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes});
 const result=await Builder.buildPortableSystem3({sourceDir,archives,workRoot:work,architecture:arch,pathMappings:[{from:work,to:'system3-build'}],dependencies:sdkPath?{readSDK:()=>sdkPath}:{}});
 const notices=[{file:path.join(sourceDir,'COPYING.txt'),name:'System3 SDL2',license:'GPL-2.0-or-later',sourceUrl:'https://github.com/kichikuou/system3-sdl2'},
  {file:path.join(sourceDir,'deps/ymfm/LICENSE'),name:'ymfm',license:'BSD-3-Clause',sourceUrl:'https://github.com/aaronsgiles/ymfm'},
  {file:path.join(sourceDir,'resources/fonts/MTLc3m.ttf.license'),name:'MTLc3m font',license:'Apache-2.0',sourceUrl:'https://github.com/kichikuou/system3-sdl2'},
  {file:path.join(root,'LICENSE'),name:'MacLauncher resource adapter and build recipes',license:'MIT',sourceUrl:'https://github.com/procrastinine/maclauncher-builds'}],sdlNoticeSources=[];
 for(const pin of Fonts.PIN.dependencies){const source=result.dependencyClosure.sourceRoots[pin.id];
  if(pin.id==='sdl2'){const sdl=collectSdlNotices({source,output:path.join(work,'sdl-notices'),name:pin.name+' '+pin.version,sourceUrl:pin.sourceUrl,includeLibm:true});notices.push(...sdl.notices);sdlNoticeSources.push(sdl.provenance);}
  else for(const name of pin.notices)notices.push({file:path.join(source,name),name:pin.name,license:pin.license,sourceUrl:pin.sourceUrl});}
 return sealRuntime({project,version,arch,output,executable:result.executable,sourceRoot:sourceDir,upstreamRevision:Builder.REVISION,payloads:[{source:result.resources,relative:'share/system3'}],notices,provenance:{sdlNoticeSources}});
}
recipeMain(import.meta,buildSystem3);
