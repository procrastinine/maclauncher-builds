import path from 'node:path';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {declaredRecipeEntries} from './recipe-build-report.mjs';

/** Read release inputs from Git objects, without checking out or executing historical code. */
export function packageChanges({directory,projects}){
 const compare=(a,b)=>a<b?-1:a>b?1:0;
 const git=(repo,args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']}).trim();
 const cache=new Map(),read=(repo,ref,file)=>{
  const key=repo+'\0'+ref+'\0'+file;if(cache.has(key))return cache.get(key);
  let value;try{value=git(repo,['show',ref+':'+file]);}catch{value=null;}cache.set(key,value);return value;
 };
 const json=(repo,ref,file)=>{const text=reference(repo,ref,file);return text===null?null:JSON.parse(text);};
 const tree=(repo,ref)=>{
  const key=repo+'\0'+ref+'\0tree';if(!cache.has(key))cache.set(key,git(repo,['ls-tree','-r',ref]).split('\n').flatMap(line=>{const match=/^(\d+) \w+ ([a-f0-9]+)\t(.+)$/.exec(line);return match?[{mode:match[1],revision:match[2],path:match[3]}]:[];}));return cache.get(key);
 };
 const reference=(repo,ref,file,depth=0)=>{
  if(depth>20)return null;
  let rows;try{rows=tree(repo,ref);}catch{return null;}
  const link=rows.find(row=>row.mode==='160000'&&file.startsWith(row.path+'/'));
  if(link)return reference(path.join(repo,link.path),link.revision,file.slice(link.path.length+1),depth+1);
  const row=rows.find(row=>row.path===file);
  if(row?.mode==='120000')return reference(repo,ref,path.posix.normalize(path.posix.join(path.posix.dirname(file),read(repo,ref,file))),depth+1);
  return read(repo,ref,file);
 };
 const snapshot=(ref,id,version)=>{
  const manifest=json(directory,ref,'projects.json');if(!manifest)throw Error('Missing project registry at '+ref);
  const registry=manifest.projects||Object.values(manifest.registries||{}).flatMap(file=>json(directory,ref,file)||[]);
  const project=registry.find(row=>row.id===id);if(!project)throw Error('Missing project '+id+' at '+ref);
  const pins=new Map(),unavailable=new Set(),seen=new Set(),paths=new Set();
  const add=(name,value)=>pins.set(name,value);
  const visit=(file,repo=directory,commit=ref,prefix='')=>{
   if(file.startsWith('app:')){
    const profile=json(directory,ref,'producers/package-support/app-source.json');
    if(!profile){unavailable.add(file);return;}
    const link=profile.gitlink||'sources/maclauncher',revision=tree(directory,ref).find(row=>row.path===link)?.revision||profile.revision;
    paths.add(link);add(link,{revision});
    return visit(file.slice(4),path.join(directory,link),revision,link+'/');
   }
   const key=prefix+file;if(seen.has(key))return;seen.add(key);
   let rows;try{rows=tree(repo,commit);}catch{unavailable.add(key);return;}
   const link=rows.find(row=>row.mode==='160000'&&(file===row.path||file.startsWith(row.path+'/')));
   if(link){
    add(prefix+link.path,{revision:link.revision});if(repo===directory)paths.add(link.path);
    if(file!==link.path)return visit(file.slice(link.path.length+1),path.join(repo,link.path),link.revision,prefix+link.path+'/');return;
   }
   if(repo===directory)paths.add(file);
   const files=rows.filter(row=>row.path===file||row.path.startsWith(file+'/'));
   if(!files.length){unavailable.add(key);return;}
   for(const row of files){
    if(row.mode==='160000'){add(prefix+row.path,{revision:row.revision});continue;}
    if(row.mode==='120000'){const target=path.posix.normalize(path.posix.join(path.posix.dirname(row.path),read(repo,commit,row.path)));if(!target.startsWith('../'))visit(target,repo,commit,prefix);else unavailable.add(prefix+row.path);continue;}
    if(!row.path.endsWith('.json'))continue;
    const value=json(repo,commit,row.path);if(value===null)continue;
    const walk=(value,pointer='')=>{
     if(!value||typeof value!=='object')return;
     if(value.gitlink){const target=rows.find(row=>row.path===value.gitlink);if(target)add(prefix+value.gitlink,{revision:target.revision});}
     if(typeof value.revision==='string'||typeof value.commit==='string'){
      const pin={};for(const field of ['repository','url','version','revision','commit'])if(value[field]!==undefined)pin[field]=value[field];add(prefix+row.path+'#'+pointer,pin);
     }
     if(typeof value.file==='string'&&typeof value.pointer==='string'){
      const candidates=[];for(let base=path.posix.dirname(row.path);;base=path.posix.dirname(base)){candidates.push(path.posix.normalize(path.posix.join(base,value.file)));if(base==='.')break;}
      const target=candidates.find(name=>rows.some(row=>row.path===name))||value.file;visit(target,repo,commit,prefix);
     }
     for(const [name,child] of Object.entries(value))walk(child,pointer+'/'+name.replaceAll('~','~0').replaceAll('/','~1'));
    };walk(value);
   }
  };
  const builds=Array.isArray(project.build)?project.build:project.build?[project.build]:[];
  const entries=[...declaredRecipeEntries(project,manifest),...builds.flatMap(build=>[...(build.submodules||[]),...(build.archives||[]).map(pin=>pin.file),...(build.locks||[]).map(lock=>lock.file)]),...project.upstreams.map(source=>source.pin?.file||source.pin?.gitlink).filter(Boolean)];
  for(const entry of entries)visit(entry);
  // Resolve scalar pointer pins as well as complete source records in the declared JSON.
  for(const source of project.upstreams||[]){
   const pin=source.pin;let value=source;
   if(pin?.gitlink){value={revision:tree(directory,ref).find(row=>row.path===pin.gitlink)?.revision};}
   else if(pin?.file){
    if(pin.file.endsWith('.json')&&!pin.file.startsWith('app:')){
     value=json(directory,ref,pin.file);if(value===null)unavailable.add(pin.file+'#'+pin.pointer);
     for(const key of (pin.pointer||'').split('/').slice(1))value=value?.[key.replaceAll('~1','/').replaceAll('~0','~')];
     if(pin.match)value=value?.find(row=>Object.entries(pin.match).every(([key,expected])=>row[key]===expected));
     if(pin.field)for(const key of pin.field.split('/').slice(1))value=value?.[key];
    }else{
     // Legacy producers export literal revision constants, object properties or
     // version/revision pairs. Read only unambiguous literals; never load their code.
     const text=reference(directory,ref,pin.file)||'',quote=name=>String(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
     const key=quote(pin.pointer.split('/').at(-1)),pattern=pin.match&&Object.keys(pin.match).join()==='version'&&pin.field==='/upstreamRevision'
      ?new RegExp('["\']'+quote(pin.match.version)+'["\']\\s*,\\s*["\']([a-f0-9]{40})["\']','g')
      :new RegExp('(?:\\b(?:const|let|var)\\s+'+key+'\\s*=|["\']'+key+'["\']\\s*:|\\b'+key+'\\s*:)\\s*["\']([a-f0-9]{40})["\']','g');
     const matches=[...new Set([...text.matchAll(pattern)].map(match=>match[1]))];
     value=matches.length===1?{revision:matches[0]}:null;
     if(!value){
      const linkPattern=new RegExp('\\b(?:const|let|var)\\s+'+key+'\\s*=\\s*gitlink\\(["\']([^"\']+)["\']\\)','g');
      const links=[...new Set([...text.matchAll(linkPattern)].map(match=>match[1]))];
      if(links.length===1){const revision=tree(directory,ref).find(row=>row.path===links[0])?.revision;if(revision)value={revision};}
     }
     if(!value)unavailable.add(pin.file+'#'+pin.pointer);
    }
   }
   if(typeof value==='string')value={revision:value};
   if(value){const result={repository:source.url||source.repository};for(const key of ['revision','commit','version'])if(value[key]!==undefined)result[key]=value[key];if(value.gitlink)result.revision=tree(directory,ref).find(row=>row.path===value.gitlink)?.revision;if(result.revision||result.commit||result.version)add('upstream:'+source.id,result);}
  }
  return {pins,paths:[...paths].sort(),notes:builds.find(row=>row?.version===version)?.notes,unavailable:[...unavailable].sort()};
 };
 const natural=(a,b)=>{const x=a.match(/\d+|\D+/g)||[],y=b.match(/\d+|\D+/g)||[];for(let i=0;i<Math.min(x.length,y.length);i++){const result=/^\d+$/.test(x[i])&&/^\d+$/.test(y[i])?compare(BigInt(x[i]),BigInt(y[i])):compare(x[i],y[i]);if(result)return result;}return compare(x.length,y.length);};
 const tags=git(directory,['tag','--list']).split('\n');
 return {schemaVersion:1,projects:[...projects].sort((a,b)=>compare(a.projectId,b.projectId)).map(project=>{
  const versions=new Map(),catalogFile=path.join(directory,'catalogs',project.projectId+'.json'),catalog=fs.existsSync(catalogFile)?JSON.parse(fs.readFileSync(catalogFile,'utf8')):null;
  for(const record of catalog?.packages||[]){if(!versions.has(record.version))versions.set(record.version,[]);}
  for(const tag of tags){const parts=tag.split('/');if(parts.length!==3||parts[0]!==project.projectId||!parts[1].startsWith('v'))continue;const version=parts[1].slice(1);if(!versions.has(version))versions.set(version,[]);versions.get(version).push(tag);}
  const releases=[...versions].map(([version,tags])=>{tags.sort();const tag=tags[0],record=catalog?.packages.find(row=>row.version===version),revision=tag?git(directory,['rev-parse',tag+'^{commit}']):record?.build?.sourceRevision||record?.source?.revision,date=git(directory,['show','-s','--format=%cI',revision]);return {version,tags,revision,date,versionSources:[...(tags.length?['tags']:[]),...(catalog?.packages.some(row=>row.version===version)?['catalog']:[])].sort()};}).sort((a,b)=>compare(a.date,b.date)||natural(a.version,b.version));
  let previous=null,prior=null;
  const entries=releases.map(release=>{
   const state=snapshot(release.revision,project.projectId,release.version),pins=[...new Set([...(prior?.pins.keys()||[]),...state.pins.keys()])].sort().flatMap(input=>{const before=prior?.pins.get(input)||null,after=state.pins.get(input)||null;return JSON.stringify(before)===JSON.stringify(after)?[]:[{input,before,after}];});
   const paths=[...new Set([...(prior?.paths||[]),...state.paths])].sort();
   const commits=previous&&paths.length?git(directory,['log','--format=%H%x09%cI%x09%s',previous.revision+'..'+release.revision,'--',...paths]).split('\n').filter(Boolean).map(line=>{const [revision,date,...subject]=line.split('\t');return {revision,date,subject:subject.join('\t')};}).sort((a,b)=>compare(a.date,b.date)||compare(a.revision,b.revision)):[];
   const entry={...release,previousVersion:previous?.version||null,pins,commits,...(state.notes?{notes:state.notes}:{}),...(state.unavailable.length?{unavailableInputs:state.unavailable}:{})};previous=release;prior=state;return entry;
  });
  return {projectId:project.projectId,releases:entries};
 })};
}
