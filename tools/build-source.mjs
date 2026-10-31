import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Source=require('../producers/maclauncher/src/modules/shared/runtime/pinned-native-build.js');
export const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
const git=(source,args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8',maxBuffer:32<<20}).trim();
/** Fetch one exact declared HTTPS source revision into a new owned directory. */
export function checkoutSource({repository,revision,destination}){
 const url=new URL(repository);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^[a-f0-9]{40}$/.test(revision||'')||!path.isAbsolute(destination||'')||fs.existsSync(destination))throw Error('Source checkout needs a public HTTPS origin, exact revision and new absolute directory.');
 run('git',['init',destination]);run('git',['-C',destination,'remote','add','origin',repository]);
 run('git',['-C',destination,'fetch','--depth','1','--no-tags','origin',revision]);run('git',['-C',destination,'checkout','--detach','FETCH_HEAD']);
 if(git(destination,['rev-parse','HEAD'])!==revision)throw Error('Fetched source differs from its declared revision.');return destination;
}
/** Export pinned source before applying owned adaptations or compiling. */
export async function stageSource(source,revision,destination){
 const checked=await Source.validatePinnedSource(source,revision);
 const treeSha256=Source.stagePinnedFiles(source,checked.files,destination);
 const dependencies=git(source,['submodule','status','--recursive']).split('\n').filter(Boolean).map(line=>{
  const match=/^ ([a-f0-9]{40}) (\S+)/.exec(' '+line.trim());if(!match)throw Error('Source dependency is not pinned.');
  return {path:match[2],revision:match[1],repository:git(path.join(source,match[2]),['remote','get-url','origin'])};
 });
 return {treeSha256,dependencies};
}
/** Preserve source-tree license notices, including statically linked libraries. */
export function sourceNotices(source,{name,repository}){
 const rows=[];function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  if(entry.name==='.git')continue;const file=path.join(directory,entry.name);
  if(entry.isDirectory())visit(file);
  else if(entry.isFile()&&(/^(?:LICEN[CS]E|COPYING|NOTICE|COPYRIGHT)(?:[._-]|$)/i.test(entry.name)||entry.name==='FTL.TXT'))rows.push({file,name:name+' '+path.relative(source,file),license:'See original notice',sourceUrl:repository});
 }}visit(source);if(!rows.length)throw Error('Source license notices are missing: '+name);return rows;
}
export function buildOptions(args){
 const options={};for(let index=0;index<args.length;index+=2){const key=args[index]?.slice(2);if(!['project','version','arch','output','work'].includes(key)||!args[index+1]||Object.hasOwn(options,key))throw Error('Use --project, --version, --arch, --output and --work.');options[key]=args[index+1];}return options;
}
