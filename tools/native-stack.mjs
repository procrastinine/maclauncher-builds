import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildInput} from './build-input.mjs';
import {helperPackage,sha} from './helper-package.mjs';
import {collectSdlNotices} from './sdl-notices.mjs';
import {addLicense} from '../lib/licenses.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/maclauncher/src/modules/shared/runtime');
const Source=require(path.join(base,'pinned-native-build.js')),Tools=require('../producers/maclauncher/scripts/native-binary-tools.cjs');
const system=value=>value.startsWith('/usr/lib/')||value.startsWith('/System/Library/');
const command=(tool,args)=>execFileSync(tool,args,{encoding:'utf8',maxBuffer:Infinity}).trim();
const metadataFile=file=>/\.(?:pc|cmake|la)$/.test(file)||/-config$/.test(file);
const PREFIX='NATIVE_STACK_PREFIX',SDK='NATIVE_STACK_SDK';
const modules={fonts:'portable-sdl2-fonts',audio:'portable-sndfile',movie:'portable-ffmpeg',mixer:'portable-sdl2-mixer'};
export const stackModule=kind=>require(path.join(base,modules[kind]+'.js'));

/** A temporary compiler prefix keeps the verified package immutable. Only its
 * installed text metadata is expanded; library bytes retain their sealed hash.
 */
export function nativeStackInput(input,{arch,work,fonts,audio,sdk=process.env.SDKROOT||command('/usr/bin/xcrun',['--show-sdk-path']),tools}={}){
 if(!input)throw Error('A prepared shared native stack is required.');
 const metadata=JSON.parse(fs.readFileSync(path.join(input.root,'portable-stack.json')));
 if(metadata.schemaVersion!==1||metadata.architecture!==arch)throw Error('The prepared native stack has a different target CPU.');
 const prefix=path.resolve(work);if(!path.isAbsolute(work)||fs.existsSync(prefix))throw Error('Shared native stack views require a new absolute build directory.');
 Tools.copyTree(input.root,prefix);
 for(const [logical,canonical] of Object.entries(input.declaration?.aliases?.files||{}))if(typeof canonical==='string'){
  const alias=path.join(prefix,logical),target=path.join(prefix,canonical);if(fs.existsSync(alias)&&fs.existsSync(target)){fs.unlinkSync(alias);fs.symlinkSync(path.relative(path.dirname(alias),target),alias);}
 }
 function expand(value){if(typeof value==='string')return value.replaceAll(PREFIX,prefix).replaceAll(SDK,sdk);if(Array.isArray(value))return value.map(expand);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,value])=>[key,expand(value)]));return value;}
 function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())visit(file);else if(metadataFile(file))fs.writeFileSync(file,expand(fs.readFileSync(file,'utf8')));}}
 visit(prefix);
 const stack={...expand(metadata.stack),prefix,sdk,tools:tools||{cmake:Source.findBuildTool('cmake'),ninja:Source.findBuildTool('ninja')},sourceRoots:{},preparedInput:input,
  notices:[]};
 if(metadata.kind==='mixer'){if(!fonts||!audio)throw Error('The shared mixer requires its prepared font and audio stacks.');Object.assign(stack,{fonts,audio,readRoots:[fonts.prefix,audio.prefix]});}
 return stack;
}

export async function nativeStackArchives(catalog,{work}={}){
 const archives={};for(const pin of catalog.dependencies||[])archives[pin.id]=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes},path.join(work,'archives'));
 return archives;
}

/** Relocate a complete source-built compiler prefix once, before its consumers
 * link it. Common packaging subsequently replaces cross-stack copies by aliases.
 */
export function stageNativeStack({built,kind,arch,output,work}){
 const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});Tools.copyTree(built.prefix,payload);
 const cpu=arch==='x64'?'x86_64':'arm64',binaries=[];
 const prefixes=[built.prefix,built.fonts?.prefix,built.audio?.prefix].filter(Boolean).sort((a,b)=>b.length-a.length);
 function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const target=path.join(directory,entry.name);if(entry.isDirectory()){visit(target);continue;}const relative=path.relative(payload,target),source=fs.realpathSync(path.join(built.prefix,relative));if(Tools.macho(target))binaries.push({target,source});else if(metadataFile(target)){let text=fs.readFileSync(target,'utf8');for(const prefix of prefixes)text=text.replaceAll(prefix,PREFIX);fs.writeFileSync(target,text.replaceAll(built.sdk,SDK));}}}
 visit(payload);
 const targets=new Map(binaries.map(({source,target})=>[source,target]));
 const shared=new Set([built.fonts?.preparedInput,built.audio?.preparedInput].filter(Boolean).flatMap(input=>(input.declaration?.files||[]).map(file=>file.sha256+':'+file.size)));
 const groups=new Map();for(const binary of binaries){if(!groups.has(binary.source))groups.set(binary.source,[]);groups.get(binary.source).push(binary);}
 for(const [source,copies] of groups){const target=(copies.find(copy=>path.basename(copy.target)===path.basename(source))||copies[0]).target,ids=Tools.libraryIds(source,cpu),commands=Tools.loadCommands(source,cpu);
  if(shared.has(sha(source)+':'+fs.statSync(source).size))continue;
  for(const link of Tools.links(source,cpu).filter(link=>!system(link)&&!ids.includes(link))){const original=Tools.resolveLink(link,source,source,commands.rpaths,cpu),destination=targets.get(original);if(!destination)throw Error('The shared native stack has an undeclared non-system library: '+link);command('/usr/bin/install_name_tool',['-change',link,'@loader_path/'+path.relative(path.dirname(target),destination).split(path.sep).join('/'),target]);}
  for(const rpath of new Set(commands.rpaths.filter(value=>path.isAbsolute(value)&&!system(value))))command('/usr/bin/install_name_tool',['-delete_rpath',rpath,target]);
  if(ids.length)command('/usr/bin/install_name_tool',['-id','@rpath/'+path.basename(source),target]);
  fs.chmodSync(target,0o755);command('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',target]);command('/usr/bin/codesign',['--verify','--strict',target]);
  for(const copy of copies)if(copy.target!==target){fs.copyFileSync(target,copy.target);fs.chmodSync(copy.target,0o755);}
 }
 const notices=[];
 for(const pin of built.sources||[]){const source=built.sourceRoots?.[pin.id]||pin.sourceRoot;if(!source)continue;
  if(pin.id==='sdl2'){const collected=collectSdlNotices({source,output:path.join(work,'sdl-notices'),name:pin.name+' '+pin.version,sourceUrl:pin.sourceUrl||pin.archiveUrl,includeLibm:true});for(const notice of collected.notices)addLicense(payload,notice.name,notice.file,notice.license);}
  else for(const name of pin.notices||[])addLicense(payload,pin.name,path.join(source,name),pin.license);
 }
 if(built.source?.notices)for(const name of built.source.notices)addLicense(payload,kind,path.join(built.sourceRoot,name),built.source.license);
 const {fonts,audio,preparedInput,notices:oldNotices,readRoots,...metadata}=built;
 const stack=Tools.publicProvenance(metadata,[{from:built.prefix,to:PREFIX},{from:built.sdk,to:SDK},{from:work,to:'NATIVE_STACK_BUILD'}]);
 for(const key of ['prefix','sdk','tools','sourceRoots','sourceRoot','outputRoot'])delete stack[key];
 // Source identities remain complete; compiler work locations are not inputs.
 for(const source of stack.sources||[])for(const key of ['sourceRoot','outputRoot'])delete source[key];
 fs.writeFileSync(path.join(payload,'portable-stack.json'),JSON.stringify({schemaVersion:1,kind,architecture:arch,stack},null,2)+'\n');
 return {payload,notices};
}

export async function buildNativeStack({project,version,arch,output,work,kind,dependencyStacks,archives:providedArchives}){
 const Builder=stackModule(kind),archives={...providedArchives,...await nativeStackArchives(Builder.PIN,{work})},options={archives,workRoot:path.join(work,'compile'),architecture:arch,pathMappings:[{from:work,to:'NATIVE_STACK_BUILD'}],dependencies:{readSDK:()=>process.env.SDKROOT||command('/usr/bin/xcrun',['--show-sdk-path'])}};
 const built=kind==='movie'?await Builder.buildDependencies({...options,archive:await buildInput(Builder.PIN.source,path.join(work,'archives'))}):kind==='mixer'?await Builder.buildMixer({...options,dependencyStacks}):await Builder.buildDependencies(options);
 const staged=stageNativeStack({built,kind,arch,output,work});
 const primary={fonts:'sdl2',audio:'sndfile',mixer:'sdl2_mixer'}[kind],upstreamVersion=kind==='movie'?Builder.PIN.source.version:Builder.PIN.dependencies.find(pin=>pin.id===primary).version;
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(path.join(base,modules[kind]+'.json')),manifestRelative:'input.json',record:{sourceProfile:Builder.PIN.version,upstreamVersion,recipeSha256:built.recipeSha256},notices:staged.notices});
}
