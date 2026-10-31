import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {buildInput} from './build-input.mjs';
import {collectSdlNotices} from './sdl-notices.mjs';
import {recipeMain} from './build-source.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {resolveProject} from '../lib/projects.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),modules=path.join(root,'producers/maclauncher/src/modules');
const Fonts=require(path.join(modules,'shared/runtime/portable-sdl2-fonts.js')),Audio=require(path.join(modules,'shared/runtime/portable-sndfile.js')),Movie=require(path.join(modules,'shared/runtime/portable-ffmpeg.js')),Mixer=require(path.join(modules,'shared/runtime/portable-sdl2-mixer.js'));
/** Each portable runtime names its producer recipe and entry, its upstream source, its
 * shared resource directory, the source catalogs it reads besides fonts and audio, its
 * single source archives, the dependency stacks built before it and the name that its
 * notices give a bundled CPython or FFmpeg source. */
const RECIPES=Object.freeze({
 onsyuri:{recipe:'shared/onsyuri/runtime/portable-build-v3.js',entry:'buildPortableYuri',source:'onscripter-yuri',share:'onsyuri',catalogs:['mixer','producer'],archives:{onsyuri:'engine'}},
 gemrb:{recipe:'gemrb/runtime/portable-build-v5.js',entry:'buildPortableGemRB',source:'gemrb',share:'gemrb',catalogs:['mixer'],archives:{python:'python'},bundledSource:'CPython',python:{library:'python/lib/python3.14',home:'python'}},
 ai5:{recipe:'ai5/runtime/portable-build-v4.js',entry:'buildPortableAI5',source:'ai5-sdl2',share:'ai5-sdl2',archives:{ffmpeg:'movie'},bundledSource:'FFmpeg',stacks:['fonts','audio','movie']},
 xsystem35:{recipe:'alicesoft/system35-portable-v3.js',entry:'buildPortableSystem35',source:'xsystem35-sdl2',share:'xsystem35',catalogs:['mixer','producer']},
 xsystem4:{recipe:'alicesoft/system4-portable-v3.js',entry:'buildPortableSystem4',source:'xsystem4',share:'xsystem4',catalogs:['producer'],archives:{ffmpeg:'movie'},bundledSource:'FFmpeg'}
});
const CATALOGS={mixer:()=>Mixer.PIN,producer:Builder=>Builder.PIN};
const ARCHIVES={movie:()=>Movie.PIN.source,python:()=>require(path.join(modules,'shared/runtime/portable-python-v2.js')).PIN.source,engine:Builder=>Builder.PIN.engine};
const STACKS={fonts:{module:Fonts,option:'fontStack',suffix:'-fonts'},audio:{module:Audio,option:'audioStack',suffix:'-audio'},movie:{module:Movie,option:'movieStack',suffix:'-movies',archive:'ffmpeg'}};
const archiveInput=pin=>pin.archiveUrl?{url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes}:pin;
export async function buildPortableRuntime({project,arch,version,output,work}){
 const recipe=RECIPES[project];if(!recipe)throw Error('No portable runtime recipe is declared for '+project+'.');
 const Builder=require(path.join(modules,recipe.recipe)),sourceDir=path.join(root,'producers/maclauncher/src/external',recipe.source),archives={};
 for(const catalog of [Fonts.PIN,Audio.PIN,...(recipe.catalogs||[]).map(name=>CATALOGS[name](Builder))])for(const pin of catalog.dependencies)if(!archives[pin.id])archives[pin.id]=await buildInput(archiveInput(pin));
 for(const [key,name] of Object.entries(recipe.archives||{}))archives[key]=await buildInput(archiveInput(ARCHIVES[name](Builder)));
 const pathMappings=[{from:work,to:project+'-build'}],options={sourceDir,archives,workRoot:work,architecture:arch,pathMappings};
 for(const name of recipe.stacks||[]){const stack=STACKS[name];options[stack.option]=await stack.module.buildDependencies({...options,...(stack.archive?{archive:archives[stack.archive]}:{}),workRoot:work+stack.suffix});}
 const built=await Builder[recipe.entry](options),notices=[],sdlNoticeSources=[],seen=new Set();
 function collect(stack){if(!stack||seen.has(stack))return;seen.add(stack);for(const pin of stack.sources||[]){const source=stack.sourceRoots?.[pin.id]||pin.sourceRoot;if(pin.id==='sdl2'){const sdl=collectSdlNotices({source,output:path.join(work,'sdl-notices-'+sdlNoticeSources.length),name:pin.name+' '+pin.version,sourceUrl:pin.sourceUrl||pin.archiveUrl,includeLibm:true});notices.push(...sdl.notices);sdlNoticeSources.push(sdl.provenance);}else for(const name of pin.notices||[])notices.push({file:path.join(source,name),name:pin.name,license:pin.license,sourceUrl:pin.sourceUrl});}
  if(stack.source?.notices)for(const name of stack.source.notices)notices.push({file:path.join(stack.sourceRoot,name),name:recipe.bundledSource+' '+stack.source.version,license:stack.source.license,sourceUrl:stack.source.url||stack.source.archiveUrl});
  for(const key of ['fonts','audio','movie','mixer','python','dependencyClosure'])collect(stack[key]);
 }
 collect(built.dependencyClosure);for(const name of recipe.stacks||[])collect(options[STACKS[name].option]);
 const sourceUrl=resolveProject(project,root,{resolvePins:false}).upstreams[0].url;
 for(const name of fs.readdirSync(sourceDir).filter(name=>/^(?:COPYING|LICENSE)(?:[._-].*)?$/i.test(name)))if(fs.statSync(path.join(sourceDir,name)).isFile())notices.push({file:path.join(sourceDir,name),name:project,license:'GPL-2.0-or-later',sourceUrl});
 const licenses=path.join(sourceDir,'licenses');
 if(fs.existsSync(licenses))for(const name of fs.readdirSync(licenses).sort())if(fs.statSync(path.join(licenses,name)).isFile())notices.push({file:path.join(licenses,name),name:path.parse(name).name,license:'See included license',sourceUrl});
 if(!notices.some(row=>row.name===project))console.warn('No license text supplied for '+project);
 const payloads=!built.appRoot&&built.resources&&fs.existsSync(built.resources)?[{source:built.resources,relative:'share/'+recipe.share}]:[];
 const environmentRelative={};
 if(recipe.python){payloads.push({source:built.dependencyClosure.python.stdlib,relative:recipe.python.library});environmentRelative.PYTHONHOME=recipe.python.home;}
 return sealRuntime({project,arch,version,output,executable:built.executable,appRoot:built.appRoot,sourceRoot:sourceDir,sourceScope:built.sourceScope,upstreamRevision:Builder.REVISION,payloads,environmentRelative,notices,provenance:{sdlNoticeSources,features:built.features||{},sourceTreeSha256:built.sourceTreeSha256,overlaySha256:built.overlaySha256}});
}
recipeMain(import.meta,buildPortableRuntime);
