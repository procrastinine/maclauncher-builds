import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {buildInput} from './build-input.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {collectSdlNotices} from './sdl-notices.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),modules=path.join(root,'producers/maclauncher/src/modules');
const Fonts=require(path.join(modules,'shared/runtime/portable-sdl2-fonts.js')),Audio=require(path.join(modules,'shared/runtime/portable-sndfile.js')),Movie=require(path.join(modules,'shared/runtime/portable-ffmpeg.js')),Mixer=require(path.join(modules,'shared/runtime/portable-sdl2-mixer.js'));
const RECIPES=Object.freeze({
  "onsyuri":{"recipe":"shared/onsyuri/runtime/portable-build-v3.js","entry":"buildPortableYuri","source":"onscripter-yuri"},
  "gemrb":{"recipe":"gemrb/runtime/portable-build-v5.js","entry":"buildPortableGemRB","source":"gemrb"},
  "ai5": {
    "recipe": "ai5/runtime/portable-build-v4.js",
    "entry": "buildPortableAI5",
    "source": "ai5-sdl2"
  },
  "xsystem35": {
    "recipe": "alicesoft/system35-portable-v3.js",
    "entry": "buildPortableSystem35",
    "source": "xsystem35-sdl2"
  },
  "xsystem4": {
    "recipe": "alicesoft/system4-portable-v3.js",
    "entry": "buildPortableSystem4",
    "source": "xsystem4"
  }
});
export async function buildPortableRuntime({project,arch,version,output,work}){
 const recipe=RECIPES[project];if(!recipe||!['arm64','x64'].includes(arch)||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select a portable runtime, CPU and new absolute work/output paths.');
 const Builder=require(path.join(modules,recipe.recipe)),sourceDir=path.join(root,'producers/maclauncher/src/external',recipe.source),archives={};
 const catalogs=[Fonts.PIN,Audio.PIN,...(project==='onsyuri'?[Mixer.PIN,Builder.PIN]:project==='gemrb'?[Mixer.PIN]:project==='xsystem35'?[Mixer.PIN,Builder.PIN]:project==='xsystem4'?[Builder.PIN]:[])];
 for(const catalog of catalogs)for(const pin of catalog.dependencies)if(!archives[pin.id])archives[pin.id]=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes});
 if(['ai5','xsystem4'].includes(project))archives.ffmpeg=await buildInput(Movie.PIN.source);
 if(project==='gemrb'){const pin=require(path.join(modules,'shared/runtime/portable-python-v2.js')).PIN.source;archives.python=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes});}
 if(project==='onsyuri'){const pin=Builder.PIN.engine;archives.onsyuri=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes});}
 const pathMappings=[{from:work,to:project+'-build'}],options={sourceDir,archives,workRoot:work,architecture:arch,pathMappings};
 if(project==='ai5'){
  options.fontStack=await Fonts.buildDependencies({...options,workRoot:work+'-fonts'});
  options.audioStack=await Audio.buildDependencies({...options,workRoot:work+'-audio'});
  options.movieStack=await Movie.buildDependencies({...options,archive:archives.ffmpeg,workRoot:work+'-movies'});
 }
 const built=await Builder[recipe.entry](options),notices=[],sdlNoticeSources=[],seen=new Set();
 function collect(stack){if(!stack||seen.has(stack))return;seen.add(stack);for(const pin of stack.sources||[]){const source=stack.sourceRoots?.[pin.id]||pin.sourceRoot;if(pin.id==='sdl2'){const sdl=collectSdlNotices({source,output:path.join(work,'sdl-notices-'+sdlNoticeSources.length),name:pin.name+' '+pin.version,sourceUrl:pin.sourceUrl||pin.archiveUrl,includeLibm:true});notices.push(...sdl.notices);sdlNoticeSources.push(sdl.provenance);}else for(const name of pin.notices||[])notices.push({file:path.join(source,name),name:pin.name,license:pin.license,sourceUrl:pin.sourceUrl});}
  if(stack.source?.notices)for(const name of stack.source.notices)notices.push({file:path.join(stack.sourceRoot,name),name:(project==='gemrb'?'CPython ':'FFmpeg ')+stack.source.version,license:stack.source.license,sourceUrl:stack.source.url||stack.source.archiveUrl});
  for(const key of ['fonts','audio','movie','mixer','python','dependencyClosure'])collect(stack[key]);
 }
 collect(built.dependencyClosure);if(project==='ai5')for(const key of ['fontStack','audioStack','movieStack'])collect(options[key]);
 for(const name of fs.readdirSync(sourceDir).filter(name=>/^(?:COPYING|LICENSE)(?:[._-].*)?$/i.test(name)))if(fs.statSync(path.join(sourceDir,name)).isFile())notices.push({file:path.join(sourceDir,name),name:project,license:'GPL-2.0-or-later',sourceUrl:'https://github.com/'+(project==='onsyuri'?'YuriSizuku/OnscripterYuri':(project==='gemrb'?'gemrb/':project==='xsystem35'?'kichikuou/':'nunuhara/')+recipe.source)});
 // Upstream notices for bundled fonts and embedded code.
 const licenses=path.join(sourceDir,'licenses'),sourceUrl=notices.find(row=>row.name===project)?.sourceUrl;
 if(sourceUrl&&fs.existsSync(licenses))for(const name of fs.readdirSync(licenses).sort())if(fs.statSync(path.join(licenses,name)).isFile())notices.push({file:path.join(licenses,name),name:path.parse(name).name,license:'See included license',sourceUrl});
 if(!notices.some(row=>row.name===project))throw Error('Runtime source license is missing.');
 const payloads=!built.appRoot&&built.resources&&fs.existsSync(built.resources)?[{source:built.resources,relative:'share/'+(project==='ai5'?'ai5-sdl2':project)}]:[];
 const environmentRelative={};
 if(project==='gemrb'){payloads.push({source:built.dependencyClosure.python.stdlib,relative:'python/lib/python3.14'});environmentRelative.PYTHONHOME='python';}
 return sealRuntime({project,arch,version,output,executable:built.executable,appRoot:built.appRoot,sourceRoot:sourceDir,sourceScope:built.sourceScope,upstreamRevision:Builder.REVISION,payloads,environmentRelative,notices,provenance:{sdlNoticeSources,features:built.features||{},sourceTreeSha256:built.sourceTreeSha256,overlaySha256:built.overlaySha256}});
}
export async function main(args){const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','arch','version','output','work'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project, --arch, optional --version, --output and --work.');options[key]=args[i+1];}return buildPortableRuntime(options);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
