import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const profile=JSON.parse(fs.readFileSync(path.join(root,'producers/maclauncher/app-source.json')));
const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',maxBuffer:Infinity}).trim();
/** The app is the source authority; the producer consumes its exact clean pin. */
export function appSourceRoot(){
 const directory=path.join(root,profile.gitlink);
 if(!/^[a-f0-9]{40}$/.test(profile.revision)||git(root,['rev-parse','HEAD:'+profile.gitlink])!==profile.revision||git(directory,['rev-parse','HEAD'])!==profile.revision)throw Error('Initialize the exact declared MacLauncher app source pin.');
 if(git(directory,['status','--porcelain','--untracked-files=no','--ignore-submodules=all']))throw Error('The pinned app source has tracked changes.');
 const origin=git(directory,['remote','get-url','origin']).replace(/^git@github.com:/,'https://github.com/').replace(/\.git$/,'').replace(/\/$/,'');
 if(origin!==profile.repository)throw Error('The app source origin differs from its public declaration.');
 return {directory,revision:profile.revision};
}
/** Export committed module bytes; ignored local files never enter the build. */
export function materializeAppModule({module,output}){
 if(!profile.modules.includes(module)||!path.isAbsolute(output)||fs.existsSync(output))throw Error('Choose a declared app module and a new absolute source directory.');
 const source=appSourceRoot(),archive=execFileSync('git',['-C',source.directory,'archive','--format=tar',source.revision+':'+module],{maxBuffer:Infinity});
 fs.mkdirSync(output,{recursive:true});
 try{execFileSync('/usr/bin/tar',['-xf','-','-C',output],{input:archive,stdio:['pipe','pipe','pipe']});return {...source,output};}
 catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}

/** Give source-only validators and build modules regular pinned app bytes.
 * Restore the committed references after the producer finishes. */
export function materializeProducerSourceLinks(){
 const source=appSourceRoot(),pending=[],changed=[];
 const tree=(directory,revision,prefix)=>execFileSync('git',['-C',directory,'ls-tree','-rz',revision,'--',prefix],{encoding:'utf8'}).split('\0').filter(Boolean).map(entry=>{const [facts,name]=entry.split('\t'),[mode,,oid]=facts.split(' ');return {mode,oid,name};});
 const entries=tree(root,'HEAD','producers/maclauncher/src/modules/shared/reshade').filter(entry=>entry.mode==='120000');
 const appFiles=new Map(tree(source.directory,source.revision,'src/modules/shared/reshade').map(entry=>[entry.name,entry]));
 const blobHash=bytes=>createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
 const blobs=execFileSync('git',['-C',root,'cat-file','--batch'],{input:entries.map(entry=>entry.oid+'\n').join(''),maxBuffer:Infinity}),links=new Map();let at=0;
 for(const entry of entries){const end=blobs.indexOf(10,at),header=blobs.subarray(at,end).toString().split(' '),length=Number(header[2]);if(end<0||header[0]!==entry.oid||header[1]!=='blob'||!Number.isSafeInteger(length)||length<0||blobs[end+1+length]!==10)throw Error('Invalid committed app source reference.');links.set(entry.oid,blobs.subarray(end+1,end+1+length).toString());at=end+length+2;}
 for(const entry of entries){
  const file=path.join(root,entry.name),link=links.get(entry.oid),target=path.resolve(path.dirname(file),link);
  if(!target.startsWith(source.directory+path.sep))throw Error('App source reference escaped its exact pin.');
  const appRelative=path.relative(source.directory,target).split(path.sep).join('/'),fact=appFiles.get(appRelative);
  if(!fact||!['100644','100755'].includes(fact.mode)||!fs.lstatSync(target).isFile())throw Error('App source reference selects an undeclared regular source file.');
  const bytes=fs.readFileSync(target),mode=fact.mode==='100755'?0o755:0o644;if(blobHash(bytes)!==fact.oid)throw Error('App source differs from its pinned blob.');
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()){if(fs.readlinkSync(file)!==link)throw Error('Producer source reference changed.');pending.push({file,link,bytes,mode});}
  else if(!stat.isFile()||!fs.readFileSync(file).equals(bytes))throw Error('Producer source differs from its pinned app input.');
 }
 const restore=()=>{for(const item of changed.splice(0).reverse()){
  if(!fs.lstatSync(item.file).isFile()||!fs.readFileSync(item.file).equals(item.bytes))throw Error('Materialized app source changed; preserve it for review.');
  const temporary=item.file+'.app-reference-'+randomUUID();try{fs.symlinkSync(item.link,temporary);fs.renameSync(temporary,item.file);}finally{fs.rmSync(temporary,{force:true});}
 }};
 try{for(const item of pending){const temporary=item.file+'.app-source-'+randomUUID();try{fs.writeFileSync(temporary,item.bytes,{flag:'wx',mode:item.mode});fs.renameSync(temporary,item.file);changed.push(item);}finally{fs.rmSync(temporary,{force:true});}}return restore;}
 catch(error){restore();throw error;}
}
