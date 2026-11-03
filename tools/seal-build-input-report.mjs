import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {canonicalReport} from '../lib/canonical-report.mjs';
import {releaseTag} from '../lib/project-identity.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs');
const read=value=>JSON.parse(value.trim().startsWith('{')?value:fs.readFileSync(value,'utf8'));
const warn=message=>console.log('::warning::'+message);
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const SIGNED_BUNDLE=/\.(?:app|framework|bundle|appex|xpc|plugin)\//i,CODE=/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|java|kt|rs|go|js|ts|swift)(?:\.txt)?$/i;
const WORDS=8,SHORTEST=256;

/** Licence notices never fail a build. Unusable entries are dropped, a package keeps at least one notice for the
 * app's contract, and the text of its notices is stored once. */
export function tidyNotices(payload,declaration){
 const files=new Map(declaration.files.map(file=>[file.path,file])),label=[declaration.id,declaration.version,declaration.arch].join(' ');
 let notices=(Array.isArray(declaration.notices)?declaration.notices:[]).filter(notice=>{
  const usable=notice&&typeof notice.name==='string'&&notice.name.trim()&&typeof notice.license==='string'&&notice.license.trim()&&files.has(notice.path)&&
   Object.keys(notice).every(key=>['name','license','path','sourceUrl'].includes(key))&&(!notice.sourceUrl||/^https:\/\//.test(notice.sourceUrl));
  if(!usable)warn('Dropped an unusable licence notice entry from '+label+': '+JSON.stringify(notice));
  return usable;
 });
 if(!notices.length){
  const name='package-notice.txt',bytes=Buffer.from(declaration.id+' '+declaration.version+'\n\nThis package recorded no licence notice. Its source and licences are in its source repository.\n');
  if(!files.has(name)){fs.writeFileSync(path.join(payload,name),bytes,{mode:0o644});declaration.files.push({path:name,size:bytes.length,mode:0o644,sha256:digest(bytes)});}
  notices=[{name:declaration.id,license:'See source',path:name}];warn(label+' recorded no licence notice; '+name+' stands in for it.');
 }
 declaration.notices=notices;
 try{shareNoticeText(payload,declaration);}catch(error){warn('Kept licence notices of '+label+' as built: '+error.message);}
}

/** Identical notice files merge into one, a code file keeps only its licence comments, and lines whose text is
 * already present in an earlier notice become one line naming where it is. The manifest lists its files from the payload root or
 * from files/. Files that the manifest or source record name for another purpose, or that sit in a signed bundle, stay as built. */
function shareNoticeText(payload,declaration){
 const files=new Map(declaration.files.map(file=>[file.path,file])),manifestFile=path.join(payload,declaration.manifestRelative),aliases=declaration.aliases?.files||{};
 const before=fs.readFileSync(manifestFile,'utf8'),manifest=JSON.parse(before),{files:listed,notices:listedNotices,...rest}=manifest;
 const base=Array.isArray(listed)?['','files/'].find(prefix=>listed.every(row=>files.has(prefix+row?.path)||Object.hasOwn(aliases,prefix+row?.path)||Object.hasOwn(aliases,row?.path))):'';
 if(base===undefined)throw Error('its manifest lists files by another layout');
 const named=JSON.stringify(rest)+JSON.stringify(declaration.aliases||{})+(declaration.sourceRelative&&declaration.sourceRelative!==declaration.manifestRelative?fs.readFileSync(path.join(payload,declaration.sourceRelative),'utf8'):'');
 const paths=[...new Set(declaration.notices.map(notice=>notice.path))].sort().filter(name=>name.startsWith(base)&&name!==declaration.manifestRelative&&
  name!==declaration.sourceRelative&&!SIGNED_BUNDLE.test(name)&&!named.includes(JSON.stringify(name))&&!named.includes(JSON.stringify(name.slice(base.length))));
 const moved=new Map(),first=new Map(),documents=[];
 for(const name of paths){
  const sha256=files.get(name).sha256;
  if(first.has(sha256)){moved.set(name,first.get(sha256));continue;}
  first.set(sha256,name);
  const bytes=fs.readFileSync(path.join(payload,name)),text=bytes.toString('utf8');
  if(!bytes.includes(0)&&Buffer.from(text).equals(bytes))documents.push({path:name,text:CODE.test(name)?licenceComments(text):text});
 }
 shareRepeatedLines(documents);
 const rows=new Map((Array.isArray(listed)?listed:[]).map(row=>[base+row?.path,row])),written=[];
 for(const document of documents){
  const bytes=Buffer.from(document.text),sha256=digest(bytes);
  if(sha256===files.get(document.path).sha256)continue;
  written.push([document.path,bytes]);
  for(const row of [files.get(document.path),rows.get(document.path)])if(row){if('size' in row)row.size=bytes.length;if('sha256' in row)row.sha256=sha256;}
 }
 if(!moved.size&&!written.length)return;
 for(const [name,bytes] of written)fs.writeFileSync(path.join(payload,name),bytes);
 for(const name of moved.keys())fs.rmSync(path.join(payload,name));
 for(const notice of declaration.notices)if(moved.has(notice.path))notice.path=moved.get(notice.path);
 for(const notice of Array.isArray(listedNotices)?listedNotices:[])if(moved.has(base+notice?.path))notice.path=moved.get(base+notice.path).slice(base.length);
 declaration.files=declaration.files.filter(row=>!moved.has(row.path));
 if(Array.isArray(listed))manifest.files=listed.filter(row=>!moved.has(base+row.path));
 if(JSON.stringify(manifest)===JSON.stringify(JSON.parse(before)))return;
 const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),entry=files.get(declaration.manifestRelative);
 fs.writeFileSync(manifestFile,bytes);entry.size=bytes.length;entry.sha256=declaration.manifestSha256=digest(bytes);
 if(declaration.sourceRelative===declaration.manifestRelative)declaration.sourceSha256=entry.sha256;
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
/** Add generated input facts to a new build, before its archive is attested. */
export function sealBuildInputReport({project,output,environment=process.env}){
 if(!environment.BUILD_REPORTS)return;
 const report=read(environment.BUILD_REPORTS)[project];if(!report?.definition)throw Error('The build has no resolved input report: '+project);
 const payload=path.join(output,'payload'),file=path.join(output,'declaration.json'),declaration=JSON.parse(fs.readFileSync(file));B.verifyPayload(payload,declaration);
 tidyNotices(payload,declaration);
 const definition=canonicalReport(report.definition),digest=crypto.createHash('sha256').update(definition).digest('hex');
 if(digest!==report.definitionDigest)throw Error('The build definition differs from its plan.');
 const prepared=environment.MACLAUNCHER_BUILD_INPUTS?read(environment.MACLAUNCHER_BUILD_INPUTS):{};
 const inputs=Object.values(prepared).map(({record,evidence})=>({id:record.id,version:record.version,arch:record.arch,sha256:record.asset.sha256,
  release:releaseTag(record),url:record.asset.url,sourceRevision:record.build?.sourceRevision||evidence?.sourceRevision,runId:record.build?.runId||evidence?.runId}));
 for(const [name,content]of [['build-definition.json',definition],['build-inputs.json',canonicalReport({schemaVersion:1,definitionDigest:digest,inputs})]]){
  const bytes=Buffer.from(content);fs.writeFileSync(path.join(payload,name),bytes,{flag:'wx',mode:0o644});
  declaration.files.push({path:name,size:bytes.length,mode:0o644,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 }
 fs.writeFileSync(file,JSON.stringify(declaration,null,2)+'\n');B.verifyPayload(payload,declaration);
}
