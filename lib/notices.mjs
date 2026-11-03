import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {downloadFile} from '../tools/download.mjs';
export const NOTICE_LIMIT=1024*1024;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const SIGNED_BUNDLE=/\.(?:app|framework|bundle|appex|xpc|plugin)\//i,CODE=/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|java|kt|rs|go|js|ts|swift)(?:\.txt)?$/i;
const WORDS=8,SHORTEST=256;
export function printWarnings(warnings){for(const warning of warnings||[])try{console.log('::warning::'+String(warning).replace(/[\r\n]/g,' '));}catch{}}
const safe=name=>typeof name==='string'&&name.length>0&&name.length<=1024&&name.split('/').every(part=>part!=='.'&&part!=='..'&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
/** Notice paths are separate archive members, not payload inventory facts. */
export function isNoticePath(name,rows=[]){
 if(typeof name!=='string')return false;
 return (Array.isArray(rows)?rows:[]).some(row=>(typeof row==='string'?row:row?.path)===name)||/(?:^|\/)(?:notices?|licen[cs]es?)(?:\/|$)/i.test(name)||/(?:^|[\/_.-])(?:licen[cs]e|copying|copyright|notice|MIT|BSD(?:[-_.]\d+)*|Apache(?:[-_.]\d+)*)(?:$|\.(?:txt|md|rst|html?)$)/i.test(name)||/(?:^|\/)DEPENDENCIES\.txt$/i.test(name);
}
/** Recipes copy candidates best-effort; sealing is the only notice judge. */
export function copyNotices(candidates,{root='',output,packageName='Package',sourceUrl}={}){
 const notices=[],warnings=[];
 for(const [index,row]of (Array.isArray(candidates)?candidates:[]).entries())try{
  if(row?.path!==undefined&&!safe(row.path))throw Error('Copy destination is not a contained path.');
  const source=row?.file||path.join(root,row?.path||'');
  const relative=row?.path&&safe(row.path)?row.path:path.basename(source||'notice-'+index);
  const file=output?path.join(output,relative):source;
  if(output){fs.mkdirSync(path.dirname(file),{recursive:true});if(typeof row?.text==='string')fs.writeFileSync(file,row.text);else if(path.resolve(source)!==path.resolve(file))fs.copyFileSync(source,file,fs.constants.COPYFILE_FICLONE);}
  const {sha256,bytes,size,text,transform,...metadata}=row||{};
  notices.push({...metadata,file,path:relative,name:row?.name||packageName,license:row?.license||'See original notice',...(row?.sourceUrl||sourceUrl?{sourceUrl:row?.sourceUrl||sourceUrl}:{})});
 }catch(error){warnings.push('Notice candidate was not copied: '+error.message);}
 printWarnings(warnings);return{notices,warnings};
}
export const intakeNotices=copyNotices;
export function copyNotice(source,target,metadata={}){
 const candidate=typeof source==='string'?{file:source}:source;
 return copyNotices([{...candidate,...metadata,path:path.basename(target)}],{output:path.dirname(target)});
}
export function sourceNotices(root,{name='Package',repository,all=false}={}){
 const candidates=[],warnings=[];
 function visit(directory){try{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  if(entry.name==='.git')continue;const file=path.join(directory,entry.name);
  if(entry.isDirectory())visit(file);
  else if(all||/^(?:licen[cs]e|copying|copyright|notice)(?:[._-]|$)/i.test(entry.name)||entry.name==='FTL.TXT')candidates.push({file,name:name+' '+path.relative(root,file),license:'See original notice',sourceUrl:repository});
 }}catch(error){warnings.push('Notice candidates were not collected: '+error.message);}}
 visit(root);printWarnings(warnings);return candidates;
}
export async function fetchNotices(candidates,options={}){
 const notices=[],warnings=[];let temporary;
 try{const output=options.output||(temporary=fs.mkdtempSync(path.join(os.tmpdir(),'notices-')));
 for(const [index,row]of (Array.isArray(candidates)?candidates:[]).entries())try{
  const relative=row.path||row.filename||('notice-'+index+'.txt');if(!safe(relative))continue;
  const file=path.join(output,relative);fs.mkdirSync(path.dirname(file),{recursive:true});await downloadFile(row.url,file,{bytes:NOTICE_LIMIT});
  notices.push(...copyNotices([{...row,file,path:relative}],options).notices);
 }catch(error){warnings.push('Notice candidate was not fetched: '+error.message);}
 }catch(error){warnings.push('Notice candidates were not fetched: '+error.message);}
 printWarnings(warnings);return{notices,warnings};
}
/** Metadata readers only warn; payload integrity remains independent of notice rows. */
export function noticeRows(rows,{files,packageName='Package'}={}){
 const notices=[],warnings=[];const names=files?new Set([...files].map(file=>typeof file==='string'?file:file.path)):null;
 if(!Array.isArray(rows))warnings.push(packageName+' has no usable notice list.');
 for(const row of Array.isArray(rows)?rows:[]){
  if(!row||typeof row.name!=='string'||!row.name.trim()||typeof row.license!=='string'||!row.license.trim()||!safe(row.path)||names&&!names.has(row.path)||row.sourceUrl!==undefined&&(typeof row.sourceUrl!=='string'||!/^https:\/\//.test(row.sourceUrl)))warnings.push(packageName+' has an unusable notice entry.');
  else notices.push({name:row.name,license:row.license,path:row.path,...(row.sourceUrl?{sourceUrl:row.sourceUrl}:{})});
 }
 return{notices,warnings};
}
function noticePath(root,name){
 if(!safe(name))throw Error('Unusable notice path');
 let directory=path.resolve(root);for(const part of name.split(/[\\/]/).slice(0,-1)){directory=path.join(directory,part);const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Notice path crosses a non-directory');}
 return path.join(root,name);
}
/** The single notice judge. lstat precedes every bounded read; failures are warnings. */
export function tidyNotices(payload,declaration,{share=true}={}){
 const warnings=[],notices=[],contents=new Map();
 try{
  const files=new Map((Array.isArray(declaration?.files)?declaration.files:[]).map(file=>[file.path,file]));
  const payloadPaths=new Set([...files.values()].filter(file=>Object.hasOwn(file,'size')&&Object.hasOwn(file,'sha256')&&Object.hasOwn(file,'mode')).map(file=>file.path));
  for(const name of [declaration.manifestRelative,declaration.sourceRelative])if(typeof name==='string')payloadPaths.add(name);
  const candidates=new Set((Array.isArray(declaration.notices)?declaration.notices:[]).map(row=>row?.path));
  const rows=noticeRows(declaration.notices,{packageName:declaration.id});warnings.push(...rows.warnings);
  const acceptedRows=new Set(rows.notices.map(row=>row.path));
  const rejected=new Set((Array.isArray(declaration.notices)?declaration.notices:[]).filter(row=>safe(row?.path)&&!acceptedRows.has(row.path)).map(row=>row.path));
  for(const row of rows.notices){let descriptor;try{
   if(/(?:\.(?:json|jsonl|lock|pom)|(?:^|\/)(?:Android\.bp|Cargo\.lock|package-lock\.json))$/i.test(row.path))throw Error('build metadata is not a notice document');
   const filename=noticePath(payload,row.path),stat=fs.lstatSync(filename);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>NOTICE_LIMIT)throw Error('not a regular text file within the notice limit');
   descriptor=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const current=fs.fstatSync(descriptor);
   if(!current.isFile()||current.size>NOTICE_LIMIT||current.ino!==stat.ino||current.dev!==stat.dev)throw Error('candidate changed before reading');
   const bytes=Buffer.alloc(current.size);let read=0;while(read<bytes.length){const n=fs.readSync(descriptor,bytes,read,bytes.length-read,read);if(!n)break;read+=n;}
   if(bytes.subarray(0,Math.min(read,8192)).includes(0))throw Error('binary notice');
   const after=fs.fstatSync(descriptor);if(read!==current.size||after.size!==current.size||after.mtimeMs!==current.mtimeMs)throw Error('candidate changed while reading');
   contents.set(row.path,bytes);
   notices.push(row);
  }catch(error){warnings.push('Dropped notice '+row.path+': '+error.message);rejected.add(row.path);}finally{if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{}}}
  // Complete file facts record an independent payload role; path-only rows are notice candidates.
  for(const name of rejected)if(!payloadPaths.has(name)){
   try{const file=noticePath(payload,name);if(!fs.lstatSync(file).isDirectory())fs.rmSync(file,{force:true});}catch{}
   files.delete(name);
  }
  declaration.files=(declaration.files||[]).filter(file=>files.has(file.path));
  if(!notices.length){
   const name='package-notice.txt',repository=declaration.source?.repository||declaration.repository||'https://github.com/procrastinine/maclauncher-builds';
   const bytes=Buffer.from((declaration.id||'Package')+' '+(declaration.version||'')+'\n\nSource repository: '+repository+'\n');
   try{const fd=fs.openSync(noticePath(payload,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o644);try{fs.writeFileSync(fd,bytes);}finally{fs.closeSync(fd);}declaration.files=declaration.files.filter(file=>file.path!==name);notices.push({name:declaration.id||'Package',license:'See source',path:name});contents.set(name,bytes);}catch(error){warnings.push('Stand-in notice was not written: '+error.message);}
   warnings.push('No usable notices remain; package-notice.txt stands in for them.');
  }
  declaration.notices=notices;
  declaration.files=declaration.files.filter(file=>rejected.has(file.path)&&payloadPaths.has(file.path)||!isNoticePath(file.path,declaration.notices));
  if(share)try{shareNoticeText(payload,declaration,contents,payloadPaths);}catch(error){warnings.push('Kept notice text as supplied: '+error.message);}
  if(typeof declaration.manifestRelative==='string')try{
   const filename=noticePath(payload,declaration.manifestRelative),stat=fs.lstatSync(filename);
   if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=NOTICE_LIMIT){
    const manifest=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(Array.isArray(manifest.files)){
     const base=['','files/'].find(prefix=>manifest.files.every(row=>files.has(prefix+row?.path)||candidates.has(prefix+row?.path)||Object.hasOwn(declaration.aliases?.files||{},prefix+row?.path)));
     if(base!==undefined){
      const before=JSON.stringify(manifest);manifest.files=manifest.files.filter(row=>rejected.has(base+row?.path)&&payloadPaths.has(base+row?.path)||!candidates.has(base+row?.path)&&!isNoticePath(base+row?.path,declaration.notices));
      manifest.notices=notices.filter(row=>row.path.startsWith(base)).map(row=>({...row,path:row.path.slice(base.length)}));

      if(JSON.stringify(manifest)!==before){const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(filename,bytes);const row=declaration.files.find(row=>row.path===declaration.manifestRelative);if(row){row.size=bytes.length;row.sha256=declaration.manifestSha256=digest(bytes);if(declaration.sourceRelative===declaration.manifestRelative)declaration.sourceSha256=row.sha256;}}
     }
    }
   }
  }catch(error){warnings.push('Notice manifest metadata was left as supplied: '+error.message);}
 }catch(error){warnings.push('Notice intake continued: '+error.message);}
 printWarnings(warnings);return{notices:declaration?.notices||notices,warnings,entries:[...contents].filter(([name])=>(declaration?.notices||notices).some(row=>row.path===name)).map(([name,bytes])=>({path:name,bytes}))};
}
/** Identical notice files merge into one, a code file keeps only its licence comments, and lines whose text is
 * already present in an earlier notice become one line naming where it is. The manifest lists its files from the payload root or
 * from files/. Files that the manifest or source record name for another purpose, or that sit in a signed bundle, stay as built. */
function shareNoticeText(payload,declaration,contents,payloadPaths){
 const first=new Map(),moved=new Map(),documents=[];
 for(const [name,bytes]of contents){
  if(payloadPaths.has(name)||SIGNED_BUNDLE.test(name))continue;
  const hash=digest(bytes);if(first.has(hash)){moved.set(name,first.get(hash));continue;}first.set(hash,name);
  const text=bytes.toString('utf8');documents.push({path:name,text:CODE.test(name)?licenceComments(text):text});
 }
 shareRepeatedLines(documents);
 for(const document of documents){const bytes=Buffer.from(document.text);fs.writeFileSync(noticePath(payload,document.path),bytes);contents.set(document.path,bytes);}
 for(const [name,target]of moved){fs.rmSync(noticePath(payload,name),{force:true});contents.delete(name);for(const row of declaration.notices)if(row.path===name)row.path=target;}
}

/** A code file's notice is its licence comments; the rest of it is code. */
function licenceComments(text){
 const comments=[...text.matchAll(/\/\*[\s\S]*?\*\/|(?:^[ \t]*\/\/.*(?:\n|$))+/gm)].map(match=>match[0].trimEnd()).filter(comment=>/copyright|licen[cs]e|spdx/i.test(comment));
 return comments.length?comments.join('\n\n')+'\n':text;
}

/** Text compares as words: HTML character references read as their characters, and spacing, line wrapping and comment
 * markers do not matter. */
const wordsOf=line=>line.replace(/&(#34|quot|#39|apos|lt|gt|amp);/g,(_,name)=>({'#34':'"',quot:'"','#39':"'",apos:"'",lt:'<',gt:'>',amp:'&'})[name]).split(/\s+/).filter(word=>word&&!/^[/*#]+$/.test(word));

/** Store each text once: whole lines that repeat at least SHORTEST characters of whole lines kept earlier become a pointer
 * to those lines. Runs start and end on text, so blank lines around them stay. */
function shareRepeatedLines(documents){
 const starts=new Map(),boundary=(document,at)=>at===document.kept.length||document.line[at]!==document.line[at-1];
 for(const document of documents){
  const lines=document.text.split('\n'),words=[],begin=[],out=[],kept=document.kept=[],line=document.line=[],opens=new Set();
  for(const text of lines){begin.push(words.length);words.push(...wordsOf(text));}
  begin.push(words.length);
  const ends=new Set(begin),keep=(word,row)=>{
   kept.push(word);line.push(row);
   const at=kept.length-WORDS;
   if(opens.has(at)&&kept.slice(at).every(Boolean)){const key=kept.slice(at).join(' ');(starts.get(key)||starts.set(key,[]).get(key)).push({document,at});}
  };
  for(let i=0;i<lines.length;){
   const from=begin[i];let best,length=0;
   if(from<begin[i+1])for(const source of starts.get(words.slice(from,from+WORDS).join(' '))||[]){
    let n=0;while(from+n<words.length&&source.document.kept[source.at+n]===words[from+n])n++;
    while(n&&!(ends.has(from+n)&&boundary(source.document,source.at+n)))n--;
    if(n>length){best=source;length=n;}
   }
   if(length&&words.slice(from,from+length).join(' ').length>=SHORTEST){
    let next=i+1;while(begin[next]<from+length)next++;
    out.push('[Same text as lines '+(best.document.line[best.at]+1)+'-'+(best.document.line[best.at+length-1]+1)+' of '+best.document.path+']');keep(null,out.length-1);i=next;continue;
   }
   out.push(lines[i]);opens.add(kept.length);
   for(const word of words.slice(from,begin[i+1]))keep(word,out.length-1);
   i++;
  }
  document.text=out.join('\n');
 }
}

/** Project informational notice metadata without making notice IO a build gate. */
export function projectNoticeMetadata(root,project){
 const warnings=[];
 function visit(directory){try{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);if(entry.isDirectory())visit(file);else if(entry.isFile()&&entry.name.endsWith('.json')){
   try{const original=fs.readFileSync(file,'utf8'),parsed=JSON.parse(original),projected=project(parsed);if(JSON.stringify(projected)!==JSON.stringify(parsed))fs.writeFileSync(file,JSON.stringify(projected,null,2)+'\n');}catch(error){warnings.push('Notice metadata was not projected: '+error.message);}
  }
 }}catch(error){warnings.push('Notice metadata was not collected: '+error.message);}}
 visit(root);printWarnings(warnings);return{notices:[],warnings};
}
