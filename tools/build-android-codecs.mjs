import {recipeMain} from './build-source.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildInput} from './build-input.mjs';
import {buildOptions,run} from './build-source.mjs';
import {helperPackage,sha} from './helper-package.mjs';

const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const Audio=require('../producers/maclauncher/src/modules/shared/runtime/portable-sndfile.js');
const Tools=require('../producers/maclauncher/scripts/native-binary-tools.cjs');
const descriptor=path.join(root,'producers/android-inputs/codecs.json');
const system=value=>value.startsWith('/usr/lib/')||value.startsWith('/System/Library/');
const read=(command,args)=>execFileSync(command,args,{encoding:'utf8'}).trim();

/** Build the original shared codec profile and stage its complete dynamic closure. */
export async function buildAndroidCodecsInput({output,work,arch='arm64'}){
 if(process.platform!=='darwin'||!['arm64','x64'].includes(arch)||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Android codec input builds need macOS, a CPU and new absolute output/work directories.');
 const profile=JSON.parse(fs.readFileSync(descriptor));
 if(Audio.PIN.version!==profile.sourceProfile)throw Error('The shared codec source catalog differs from this input profile.');
 fs.mkdirSync(work,{recursive:true});const archives={};
 for(const pin of Audio.PIN.dependencies)archives[pin.id]=await buildInput({url:pin.archiveUrl,sha256:pin.archiveSha256,bytes:pin.archiveBytes},path.join(work,'archives'));
 const built=await Audio.buildDependencies({archives,workRoot:path.join(work,'compile'),architecture:arch,pathMappings:[{from:work,to:'ANDROID_CODEC_BUILD'}],dependencies:{findBuildTool:name=>read('/usr/bin/which',[name])}});
 const prefix=fs.realpathSync(built.prefix),libraries=path.join(prefix,'lib'),codecs=path.join(output,'codecs'),codecNotices=path.join(output,'notices');
 fs.mkdirSync(codecs,{recursive:true});fs.mkdirSync(codecNotices);
 const roots=[...new Set(fs.readdirSync(libraries).filter(name=>/^libsndfile\..*\.dylib$/.test(name)).map(name=>fs.realpathSync(path.join(libraries,name))))];
 if(roots.length!==1)throw Error('The codec build must supply one libsndfile implementation.');
 const cpu=arch==='x64'?'x86_64':'arm64',queue=[...roots],staged=new Map();
 for(let index=0;index<queue.length;index++){
  const source=queue[index];if(staged.has(source))continue;
  if(!source.startsWith(prefix+path.sep))throw Error('The codec library closure escapes its declared source build.');
  const target=path.join(codecs,path.basename(source));
  if(fs.existsSync(target))throw Error('The codec dependency closure has conflicting library basenames.');
  run('/usr/bin/strip',['-S','-o',target,source]);staged.set(source,target);
  const ids=Tools.libraryIds(source,cpu),commands=Tools.loadCommands(source,cpu);
  for(const link of Tools.links(source,cpu).filter(link=>!system(link)&&!ids.includes(link)))queue.push(Tools.resolveLink(link,source,roots[0],commands.rpaths,cpu));
 }
 for(const [source,target] of staged){
  const ids=Tools.libraryIds(source,cpu),commands=Tools.loadCommands(source,cpu);
  for(const link of Tools.links(source,cpu).filter(link=>!system(link)&&!ids.includes(link))){
   const dependency=Tools.resolveLink(link,source,roots[0],commands.rpaths,cpu);
   if(!staged.has(dependency))throw Error('A codec dependency was not staged.');
   run('/usr/bin/install_name_tool',['-change',link,'@loader_path/'+path.basename(staged.get(dependency)),target]);
  }
  for(const rpath of new Set(commands.rpaths.filter(value=>path.isAbsolute(value)&&!system(value))))run('/usr/bin/install_name_tool',['-delete_rpath',rpath,target]);
  run('/usr/bin/install_name_tool',['-id','@rpath/'+path.basename(target),target]);
  fs.chmodSync(target,0o755);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',target]);run('/usr/bin/codesign',['--verify','--strict',target]);
 }
 const notices=[];
 for(const pin of Audio.PIN.dependencies)for(const name of pin.notices){
  const relative=pin.id+'/'+name,target=path.join(codecNotices,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(built.sourceRoots[pin.id],name),target);
  notices.push({name:pin.name+' '+name,license:pin.license,path:'notices/'+relative,sourceUrl:pin.sourceUrl});
 }
 const include=path.join(output,'include');fs.cpSync(path.join(prefix,'include'),include,{recursive:true});
 const sourceIdentity={profile:Audio.PIN.version,architecture:arch,recipeSha256:built.recipeSha256,audioFormats:built.audioFormats,dependencies:Audio.PIN.dependencies};
 fs.writeFileSync(path.join(output,'sources.json'),JSON.stringify(sourceIdentity,null,2)+'\n');
 return {codecs,codecNotices,include,sourceArchives:archives,sources:built.sourceRoots,profile,notices,audioFormats:built.audioFormats,recipeSha256:built.recipeSha256};
}

/** Seal the same codec input closure for the shared Runtime build path. */
export async function buildAndroidCodecs({project,version,arch,output,work}){
 const profile=JSON.parse(fs.readFileSync(descriptor));version??=profile.version;
 if(project!==profile.id||version!==profile.version||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select the declared Android codec version and a new absolute output directory.');
 const input=await buildAndroidCodecsInput({output:path.join(output,'payload'),work,arch});
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:{sourceProfile:profile.sourceProfile,audioFormats:input.audioFormats,recipeSha256:input.recipeSha256},notices:input.notices});
}
recipeMain(import.meta,buildAndroidCodecs);
