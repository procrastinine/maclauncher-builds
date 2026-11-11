import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gitlinkRevisions,sourceRevision} from './pins.mjs';

/** File and Gitlink access for the current checkout or an immutable Git tree. */
export function treeSource(directory,{at}={}){
 const root=fs.realpathSync(directory),files=new Map(),trees=new Map();
 function git(repository,args){
  try{return execFileSync('git',['-C',repository,...args],{
   encoding:'utf8',maxBuffer:1<<28,stdio:['ignore','pipe','pipe']
  }).trim();}
  catch{throw Error('Recorded Git data is unavailable: '+args.at(-1));}
 }
 function entries(repository,commit){
  const key=repository+'\0'+commit;
  if(!trees.has(key)){
   const rows=git(repository,['ls-tree','-r','-z',commit]).split('\0').filter(Boolean);
   trees.set(key,rows.map(row=>{
    const [header,file]=row.split('\t'),[mode,,revision]=header.split(' ');
    return {mode,path:file,revision};
   }));
  }
  return trees.get(key);
 }
 function readTree(repository,commit,file){
  const rows=entries(repository,commit);
  const link=rows.find(row=>row.mode==='160000'&&file.startsWith(row.path+'/'));
  if(link)return readTree(path.join(repository,link.path),link.revision,file.slice(link.path.length+1));
  const entry=rows.find(row=>row.path===file);
  if(!entry||!['100644','100755'].includes(entry.mode))throw Error('No recorded data file: '+file);
  return git(repository,['show',commit+':'+file]);
 }
 function readFile(file){
  if(path.isAbsolute(file)||file.split('/').some(part=>part==='..'))throw Error('A tree file must be relative.');
  if(!files.has(file))files.set(file,at?readTree(root,at,file):fs.readFileSync(path.join(root,file),'utf8'));
  return files.get(file);
 }
 let links;
 return {
  root,at,readFile,
  owningPath:file=>[...(links??=gitlinkRevisions(root,at||'HEAD')).keys()]
   .find(link=>file===link||file.startsWith(link+'/'))||file,
  json:file=>JSON.parse(readFile(file)),
  gitlinks:()=>links??=gitlinkRevisions(root,at||'HEAD'),
  revision:record=>{
   try{return record.revision??sourceRevision(record,root,links??=gitlinkRevisions(root,at||'HEAD'),at||'HEAD');}
   catch{throw Error('No recorded Gitlink revision: '+record.gitlink);}
  }
 };
}
