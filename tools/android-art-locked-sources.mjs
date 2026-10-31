import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {run} from './build-source.mjs';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const safe=value=>typeof value==='string'&&!path.isAbsolute(value)&&!value.split('/').some(part=>part==='.'||part==='..'||part==='');

/** Read the existing ART source lock without introducing another source selection. */
export function lockedArtSourceRecords(source){
 const text=fs.readFileSync(path.join(source,'patches/art-android/sources.lock'),'utf8'),tag=/^AOSP_TAG=([^\r\n]+)$/m.exec(text)?.[1];
 if(!/^android-[A-Za-z0-9._-]+$/.test(tag||''))throw Error('The original ART source tag is unavailable.');
 return ['SOURCE_TREES','SOURCE_FILES'].flatMap(section=>{
  const body=new RegExp('^'+section+'=\\(\\n([\\s\\S]*?)^\\)','m').exec(text)?.[1];if(body===undefined)throw Error('Missing original ART source group: '+section);
  return [...body.matchAll(/^\s*"([^"]+)"/gm)].map(match=>{
   const[project,relative,sha256,revision]=match[1].split('|');
   if(!safe(project)||relative&&!safe(relative)||!/^[a-f0-9]{64}$/.test(sha256||'')||revision&&!/^[a-f0-9]{40}$/.test(revision))throw Error('The original ART source record is invalid.');
   return {project,path:relative,sha256,revision:revision||'refs/tags/'+tag,file:section==='SOURCE_FILES'};
  });
 });
}
function sourceTreeIdentity(directory){
 const files=[];function walk(at,relative=''){for(const entry of fs.readdirSync(at,{withFileTypes:true})){const name=path.posix.join(relative,entry.name),file=path.join(at,entry.name);if(entry.isDirectory())walk(file,name);else if(entry.isFile()&&entry.name!=='.fetched')files.push(name);}}
 walk(directory);files.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));return digest(files.map(file=>digest(fs.readFileSync(path.join(directory,file)))+'  ./'+file+'\n').join(''));
}
function gitSource(record,output,work){
 const checkout=path.join(work,'git');fs.mkdirSync(checkout);
 run('git',['init','-q',checkout]);run('git',['-C',checkout,'remote','add','origin','https://android.googlesource.com/'+record.project]);
 run('git',['-C',checkout,'fetch','--depth=1','--filter=blob:none','origin',record.revision]);
 if(record.path)run('git',['-C',checkout,'sparse-checkout','set','--no-cone','/'+record.path+(record.file?'':'/')]);
 run('git',['-C',checkout,'checkout','--detach','FETCH_HEAD']);
 const selected=path.join(checkout,record.path);fs.rmSync(path.join(checkout,'.git'),{recursive:true});fs.cpSync(selected,output,{recursive:!record.file,verbatimSymlinks:true});
}

/** Acquire only the locked original ART source subsets for complete source export. */
export function acquireLockedArtSources({source,output,work}){
 if(![source,output,work].every(value=>path.isAbsolute(value||''))||fs.existsSync(output)||fs.existsSync(work))throw Error('ART source export inputs require new absolute source/cache directories.');
 fs.mkdirSync(output,{recursive:true});fs.mkdirSync(work,{recursive:true});const records=lockedArtSourceRecords(source);
 for(const[index,record]of records.entries()){
  const destination=path.join(output,record.project.replace(/^platform\//,''),record.path),temporary=path.join(work,String(index));fs.mkdirSync(temporary);fs.mkdirSync(path.dirname(destination),{recursive:true});
  const archive=path.join(temporary,'input'),url='https://android.googlesource.com/'+record.project+(record.file?'/+/':'/+archive/')+record.revision+(record.path?'/'+record.path:'')+(record.file?'?format=TEXT':'.tar.gz');
  try{
   try{
    run('curl',['--fail','--silent','--show-error','--location','--retry','2','--retry-all-errors','--proto','=https','--proto-redir','=https','--max-time','600','--output',archive,url],{timeout:610000});
    if(record.file)fs.writeFileSync(destination,Buffer.from(fs.readFileSync(archive,'utf8'),'base64'),{flag:'wx'});
    else{
     const names=execFileSync('/usr/bin/tar',['-tzf',archive],{encoding:'utf8',maxBuffer:16<<20}).split('\n').filter(Boolean);
     if(names.some(name=>path.isAbsolute(name)||name.split('/').includes('..')))throw Error('The original source archive leaves its root.');
     fs.mkdirSync(destination);run('/usr/bin/tar',['-xzf',archive,'-C',destination]);
    }
   }catch(error){
    fs.rmSync(destination,{recursive:!record.file,force:true});gitSource(record,destination,temporary);
   }
   const actual=record.file?digest(fs.readFileSync(destination)):sourceTreeIdentity(destination);if(actual!==record.sha256)throw Error('Original ART source differs from its locked content: '+record.project+'/'+record.path);
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
 }
 fs.writeFileSync(path.join(work,'sources.json'),JSON.stringify(records,null,2)+'\n');return output;
}
